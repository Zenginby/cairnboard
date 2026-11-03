import * as readline from 'node:readline';
import { main } from '../../cli/main.mjs';

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

const actor = getArg('--actor') ?? process.env.CAIRN_ACTOR ?? 'w0';
const data = getArg('--data') ?? process.env.CAIRN_DATA;
const defaultRef = getArg('--ref') ?? process.env.CAIRN_REF;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

process.stdout.write('ready\n');

for await (const rawLine of rl) {
  const line = rawLine.trim();
  if (!line) continue;
  if (line === 'stop') break;
  if (line.startsWith('go')) {
    const parts = line.split(/\s+/);
    const ref = parts[1] || defaultRef;
    let stdout = '';
    let stderr = '';
    let code = 1;
    let json = null;
    try {
      code = await main(['card', 'claim', ref, '--actor', actor, '--json', '--data', data], {
        env: { ...process.env, CAIRN_DATA: data, CAIRN_ACTOR: actor },
        cwd: process.cwd(),
        isTTY: false,
        stdin: '',
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      try { json = JSON.parse(stdout); } catch {}
    } catch (err) {
      code = 1;
      stderr = String(err?.message ?? err);
    }
    process.stdout.write(JSON.stringify({ code, actor, json, stderr }) + '\n');
  }
}
