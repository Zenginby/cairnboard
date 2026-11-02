const INVISIBLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const BOUNDARY_PATTERN = /(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu;
const percentRun = /(?:%[0-9A-Fa-f]{2})+/g;
// \uXXXX (a surrogate pair as one), \u{X…} (leading zeros allowed, as in JavaScript), \xXX, three-digit octal,
// numeric and a few named HTML references (HTML also accepts the uppercase forms). Every alternative is a fixed
// prefix followed by bounded character classes, so matching never backtracks far.
const escapeRun = /\\u([dD][89abAB][0-9A-Fa-f]{2})\\u([dD][c-fC-F][0-9A-Fa-f]{2})|\\u\{0*([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([0-3][0-7]{2})|&#[xX]([0-9A-Fa-f]+);?|&#(\d+);?|&(amp|lt|gt|quot|apos|nbsp|AMP|LT|GT|QUOT);/g;
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };

function decodeEscapes(text) {
  return text.replace(escapeRun, (escape, high, low, braced, four, byte, octal, hex, decimal, name) => {
    if (name) return entities[name.toLowerCase()];
    if (high) return String.fromCharCode(parseInt(high, 16), parseInt(low, 16));
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    const code = decimal === undefined ? parseInt(braced ?? four ?? byte ?? hex, 16) : Number(decimal);
    // Not a character (out of range or a lone surrogate half): keep the text as written.
    return code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? escape : String.fromCodePoint(code);
  });
}

// Decode each %XX run on its own so one malformed sequence cannot hide the rest;
// repeat a few times to unwrap double and nested encoding (%5Cu0041, &amp;#x41;).
function decodePercent(text) {
  for (let round = 0; round < 3; round++) {
    const next = decodeEscapes(text.replace(percentRun, (run) => {
      const bytes = run.match(/%[0-9A-Fa-f]{2}/g).map((byte) => parseInt(byte.slice(1), 16));
      return Buffer.from(bytes).toString('utf8');
    }));
    if (next === text) break;
    text = next;
  }
  return text;
}

export function normalize(text) {
  return decodePercent(text.replace(INVISIBLE_PATTERN, ''))
    .replace(INVISIBLE_PATTERN, '')
    .replace(BOUNDARY_PATTERN, ' ')
    .normalize('NFKD')
    .toLocaleLowerCase('tr')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
