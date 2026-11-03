import { CairnError } from './errors.mjs';

export function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new CairnError('validation', 'Invalid date.');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new CairnError('validation', 'Invalid date.');
}

export const dayOf = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.TZ ?? undefined, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

export const localDate = (ctx) => dayOf(ctx.clock.now());
