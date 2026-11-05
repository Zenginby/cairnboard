import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:([0-9]+)\/[^\s\u0000-\u001f\u007f"'<>]*$/u;
const LAUNCHER = /^open-[0-9a-f]{32}\.html$/u;
const LAUNCHER_TTL_MS = 2 * 60_000;

function loopback(url) {
  const match = typeof url === 'string' && LOOPBACK.exec(url);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new TypeError('Browser URL must use the local server address and an explicit port.');
  }
  return new URL(url);
}

/** Starts the platform's opener for a URL or a local file without a shell; failures only warn. */
function launch(target, warningText, { platform = process.platform, env = process.env, spawn = spawnProcess, stderr = process.stderr } = {}) {
  const warning = () => stderr.write(`warning: Could not open the browser; ${warningText}\n`);
  const command = platform === 'darwin' ? ['open', [target]]
    : platform === 'linux' ? ['xdg-open', [target]]
      : platform === 'win32' ? [win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', target]] : null;
  if (!command) { warning(); return; }
  try {
    const child = spawn(command[0], command[1], { shell: false, detached: true, stdio: 'ignore' });
    child.once('error', warning);
    child.once('exit', (code) => { if (code !== 0) warning(); });
    child.unref();
  } catch {
    warning();
  }
}

/** Opens a plain page of the local server. Login links go through openLogin so their token stays private. */
export function openBrowser(url, options = {}) {
  if (loopback(url).pathname === '/auth') throw new TypeError('Open login links with openLogin.');
  launch(url, `open ${url}`, options);
}

/**
 * Opens a one-time login link without putting the token on a command line, where other accounts can read it
 * (ps, /proc). The link goes into a private HTML file that redirects with a meta refresh, and the opener gets only
 * the file's path. Leftover files hold expired tokens; they are removed on the next call.
 */
export function openLogin(url, { dir, now = Date.now, ...options } = {}) {
  const { origin } = loopback(url);
  if (typeof dir !== 'string' || !dir) throw new TypeError('openLogin needs a private directory.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    if (!LAUNCHER.test(name)) continue;
    const file = join(dir, name);
    try { if (now() - statSync(file).mtimeMs > LAUNCHER_TTL_MS) unlinkSync(file); } catch { /* raced with another call */ }
  }
  const file = join(dir, `open-${randomBytes(16).toString('hex')}.html`);
  // The URL is validated above: no quotes, angle brackets or whitespace can break out of the attribute.
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<meta http-equiv="refresh" content="0;url=${url}"><title>Cairnboard</title>`
    + `<p>Opening Cairnboard… If nothing happens, run <code>cairn open</code> again.</p>\n`, { mode: 0o600, flag: 'wx' });
  launch(file, `run cairn open again, or open ${origin}/ in a signed-in browser`, options);
  return file;
}
