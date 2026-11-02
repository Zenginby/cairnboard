const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const INVISIBLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const HIDDEN_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

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
  const text = s.replace(HIDDEN_PATTERN, () => {
    removed++;
    return '';
  });
  return { text, removed };
}

export function oneLine(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n|[\t\r\n]/g, ' ');
}
