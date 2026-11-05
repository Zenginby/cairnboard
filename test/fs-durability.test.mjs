import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from '../core/fsx.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { addCard, releaseCard } from '../core/card.mjs';
import { create, update } from '../core/entity.mjs';
import { lockName } from '../core/lock.mjs';
import { readEvents } from '../core/events.mjs';
import { refresh } from '../core/index.mjs';
import { runCli } from './support/cli.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function setup(t) {
  const root = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return { root, home, clock };
}

test('claim race: 4 concurrent workers compete for cards over multiple rounds', { timeout: 300_000 }, async (t) => {
  const { root, home, clock } = setup(t);
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:coordinator' });
  const { entity: card } = addCard(ctx, { title: 'Acme Race' });
  const afterLeases = { ...ctx, clock: fixedClock('2100-01-01T00:00:00Z') };

  const workerScript = fileURLToPath(new URL('support/claim-worker.mjs', import.meta.url));
  const workers = [0, 1, 2, 3].map((index) => {
    const actor = `w${index}`;
    const child = spawn(process.execPath, [workerScript, '--actor', actor, '--data', ctx.root, '--ref', card.id], {
      // CAIRN_DEBUG puts the stack of an unexpected (internal) error into the worker's result, so a CI failure says why.
      env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_DEBUG: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (child.exitCode === null) {
          if (!child.stdin.destroyed && child.stdin.writable) {
            child.stdin.end('stop\n');
          }
          child.kill();
        }
      } catch {}
    };
    t.after(cleanup);

    const rl = createInterface({ input: child.stdout });
    let nextResolve = null;
    let nextReject = null;
    let failure = null;
    const queue = [];
    const fail = (error) => {
      failure ??= error;
      nextReject?.(failure);
      nextResolve = nextReject = null;
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Worker ${actor} exited: ${signal ?? code}`)));
    child.stdout.once('close', () => fail(new Error(`Worker ${actor} stdout closed`)));
    child.stdin.on('error', fail);
    t.signal.addEventListener('abort', () => {
      fail(t.signal.reason);
      cleanup();
    }, { once: true });
    rl.on('line', (line) => {
      if (nextResolve) {
        const resolve = nextResolve;
        nextResolve = nextReject = null;
        resolve(line);
      } else {
        queue.push(line);
      }
    });

    const nextLine = () => new Promise((resolve, reject) => {
      if (failure) reject(failure);
      else if (queue.length > 0) resolve(queue.shift());
      else {
        nextResolve = resolve;
        nextReject = reject;
      }
    });

    return { child, actor, nextLine, cleanup };
  });

  for (const worker of workers) {
    const readyLine = await worker.nextLine();
    assert.equal(readyLine, 'ready');
  }

  const rounds = Number(process.env.CAIRN_STRESS_ROUNDS ?? 30);
  const start = performance.now();

  for (let round = 0; round < rounds; round++) {
    // Workers' leases run on the real clock; the coordinator acts after they expired, as a released card would be.
    releaseCard(afterLeases, card.id);

    for (const worker of workers) {
      worker.child.stdin.write('go\n');
    }

    const results = await Promise.all(workers.map(async (worker) => JSON.parse(await worker.nextLine())));

    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code === 4 || result.code === 6);

    assert.equal(winners.length, 1, `Round ${round}: expected exactly one winner, got: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 3, `Round ${round}: expected 3 losers (code 4 or 6), got: ${JSON.stringify(results)}`);
    for (const loser of losers.filter((result) => result.code === 4)) {
      assert.equal(loser.json.error.code, 'claimed');
      assert.equal(loser.json.error.current.assignee, winners[0].actor);
    }

    const cardContent = fs.readFileSync(join(ctx.root, card.path), 'utf8');
    assert.ok(cardContent.includes(`assignee: ${winners[0].actor}`));
    assert.ok(cardContent.includes('column: doing'));
  }

  const elapsed = performance.now() - start;
  assert.ok(rounds > 0);

  for (const worker of workers) {
    worker.cleanup();
  }
});

test('crash injection: subprocess killed at each fault point recovers cleanly on next write', { timeout: 60_000 }, async (t) => {
  const faultPoints = ['after-check', 'before-rename', 'after-rename', 'after-event'];

  for (const point of faultPoints) {
    const { root, home, clock } = setup(t);

    const addRes = await runCli(['card', 'add', '--title', 'Initial', '--actor', 'acme'], { home, data: root });
    assert.equal(addRes.code, 0);

    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/cairn.mjs', import.meta.url)),
      'card', 'update', '@cards/initial', '--title', 'Updated', '--actor', 'acme', '--json', '--data', root], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_TEST_CRASH: point },
      stdio: 'ignore',
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const crashRes = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    if (process.platform === 'win32') {
      assert.notEqual(crashRes.code, 0);
    } else {
      assert.equal(crashRes.signal, 'SIGKILL', `Fault point: ${point}`);
    }

    assert.equal(fs.readdirSync(join(root, '.cairn/pending')).length, point === 'after-check' ? 0 : 1);
    const recoveryCtx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
    const pendingIntents = fs.readdirSync(join(root, '.cairn/pending'));
    assert.deepEqual(pendingIntents, []);

    const cardText = fs.readFileSync(join(root, 'cards/initial.md'), 'utf8');
    const updateEvents = readEvents(recoveryCtx).filter((event) => event.op === 'card.update');

    if (['after-check', 'before-rename'].includes(point)) {
      assert.ok(cardText.includes('title: Initial'));
      assert.ok(!cardText.includes('title: Updated'));
      assert.equal(updateEvents.length, 0);
    } else {
      assert.ok(cardText.includes('title: Updated'));
      assert.ok(!cardText.includes('title: Initial'));
      assert.equal(updateEvents.length, 1);
    }
  }
});

test('stale lock: dead PID lock is reclaimed and allows subsequent writes', async (t) => {
  const { root, home } = setup(t);

  await runCli(['card', 'add', '--title', 'Acme', '--actor', 'acme'], { home, data: root });

  const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = deadChild.pid;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

  const lockFileName = `${lockName('cards/acme.md')}.lock`;
  const lockFilePath = join(root, '.cairn/locks', lockFileName);

  fs.writeFileSync(lockFilePath, JSON.stringify({
    host: hostname(),
    pid: deadPid,
    instance: 'dead-instance',
    ts: new Date().toISOString(),
  }));

  const updateRes = await runCli(['card', 'update', '@cards/acme', '--title', 'StaleRecovered', '--actor', 'acme'], {
    home,
    data: root,
  });

  assert.equal(updateRes.code, 0);

  const cardText = fs.readFileSync(join(root, 'cards/acme.md'), 'utf8');
  assert.ok(cardText.includes('title: StaleRecovered'));
});

test('external writer: concurrent change before rename triggers conflict and preserves edits', (t) => {
  const { root, home, clock } = setup(t);
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
  const { entity: note } = create(ctx, 'note', { title: 'Acme' });

  ctx.faults = (point) => {
    if (point === 'before-rename') {
      fs.writeFileSync(join(ctx.root, note.path), '# External Change\nObsidian edited this note.\n');
    }
  };

  assert.throws(
    () => update(ctx, 'note', note.id, { title: 'Overwritten' }),
    (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.exit, 4);
      return true;
    }
  );

  const fileOnDisk = fs.readFileSync(join(ctx.root, note.path), 'utf8');
  assert.equal(fileOnDisk, '# External Change\nObsidian edited this note.\n');
  assert.deepEqual(fs.readdirSync(join(ctx.root, '.cairn/pending')), []);
});

test('symlink race: directory replaced with external symlink during afterCheck triggers unsafe_path', (t) => {
  const { root, home, clock } = setup(t);
  const outsideDir = tempDir(t);

  const probeLink = join(root, 'probe-symlink');
  try {
    fs.symlinkSync(outsideDir, probeLink, 'dir');
    fs.unlinkSync(probeLink);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Windows symlink permission required');
      return;
    }
    throw error;
  }

  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
  const cardsDir = join(root, 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });

  t.after(() => __setFsHooks({}));

  __setFsHooks({
    afterCheck(checkedAbs) {
      if (checkedAbs.startsWith(cardsDir)) {
        try {
          fs.rmSync(cardsDir, { recursive: true, force: true });
          fs.symlinkSync(outsideDir, cardsDir, 'dir');
        } catch (error) {
          if (error.code === 'EPERM') throw error;
        }
      }
    },
  });

  try {
    assert.throws(
      () => addCard(ctx, { title: 'SymlinkRace' }),
      (error) => {
        assert.equal(error.code, 'unsafe_path');
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  } finally {
    __setFsHooks({});
  }
});

test('rename retry: transient errors succeed on small attempts, fail cleanly when exhausted', async (t) => {
  const { root, home, clock } = setup(t);
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
  const { entity: note } = create(ctx, 'note', { title: 'Acme Note' });
  const noteAbs = join(root, note.path);

  t.after(() => __setFsHooks({}));

  let attempts = 0;
  __setFsHooks({
    rename(from, to) {
      if (to === noteAbs && ++attempts <= 3) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      fs.renameSync(from, to);
    },
  });

  update(ctx, 'note', note.id, { title: 'Updated After Retries' });
  assert.equal(attempts, 4);
  assert.ok(fs.readFileSync(noteAbs, 'utf8').includes('title: Updated After Retries'));

  attempts = 0;
  __setFsHooks({
    rename(from, to) {
      if (to === noteAbs) {
        attempts++;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      fs.renameSync(from, to);
    },
  });

  const failRes = await runCli(['note', 'update', note.id, '--title', 'ShouldFail', '--actor', 'acme', '--json'], {
    home,
    data: root,
  });

  assert.equal(failRes.code, 1);
  assert.equal(failRes.json.error.code, 'internal');
  assert.ok(attempts >= 10);

  const preservedText = fs.readFileSync(noteAbs, 'utf8');
  assert.ok(preservedText.includes('title: Updated After Retries'));
  assert.ok(!preservedText.includes('title: ShouldFail'));

  __setFsHooks({});
});

test('concurrent card add with same title produces separate unique files under directory lock', { timeout: 60_000 }, async (t) => {
  const { root, home, clock } = setup(t);
  const initCtx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
  refresh(initCtx);

  const script = `
    import { main } from './cli/main.mjs';
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => {
      let stdout = '', stderr = '';
      const code = await main([
        'card', 'add',
        '--title', 'Acme',
        '--actor', process.env.CAIRN_ACTOR,
        '--json',
        '--data', process.env.CAIRN_DATA,
      ], {
        env: process.env,
        cwd: process.cwd(),
        isTTY: false,
        stdin: '',
        stdout: { write: (t) => { stdout += t; } },
        stderr: { write: (t) => { stderr += t; } },
      });
      console.log(stdout.trim());
      process.exitCode = code;
      process.stdin.pause();
    });
  `;

  const children = ['w0', 'w1'].map((actor) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_DATA: root, CAIRN_ACTOR: actor },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (child.exitCode === null) child.kill();
      } catch {}
    };
    t.after(cleanup);

    let stdout = '', stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('ready\n')) resolve();
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (!stdout.includes('ready\n')) reject(new Error(stderr || `Child exited early: ${code}`));
      });
    });

    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Child exited with code ${code}`));
        }
      });
    }).then((output) => JSON.parse(output.trim().split('\n').at(-1)));

    return { child, ready, done, cleanup };
  });

  await Promise.all(children.map((item) => item.ready));
  for (const item of children) {
    item.child.stdin.end('go\n');
  }

  const results = await Promise.all(children.map((item) => item.done));
  assert.equal(results.length, 2);
  assert.ok(results.every((item) => item.ok));

  for (const item of children) {
    item.cleanup();
  }

  const files = fs.readdirSync(join(root, 'cards')).sort();
  assert.deepEqual(files, ['acme-2.md', 'acme.md']);

  const firstCard = fs.readFileSync(join(root, 'cards/acme.md'), 'utf8');
  const secondCard = fs.readFileSync(join(root, 'cards/acme-2.md'), 'utf8');
  assert.ok(firstCard.includes('title: Acme'));
  assert.ok(secondCard.includes('title: Acme'));
  assert.notEqual(results[0].data.id, results[1].data.id);
});
