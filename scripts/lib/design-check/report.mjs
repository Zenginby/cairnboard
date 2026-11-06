import { CHECKS } from './config.mjs';

export function printTable(report) {
  const names = [...CHECKS, ...(report.summary.some((page) => page.checks.runner) ? ['runner'] : [])];
  const table = report.summary.map(({ page, checks }) => Object.fromEntries([
    ['page', page], ...names.map((name) => [name, checks[name] ? `${checks[name].pass}/${checks[name].fail}${checks[name].warnings ? ` (${checks[name].warnings}w)` : ''}` : '-']),
  ]));
  console.log('Checks: pass/fail (w = warning findings)');
  console.table(table);
}
