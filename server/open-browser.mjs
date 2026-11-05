import { spawn as spawnProcess } from 'node:child_process';
import { win32 } from 'node:path';

export function openBrowser(url, { platform = process.platform, env = process.env, spawn = spawnProcess, stderr = process.stderr } = {}) {
  const match = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:([0-9]+)\/[^\s\u0000-\u001f\u007f]*$/u.exec(url);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new TypeError('Browser URL must use the local server address and an explicit port.');
  }
  const warning = () => stderr.write(`warning: Could not open the browser; open ${url}\n`);
  const command = platform === 'darwin' ? ['open', [url]]
    : platform === 'linux' ? ['xdg-open', [url]]
      : platform === 'win32' ? [win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]] : null;
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
