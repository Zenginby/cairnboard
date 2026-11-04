// Timestamped log into <ol id="log">, plus CSP violation capture.
const t0 = performance.now();

export function log(message) {
  const list = document.getElementById('log');
  const text = `${((performance.now() - t0) / 1000).toFixed(3)}s  ${message}`;
  if (!list) { console.log(text); return; }
  const li = document.createElement('li');
  li.textContent = text;
  list.prepend(li);
  while (list.children.length > 200) list.lastChild.remove();
}

document.addEventListener('securitypolicyviolation', (e) => {
  log(`CSP violation: violatedDirective=${e.violatedDirective} blockedURI=${e.blockedURI || '(empty)'} sample=${JSON.stringify(e.sample || '')}`);
});
