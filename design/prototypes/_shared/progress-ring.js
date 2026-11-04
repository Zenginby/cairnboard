// The project progress ring used by Home's project boxes and the Projeler list: a masked arc revealed in two halves on first
// load (the reveal animation lives in each page's CSS).
let sequence = 0;
export function svgNode(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}
export function progressRing(done, total) {
  const svg = svgNode('svg', { viewBox: '0 0 64 64', class: 'progress-ring', 'aria-hidden': 'true' });
  const id = `ring-${++sequence}`;
  const defs = svgNode('defs');
  const mask = svgNode('mask', { id, class: 'ring-mask' });
  for (const [half, clipX, revealX] of [['first', 32, 0], ['second', 0, 32]]) {
    const clip = svgNode('clipPath', { id: `${id}-${half}` });
    clip.append(svgNode('rect', { x: clipX, y: 0, width: 32, height: 64 }));
    defs.append(clip);
    const group = svgNode('g', { 'clip-path': `url(#${id}-${half})` });
    group.append(svgNode('rect', { x: revealX, y: 0, width: 32, height: 64, class: `ring-reveal ring-reveal--${half}` }));
    mask.append(group);
  }
  defs.append(mask);
  const arc = svgNode('g', { mask: `url(#${id})` });
  arc.append(svgNode('circle', { cx: 32, cy: 32, r: 26, pathLength: 100, class: 'ring-arc' }));
  svg.append(defs, svgNode('circle', { cx: 32, cy: 32, r: 26, class: 'ring-track' }), arc);
  svg.style.setProperty('--ring-progress', String(total ? done / total * 100 : 0));
  return svg;
}
