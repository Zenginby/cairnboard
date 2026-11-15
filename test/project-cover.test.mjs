import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { createApp } from '../server/app.mjs';
import { guard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const root = fileURLToPath(new URL('../', import.meta.url));

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
  return { status: res.statusCode, headers: res.getHeaders(), body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

function createSampleStore(t) {
  const dataDir = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-12T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(dataDir, path)), { recursive: true });
    const yaml = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    writeFileSync(join(dataDir, path), `---\n${yaml}\n---\n${body}`);
  };
  const open = () => openContext({ mode: 'read', dataDir, home, env: {}, clock });
  return { put, open };
}

test('built Project cover renders open work details, recent jobs and safe body links from sample data', async (t) => {
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { put, open } = createSampleStore(t);
  const mark = (id) => `<!-- cairn:project ${id} -->`;

  put('projects/atlas.md', { id: 'p-000001', title: 'Atlas', tone: 2 }, [
    'Project summary.',
    '',
    '- [Design spec](https://docs.example.com/atlas)',
    '- [Local health](http://localhost:8080/health)',
    '- [Vault note](obsidian://open?vault=Atlas&file=Overview)',
    '- [Design spec duplicate](https://docs.example.com/atlas)',
    '- [Click trap](javascript:alert(1))',
    '- [Data trap](data:text/html,<script>alert(1)</script>)',
  ].join('\n'));
  put('projects/plain.md', { id: 'p-000002', title: 'Plain project', tone: 5 }, 'No external links or jobs.');

  put('cards/a-urgent.md', { id: 'c-000001', title: 'Fix index lock', column: 'doing', priority: 'urgent',
    project: 'p-000001', now: 'Verifying retry behavior under load', next: 'Ship the retry fix',
    needs: 'Approve the <b>rollout</b> window' });
  put('cards/b-other.md', { id: 'c-000002', title: 'Document CLI flags', column: 'planned',
    project: 'p-000001', now: '' });
  put('cards/c-low.md', { id: 'c-000003', title: 'Tidy old fixture', column: 'planned', priority: 'low',
    project: 'p-000001', now: 'Should be hidden' });
  put('cards/d-done.md', { id: 'c-000004', title: 'Initial setup', column: 'done', project: 'p-000001' });

  put('cards/p2-other.md', { id: 'c-000005', title: 'Only other task', column: 'planned',
    project: 'p-000002', now: 'Drafting outline' });

  // 10 linked jobs across 9 days; newest 8 must appear, newest day first, later-in-file first within a day.
  for (let day = 1; day <= 9; day++) {
    const date = `2026-11-0${day}`;
    const body = day === 9
      ? `## Day 9 morning · laptop\n\n${mark('p-000001')}\n\n- A\n\n`
        + `## Day 9 evening · desk\n\n${mark('p-000001')}\n\n- B\n`
      : `## Day ${day} job · bench\n\n${mark('p-000001')}\n\n- Entry\n\n## Unrelated\n\n- Skip\n`;
    put(`journal/${date}.md`, { date }, body);
  }

  const pool = createRenderPool();
  t.after(() => pool.close());
  const { handler } = await import('../dist/app/server/entry.mjs');
  const app = createApp({ root, guard, handler, locals: { cairn: createRead({ open, render: pool.render }) } });

  const full = await inProcess(app, '/projects/p-000001');
  assert.equal(full.status, 200);
  const html = full.body;

  // Open work: 2 non-low open, 1/4 done, 1 low hidden, board link filtered to project.
  assert.match(html, /2 açık · 1\/4 bitti/u);
  assert.match(html, /1 düşük öncelikli gizli/u);
  assert.match(html, /href="\/board\?project=p-000001"[^>]*>Panoda gör<\/a>/u);
  assert.match(html, /class="row-detail">Verifying retry behavior under load<\/p>/u);
  // Next and Needs follow the Now line as labelled rows; a card without them gets no list.
  assert.match(html, /<dt>Sonra<\/dt><dd>Ship the retry fix<\/dd>/u);
  assert.match(html, /<dt>Senden<\/dt><dd>Approve the &lt;b&gt;rollout&lt;\/b&gt; window<\/dd>/u);
  assert.doesNotMatch(html, /<dt>Şimdi<\/dt>/u);
  assert.equal((html.match(/class="status-lines"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /Tidy old fixture/u);
  assert.doesNotMatch(html, /Should be hidden/u);
  // Both Urgent and Other exist, so headings are shown.
  assert.match(html, /id="group-urgent"[^>]*>Acil/u);
  assert.match(html, /id="group-other"[^>]*>Diğer/u);

  // Recent jobs: total 10, at most 8 shown, newest first, linking to /journal/<YYYY-MM-DD> with badge.
  const jobsSection = html.slice(
    html.indexOf('class="panel project-jobs"'),
    html.indexOf('class="panel project-notes"'),
  );
  assert.match(jobsSection, /class="panel-count">10<\/span>/u);
  assert.equal((jobsSection.match(/href="\/journal\/\d{4}-\d{2}-\d{2}"/gu) ?? []).length, 8);
  assert.ok(jobsSection.indexOf('Day 9 evening') < jobsSection.indexOf('Day 9 morning'));
  assert.ok(jobsSection.indexOf('Day 9 morning') < jobsSection.indexOf('Day 8 job'));
  assert.doesNotMatch(jobsSection, /Day 1 job/u);
  assert.match(jobsSection, /href="\/journal\/2026-11-09"[^>]*>Day 9 evening<\/a>/u);
  assert.match(jobsSection, /<time datetime="2026-11-09">9 Kasım 2026<\/time>/u);
  assert.match(jobsSection, /<span class="chip">desk<\/span>/u);

  // Links panel: order, deduplicated, host hint, allowed schemes only, rel on external links.
  const linksSection = html.slice(html.indexOf('class="panel project-links"'));
  assert.match(linksSection, /<span class="panel-count">3<\/span>/u);
  assert.match(linksSection, /href="https:\/\/docs\.example\.com\/atlas" rel="noreferrer noopener">Design spec<\/a>/u);
  assert.match(linksSection, /<p class="row-meta">docs\.example\.com<\/p>/u);
  assert.match(linksSection, /href="http:\/\/localhost:8080\/health" rel="noreferrer noopener">Local health<\/a>/u);
  assert.match(linksSection, /href="obsidian:\/\/open\?vault=Atlas&amp;file=Overview">Vault note<\/a>/u);
  assert.doesNotMatch(linksSection, /Design spec duplicate/u);
  assert.ok(linksSection.indexOf('Design spec') < linksSection.indexOf('Local health'));
  assert.ok(linksSection.indexOf('Local health') < linksSection.indexOf('Vault note'));
  // javascript: and data: links must never appear as anchors anywhere on the page.
  assert.doesNotMatch(html, /href\s*=\s*["']\s*(?:javascript|data):/iu);

  // Card page: all three status lines under the heading, in Now, Next, Needs order.
  const card = await inProcess(app, '/cards/c-000001');
  assert.equal(card.status, 200);
  const heading = card.body.slice(card.body.indexOf('class="document-heading"'),
    card.body.indexOf('class="document-body'));
  assert.match(heading, /<dt>Şimdi<\/dt><dd>Verifying retry behavior under load<\/dd>/u);
  assert.match(heading, /<dt>Sonra<\/dt><dd>Ship the retry fix<\/dd>/u);
  assert.match(heading, /<dt>Senden<\/dt><dd>Approve the &lt;b&gt;rollout&lt;\/b&gt; window<\/dd>/u);
  assert.ok(heading.indexOf('<dt>Şimdi') < heading.indexOf('<dt>Sonra'));
  assert.ok(heading.indexOf('<dt>Sonra') < heading.indexOf('<dt>Senden'));
  const bare = await inProcess(app, '/cards/c-000004');
  assert.equal(bare.status, 200);
  assert.doesNotMatch(bare.body, /class="status-lines"/u);

  // Second project: only Other has cards -> heading hidden; 0 low -> count omitted;
  // no jobs -> empty state; no links -> panel hidden.
  const plain = await inProcess(app, '/projects/p-000002');
  assert.equal(plain.status, 200);
  const plainHtml = plain.body;
  assert.match(plainHtml, /1 açık · 0\/1 bitti/u);
  assert.doesNotMatch(plainHtml, /düşük öncelikli gizli/u);
  assert.match(plainHtml, /Only other task/u);
  assert.match(plainHtml, /Drafting outline/u);
  assert.doesNotMatch(plainHtml, /id="group-other"/u);
  assert.match(plainHtml, /Bu projeye bağlı günlük işi yok/u);
  assert.doesNotMatch(plainHtml, /class="panel project-links"/u);
});
