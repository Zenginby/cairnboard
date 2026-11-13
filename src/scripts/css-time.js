/**
 * A CSS time value in milliseconds. A custom property keeps the text the stylesheet has, and the build's minifier
 * rewrites `800ms` to `.8s`, so both units must be read. Anything else is 0.
 */
export function cssTimeMs(value) {
  const match = /^([0-9]*\.?[0-9]+)(ms|s)$/iu.exec(String(value ?? '').trim());
  if (!match) return 0;
  return Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
}
