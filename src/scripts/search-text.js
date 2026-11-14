// Shared by the client-side list filters: trims and lower-cases with the page locale, so a Turkish "İ" matches "i".
/**
 * @param {unknown} value
 * @param {string} [locale]
 */
export function normalizeSearch(value, locale = 'tr') {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/İ/gu, 'i').toLocaleLowerCase(locale).replace(/̇/gu, '');
}
