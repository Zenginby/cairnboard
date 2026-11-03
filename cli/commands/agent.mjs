import { platform } from 'node:os';
import { checkAgents, cliInvocation, prepareInstall, packageVersion, renderAgentsMd, repoRoot } from '../../core/agent.mjs';

export function agentCommands(commands) {
  const home = (io) => io.env.HOME ?? io.env.USERPROFILE;
  return [
    { name: 'agent install', summary: 'Install agent skills with confirmation.', args: [],
      options: { target: { type: 'string', multiple: true, summary: 'Select claude, agents or antigravity-cli; repeat as needed.' } },
      mode: 'write', actor: false, needsData: false, dangerous: true,
      prepare: (args, opts, io) => prepareInstall({ home: home(io), commands, targets: opts.target, stderr: io.stderr }),
      run: (ctx, args, opts, io, plan) => {
        if (!opts['dry-run']) plan.apply();
        return { data: plan.data };
      } },
    { name: 'agent check', summary: 'Check installed agent skill versions and CLI paths.', args: [], options: {},
      mode: 'read', needsData: false, dangerous: false,
      run: (ctx, args, opts, io) => ({ data: checkAgents({ home: home(io) }) }) },
    { name: 'agent print', summary: 'Print a short AGENTS.md fragment.', args: [], options: {},
      mode: 'read', needsData: false, dangerous: false,
      run: () => ({ data: renderAgentsMd({ version: packageVersion, invocation: cliInvocation(repoRoot, platform()), commands }) }) },
  ];
}
