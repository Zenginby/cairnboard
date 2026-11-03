import { CairnError } from './errors.mjs';
import { extract } from './extract.mjs';
import { parseLinks } from './links.mjs';
import { resolver, withIndex } from './index.mjs';
import { clip } from './lint-checks.mjs';
import { empty, filenameOk, hasSourcesSection, missingRequired, ruleSeverity, turkish } from './rules.mjs';

// The page-level half of wiki spec §10. It reads the index, so unlike `rules.mjs` (which config validation imports
// before the runtime check) it must only be loaded after SQLite is known to be available.

// Names the page's links cannot reach, resolved against the current index (plus the page itself); the index is the
// only source, so an unusable cache is an error unless the caller can live without the rule.
const MAX_LINK_FINDINGS = 100;

function brokenLinks(ctx, path, text, lenient, found) {
  const links = parseLinks(text);
  if (!links.length) return [];
  let targets;
  try {
    targets = withIndex(ctx, (db) => db.prepare('SELECT path FROM targets').all().map((row) => row.path));
  } catch (error) {
    // Only a `warn` links rule may be skipped; an `error` rule fails closed with `index_unavailable` (exit 1).
    if (!lenient || error.code !== 'index_unavailable') throw error;
    found.skipped = true;
    return [];
  }
  const resolve = resolver([...new Set([...targets, path])]);
  return links.filter((link) => resolve(link.targetName).status === 'unresolved');
}

/**
 * Wiki spec §10 over one page's text, as it will be (or is) written at `path`: `{ errors, warnings }` of
 * `{ rule, detail, line?, content? }`, split by `config.rules` severities (`off` rules are skipped). Text that
 * echoes page content lands under `content`. `lenient` skips the links rule instead of failing when the index
 * cache is unusable (write paths); the skip is reported as a `links_skipped` warning.
 */
export function checkPage(ctx, { path, text, lenient = false }) {
  const errors = [];
  const warnings = [];
  const add = (rule, item) => {
    const severity = ruleSeverity(ctx, rule);
    if (severity === 'error') errors.push({ rule, ...item });
    else if (severity === 'warn') warnings.push({ rule, ...item });
  };
  const page = extract(ctx.schema, path, text);
  if (!page) return { errors, warnings };
  if (!page.error) {
    const missing = missingRequired(ctx.schema, page);
    if (missing.length && ruleSeverity(ctx, 'required') !== 'off') {
      for (const field of missing) add('required', { detail: `Missing field: ${field}.`, field });
    }
  }
  const sourced = !['concept', 'tool', 'query'].includes(page.kind) || page.type !== 'note' || page.error
    || !empty(page.data.sources) || hasSourcesSection(page.body);
  if (!sourced) add('sources', { detail: `Add a sources field or a ${turkish(ctx) ? '## Kaynaklar' : '## Sources'} section.` });
  if (page.type !== 'card' && !filenameOk(path)) add('filename', { detail: 'File name must be lowercase letters, digits and hyphens.' });
  if (ruleSeverity(ctx, 'links') !== 'off') {
    const found = { skipped: false };
    const broken = brokenLinks(ctx, path, text, lenient && ruleSeverity(ctx, 'links') === 'warn', found);
    for (const link of broken.slice(0, MAX_LINK_FINDINGS)) {
      add('links', { detail: 'Link target not found.', line: link.line, content: { target: clip(link.targetName) } });
    }
    if (broken.length > MAX_LINK_FINDINGS) warnings.push({ rule: 'links_truncated', detail: `Only the first ${MAX_LINK_FINDINGS} broken links are listed.` });
    if (found.skipped) warnings.push({ rule: 'links_skipped', detail: 'Links were not checked: the index is unavailable.' });
  }
  return { errors, warnings };
}

/** Throws `validation` (exit 5, nothing written) when `errors` is not empty. */
export function assertRules(errors) {
  if (errors.length) throw new CairnError('validation', `Page rules failed: ${[...new Set(errors.map((item) => item.rule))].join(', ')}.`, { rules: errors });
}

export const ruleWarnings = (warnings) => warnings.map((item) => `rule:${item.rule}`);
