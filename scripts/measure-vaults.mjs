import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Run after npm run build:app. JSON goes to stdout; no report is written into the vaults.
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'test/fixtures/vaults');
const samples = {
  plain: ['notes/Hub.md', 'wiki/Guide.md'],
  daily: ['Start.md', 'Archive/Old.md'],
  tagged: ['wiki/Workshop.md', 'wiki/Companion.md'],
};
const commands = [
  ['project', 'list'], ['note', 'list'], ['card', 'list'], ['journal', 'list'], ['search', 'lantern'],
  ['wiki', 'index'], ['wiki', 'lint'], ['context'], ['status'], ['board'],
];

function snapshot(directory, metadata = false, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (!metadata && !prefix && entry.name === '.cairn') continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(directory, metadata, `${path}/`));
    else if (entry.isFile()) {
      const absolute = join(directory, path);
      files[path] = { mtimeMs: statSync(absolute).mtimeMs,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
    } else throw new Error(`Unexpected fixture entry: ${path}`);
  }
  return files;
}

function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((path) => {
    if (JSON.stringify(before[path]) === JSON.stringify(after[path])) return [];
    return [{ path, change: !before[path] ? 'created' : !after[path] ? 'deleted' : 'modified',
      contentChanged: before[path]?.sha256 !== after[path]?.sha256,
      mtimeChanged: before[path]?.mtimeMs !== after[path]?.mtimeMs }];
  });
}

// Counts are entities, findings, or context sections; never board columns or envelope keys.
function count(data) {
  if (!data) return 0;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.findings)) return data.findings.length;
  if (Array.isArray(data.sections)) return data.sections.length;
  if (Array.isArray(data.columns)) return data.columns.reduce((sum, column) => sum + column.cards.length, 0);
  if (data.counts) return data.counts.projects + data.counts.notes + data.counts.research
    + Object.values(data.counts.cards).reduce((sum, value) => sum + value, 0);
  if (data.recentNotes) return new Set(homeItems(data).map((item) => item.path)).size;
  return data.type ? 1 : 0;
}

function homeItems(data) {
  return [...data.pinned, ...data.recentNotes, ...data.openCards, ...data.projects,
    ...(data.journal ? [data.journal] : [])];
}

function diagnostics(envelope) {
  return [...new Set([...(envelope?.warnings ?? []), ...(envelope?.data?.warnings ?? []),
    ...(envelope?.data?.findings ?? []).map((item) => `${item.severity}:${item.code}:${item.path}`)])];
}

// Same socket-free request/response technique as test/server-app.test.mjs.
async function inProcess(app, path) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:4321' };
  let output = '';
  const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

async function measure(scratch) {
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    throw new Error('Astro output missing; run npm run build:app first.');
  }
  const { openContext } = await import('../core/context.mjs');
  const { rows, outlinks } = await import('../core/index.mjs');
  const { fixedClock } = await import('../core/clock.mjs');
  const { createRead } = await import('../server/read.mjs');
  const { createApp } = await import('../server/app.mjs');
  const { guard } = await import('../server/guard.mjs');
  const { createRenderPool } = await import('../server/render-pool.mjs');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const clock = fixedClock('2026-11-07T12:00:00Z');
  const report = { search: 'lantern', renderClock: clock.now().toISOString(), runs: [] };
  for (const [vault, paths] of Object.entries(samples)) {
    for (const preset of ['default', 'tr-wiki']) {
      const directory = join(scratch, vault, preset);
      const data = join(directory, 'data');
      cpSync(join(fixtures, vault), data, { recursive: true });
      const baseline = snapshot(data);
      const run = { vault, preset, steps: [] };
      report.runs.push(run);
      const env = { ...process.env, CAIRN_DATA: data, CAIRN_TEST_CRASH: '', CAIRN_DEBUG: '' };
      function cli(args) {
        const before = snapshot(data);
        const child = spawnSync(process.execPath,
          [join(root, 'cli/cairn.mjs'), ...args, '--data', data, '--preset', preset, '--json'],
          { cwd: directory, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        let envelope;
        try { envelope = JSON.parse(child.stdout); } catch { /* Preserve invalid output as an error below. */ }
        const step = { command: args.join(' '), exit: child.status, signal: child.signal,
          count: envelope?.ok ? count(envelope.data) : 0, warnings: diagnostics(envelope),
          error: child.error?.message ?? envelope?.error ?? (!envelope ? 'Invalid JSON output' : null),
          stderr: child.stderr, ...(envelope ? { response: envelope } : { stdout: child.stdout }),
          outsideMetadataChanges: changes(before, snapshot(data)) };
        run.steps.push(step);
        return envelope;
      }
      for (const command of commands) cli(command);
      // Both presets support ephemeral reads; init is only necessary if that contract fails.
      const needsInit = run.steps.some((step) => step.response?.error?.message === 'Initialization is required.');
      run.initialization = needsInit ? 'required; retried after init' : 'not required; ephemeral reads';
      if (needsInit) {
        cli(['init']);
        for (const command of commands) cli(command);
      }
      for (const path of paths) cli(['note', 'show', `@${path}`]);

      const open = () => openContext({ mode: 'read', dataDir: data, preset, home: env.HOME, env, clock });
      const ctx = open();
      const indexed = rows(ctx);
      run.indexed = indexed.map(({ path, type, kind, id, title, data: fields }) =>
        ({ path, type, kind, id, title, fields }));
      run.links = indexed.flatMap((row) => outlinks(ctx, row.path).map((link) => ({ source: row.path, ...link })));
      run.notIndexed = Object.keys(baseline).filter((path) => !indexed.some((row) => row.path === path));
      const pool = createRenderPool();
      try {
        const reader = createRead({ open, render: pool.render });
        for (const source of [null, ...paths]) {
          const before = snapshot(data);
          let envelope, readerError;
          const selected = indexed.find((row) => row.path === source);
          // Use real IDs when present; otherwise try the CLI's path reference, without inventing an ID.
          const selector = selected?.id ?? `@${source}`;
          const route = source ? `/notes/${encodeURIComponent(selector)}` : '/';
          const method = source ? 'note' : 'home';
          const cairn = { [method]: async (...args) => {
            try { envelope = await reader[method](...args); return envelope; } catch (error) {
              readerError = { code: error.code, message: error.message };
              throw error;
            }
          } };
          const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), route);
          const items = envelope?.data?.recentNotes ? homeItems(envelope.data) : envelope ? [envelope.data] : [];
          // Check actual rendered titles, and deduplicate items shown in multiple Home sections.
          const visible = items.filter((item) => response.body.includes(escapeHtml(item.content.title)));
          run.steps.push({ screen: source ? `Note: ${source}` : 'Home', route,
            exit: null, httpStatus: response.status,
            count: new Set(visible.map((item) => item.path)).size,
            visiblePaths: [...new Set(visible.map((item) => item.path))],
            warnings: diagnostics(envelope), error: readerError ?? null,
            documentRendered: response.body.includes('class="document-body"'),
            noteLinks: [...response.body.matchAll(/href="(\/notes\/[^"\s]+)"/gu)].map((match) => match[1]),
            outsideMetadataChanges: changes(before, snapshot(data)) });
        }
      } finally { pool.close(); }
      run.outsideMetadataChanges = changes(baseline, snapshot(data));
      run.metadataCreated = existsSync(join(data, '.cairn'));
    }
  }
  return report;
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'measure-vaults-')));
const savedEnv = { ...process.env };
const original = snapshot(fixtures, true);
try {
  const home = join(scratch, 'home');
  mkdirSync(home);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'),
    LOCALAPPDATA: join(home, 'localappdata'), NODE_COMPILE_CACHE: join(scratch, 'compile-cache'),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch });
  // Redirect inherited and standard XDG locations, including less common XDG_* variables.
  for (const key of new Set([...Object.keys(process.env).filter((key) => key.startsWith('XDG_')),
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'])) {
    process.env[key] = join(home, key.toLowerCase());
  }
  const report = await measure(scratch);
  report.fixtureChanges = changes(original, snapshot(fixtures, true));
  // Keep output portable: temporary paths carry no useful evidence and vary between runs.
  process.stdout.write(JSON.stringify(report, null, 2).replaceAll(scratch, '<temporary>') + '\n');
  if (report.fixtureChanges.length || report.runs.some((run) => run.outsideMetadataChanges.length)) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true });
}
