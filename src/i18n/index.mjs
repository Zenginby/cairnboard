import tr from './tr.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const language = 'tr';
const messages = { tr, en }[language];
export const t = (key) => messages[key] ?? key;
export const warningText = (code) => messages[`warnings.${code}`] ?? t('warnings.other');
