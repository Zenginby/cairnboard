const INVISIBLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const BOUNDARY_PATTERN = /(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu;
const percentRun = /(?:%[0-9A-Fa-f]{2})+/g;

// Decode each %XX run on its own so one malformed sequence cannot hide the rest;
// repeat a few times to unwrap double encoding.
function decodePercent(text) {
  for (let round = 0; round < 3; round++) {
    const next = text.replace(percentRun, (run) => {
      const bytes = run.match(/%[0-9A-Fa-f]{2}/g).map((byte) => parseInt(byte.slice(1), 16));
      return Buffer.from(bytes).toString('utf8');
    });
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
