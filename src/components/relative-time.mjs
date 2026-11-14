// Short "how long ago" text for card footers ("2 sa. önce", "dün"). The page re-renders on every visit and live
// update, so a server-side value is fresh enough; the full date goes in the <time> element's title.
const STEPS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * @param {string | undefined | null} iso
 * @param {{ now?: number, locale?: string }} [options]
 * @returns {{ iso: string, text: string, full: string } | null}
 */
export function relativeTime(iso, { now = Date.now(), locale = 'tr' } = {}) {
  if (typeof iso !== 'string') return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  let text = format.format(0, 'second');
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) {
      text = format.format(Math.trunc(seconds / size), unit);
      break;
    }
  }
  const full = new Date(time).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-GB',
    { dateStyle: 'long', timeStyle: 'short' });
  return { iso, text, full };
}
