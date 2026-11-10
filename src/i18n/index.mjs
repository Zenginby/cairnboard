import tr from './tr.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const language = 'tr';
const messages = { tr, en }[language];
// `{name}` placeholders are filled from `values`; a placeholder without a value stays as written.
export const t = (key, values = {}) => (messages[key] ?? key)
  .replace(/\{(\w+)\}/gu, (whole, name) => (Object.hasOwn(values ?? {}, name) ? String(values[name]) : whole));
export const warningText = (code) => messages[`warnings.${code}`] ?? t('warnings.other');
