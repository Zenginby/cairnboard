const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const INVISIBLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Controls, bidi overrides, invisible spaces, tag characters (ASCII smuggling) and line separators.
// ZWNJ/ZWJ and a single variation selector stay: emoji sequences and scripts such as Persian need them.
const HIDDEN_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
// Runs of variation selectors carry hidden payloads; a lone one after a visible character is ordinary emoji text.
const SELECTOR_RUN = /(?:^|(?<=[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]))[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}](?=[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])/gu;

// Builds alphabets from code point ranges so long literal alphabets never appear in source.
export function charRanges(...pairs) {
  return pairs.map(([start, end]) => String.fromCharCode(...Array.from({ length: end - start + 1 }, (_, i) => start + i))).join('');
}

export function foldTr(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(INVISIBLE_PATTERN, '')
    .normalize('NFKC')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

export function slugify(title) {
  if (typeof title !== 'string') title = '';
  let slug = foldTr(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 60) {
    slug = slug.slice(0, 60).replace(/-+$/g, '');
  }
  if (!slug) {
    slug = 'untitled';
  }
  if (WINDOWS_RESERVED.test(slug)) {
    slug = `${slug}-x`;
  }
  return slug;
}

export function pathKey(rel) {
  if (typeof rel !== 'string') return '';
  return rel.replace(/\\/g, '/').normalize('NFC').toLowerCase();
}

export function uniqueName(existing, slug) {
  const existingKeys = new Set(Array.from(existing, (item) => pathKey(item)));
  if (!existingKeys.has(pathKey(slug))) {
    return slug;
  }
  let index = 2;
  while (existingKeys.has(pathKey(`${slug}-${index}`))) {
    index++;
  }
  return `${slug}-${index}`;
}

export function stripHidden(s) {
  if (typeof s !== 'string') return { text: '', removed: 0 };
  let removed = 0;
  const drop = () => {
    removed++;
    return '';
  };
  const text = s.replace(HIDDEN_PATTERN, drop).replace(SELECTOR_RUN, drop);
  return { text, removed };
}

export function oneLine(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n|[\t\r\n\u0085\u2028\u2029]/g, ' ');
}
