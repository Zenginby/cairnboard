import tr from './tr.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

const dictionaries = { tr, en };
// The interface follows the data folder's `language`; the server sets it once at start (useLanguage) and both its
// own modules and the built app read it from the process environment. Anything else falls back to Turkish.
export const uiLanguage = () => (process.env.CAIRN_LANGUAGE === 'en' ? 'en' : 'tr');
export const useLanguage = (language) => { process.env.CAIRN_LANGUAGE = language === 'en' ? 'en' : 'tr'; };
// `{name}` placeholders are filled from `values`; a placeholder without a value stays as written.
export const t = (key, values = {}) => (dictionaries[uiLanguage()][key] ?? key)
  .replace(/\{(\w+)\}/gu, (whole, name) => (Object.hasOwn(values ?? {}, name) ? String(values[name]) : whole));
export const warningText = (code) => dictionaries[uiLanguage()][`warnings.${code}`] ?? t('warnings.other');
