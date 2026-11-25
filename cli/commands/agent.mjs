import { platform } from 'node:os';
import { resolve } from 'node:path';
import {
  checkAgents, cliInvocation, hookStatus, prepareHook, prepareInstall, packageVersion,
  renderAgentsMd, repoRoot, requireStableAgentRoot,
} from '../../core/agent.mjs';
import { readConfiguredFeatures } from './config.mjs';

export function agentCommands(commands) {
  const home = (io) => io.env.HOME ?? io.env.USERPROFILE;
  // The write hook is optional: absent is fine, present but pointing elsewhere or unreadable is not.
  const hookEntry = (io) => {
    const invocation = cliInvocation(resolve(repoRoot));
    try {
      const status = hookStatus({ home: home(io), invocation, env: io.env });
      return { target: 'claude-hook', ...status, ok: !status.installed || status.current };
    } catch {
      return { target: 'claude-hook', installed: false, current: false, ok: false };
    }
  };
  return [
    { name: 'agent install', summary: 'Install agent skills with confirmation.', args: [],
      options: { target: { type: 'string', multiple: true, summary: 'Select claude, agents or antigravity-cli; repeat as needed.' },
        hooks: { type: 'boolean', summary: 'Also add the Claude Code wiki write hook to its user settings.' } },
      mode: 'write', actor: false, needsData: false, dangerous: true,
      prepare: (args, opts, io) => {
        const plan = prepareInstall({
          home: home(io), commands, targets: opts.target, stderr: io.stderr,
          features: readConfiguredFeatures(opts, io),
        });
        if (!opts.hooks) return plan;
        const hook = prepareHook({ home: home(io), invocation: cliInvocation(resolve(repoRoot)), io });
        return { data: [...plan.data, hook.data], apply: () => { plan.apply(); hook.apply(); } };
      },
      run: (ctx, args, opts, io, plan) => {
        if (!opts['dry-run']) plan.apply();
        return { data: plan.data };
      } },
    { name: 'agent check', summary: 'Check installed agent skill versions and CLI paths.', args: [], options: {},
      mode: 'read', needsData: false, dangerous: false,
      run: (ctx, args, opts, io) => {
        requireStableAgentRoot();
        return { data: [...checkAgents({ home: home(io) }), hookEntry(io)] };
      } },
    { name: 'agent print', summary: 'Print a short AGENTS.md fragment.', args: [], options: {},
      mode: 'read', needsData: false, dangerous: false,
      run: () => {
        requireStableAgentRoot();
        const invocation = cliInvocation(repoRoot, platform());
        return { data: renderAgentsMd({ version: packageVersion, invocation, commands }) };
      } },
  ];
}
