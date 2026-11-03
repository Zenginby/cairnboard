import * as module from 'node:module';

module.enableCompileCache?.();
const { main } = await import('./main.mjs');
process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  env: process.env, cwd: process.cwd(), isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
});
