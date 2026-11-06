// Known axe findings the owner has accepted. An entry hides one rule only for nodes inside `within`; the same rule
// anywhere else still fails the check.
export const APP_ALLOWLIST = Object.freeze([
  // A `#` heading inside a note or card body breaks the page heading order. Not fixed here: heading shift, B2.
  Object.freeze({ rule: 'heading-order', within: '.document-body', reason: 'heading shift, B2' }),
]);

/**
 * Drops allowlisted nodes from axe violations. `violations` are `{ id, impact, nodes: [{ within: string[] }] }`, where
 * `within` lists the allowlist regions that contain the node. Returns `{ id, impact, targets }` for what is left.
 */
export function filterAllowed(violations, allowlist = []) {
  return violations.map(({ id, impact, nodes }) => ({
    id, impact,
    targets: nodes.filter((node) => !allowlist.some((item) => item.rule === id && node.within.includes(item.within))).length,
  })).filter(({ targets }) => targets > 0);
}
