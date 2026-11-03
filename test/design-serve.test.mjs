import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesignServer } from '../scripts/design-serve.mjs';

// Invoke the actual HTTP request listener without requiring permission to bind a socket.
function get(server, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const headers = {};
    const response = {
      status: 200,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, values = {}) {
        this.status = status;
        Object.entries(values).forEach(([name, value]) => this.setHeader(name, value));
        return this;
      },
      end(body) { resolve({ status: this.status, headers, body: body?.toString() || '' }); },
    };
    server.listeners('request')[0]({ url, method }, response).catch(reject);
  });
}

test('design server confines files to design and src/styles and rejects symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'design-serve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'design/prototypes/_styleguide'), { recursive: true });
  await mkdir(join(root, 'src/styles'), { recursive: true });
  await writeFile(join(root, 'design/prototypes/_styleguide/index.html'), '<p>guide</p>');
  await writeFile(join(root, 'src/styles/tokens.css'), ':root {}');
  await writeFile(join(root, 'private.txt'), 'private');
  await writeFile(join(root, 'src/private.txt'), 'private');
  await symlink(join(root, 'private.txt'), join(root, 'design/leak.txt'));
  await symlink(join(root, 'src'), join(root, 'design/linked'));
  const server = createDesignServer(root);
  const guide = await get(server, '/prototypes/_styleguide/');
  assert.equal(guide.status, 200);
  assert.equal(guide.body, '<p>guide</p>');
  assert.equal(guide.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(guide.headers['cache-control'], 'no-store');
  const tokens = await get(server, '/src/styles/tokens.css');
  assert.equal(tokens.status, 200);
  assert.equal(tokens.headers['content-type'], 'text/css; charset=utf-8');
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/prototypes/%2e%2e/%2e%2e/private.txt', '/src/private.txt', '/leak.txt', '/linked/private.txt', '/%5c..%5cprivate.txt', '/%00', '/.git/config']) {
    const response = await get(server, path);
    assert.equal(response.status, 403, path);
    assert.ok(!response.body.includes('private'), path);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await get(server, '/bad%')).status, 400);
  assert.equal((await get(server, '/missing')).status, 404);
  assert.equal((await get(server, '/prototypes/_styleguide')).headers.location, '/prototypes/_styleguide/');
  assert.equal((await get(server, '/src/styles/tokens.css', 'HEAD')).body, '');
  assert.equal((await get(server, '/prototypes/', 'POST')).status, 405);
  await rm(join(root, 'src'), { recursive: true });
  await symlink(join(root, 'design'), join(root, 'src'));
  assert.equal((await get(server, '/src/styles/tokens.css')).status, 403);
});
