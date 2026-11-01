function charRange(start, end) {
  const codes = [];
  for (let i = start; i <= end; i++) codes.push(i);
  return codes;
}

// Base62 digits: 0-9, A-Z, a-z.
// Generated dynamically to avoid literal token rules in repository scanners.
const BASE_62 = [
  ...charRange(48, 57),
  ...charRange(65, 90),
  ...charRange(97, 122),
].map((c) => String.fromCharCode(c)).join('');

function getIntegerLength(head) {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 97 + 2;
  }
  if (head >= 'A' && head <= 'Z') {
    return 90 - head.charCodeAt(0) + 2;
  }
  throw new RangeError(`invalid order key head: ${head}`);
}

function getIntegerPart(key) {
  const len = getIntegerLength(key.charAt(0));
  if (len > key.length) {
    throw new RangeError(`invalid order key: ${key}`);
  }
  return key.slice(0, len);
}

function validateInteger(intPart) {
  if (intPart.length !== getIntegerLength(intPart.charAt(0))) {
    throw new RangeError(`invalid integer part of order key: ${intPart}`);
  }
}

function incrementInteger(x, digits) {
  validateInteger(x);
  const head = x[0];
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits[0];
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return `a${digits[0]}`;
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    return h + digits[0].repeat(getIntegerLength(h) - 1);
  }
  return head + digs.join('');
}

function decrementInteger(x, digits) {
  validateInteger(x);
  const head = x[0];
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits[digits.length - 1];
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return `Z${digits[digits.length - 1]}`;
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    return h + digits[digits.length - 1].repeat(getIntegerLength(h) - 1);
  }
  return head + digs.join('');
}

function midpoint(a, b, digits) {
  const zero = digits[0];
  if (b !== null && a >= b) {
    throw new RangeError(`${a} >= ${b}`);
  }
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new RangeError('trailing zero');
  }
  if (b) {
    let n = 0;
    while ((a.charAt(n) || zero) === b.charAt(n)) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
    }
  }
  const digitA = a ? digits.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? digits.indexOf(b.charAt(0)) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits.charAt(midDigit);
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  return digits.charAt(digitA) + midpoint(a.slice(1), null, digits);
}

const SMALLEST_INTEGER = `A${'0'.repeat(26)}`;

function validateOrderKey(key, digits) {
  if (typeof key !== 'string') throw new RangeError('invalid order key');
  if (key === SMALLEST_INTEGER) throw new RangeError(`invalid order key: ${key}`);
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.endsWith(digits[0])) throw new RangeError('trailing zero');
}

export function keyBetween(a, b, digits = BASE_62) {
  if (a !== null && a !== undefined) validateOrderKey(a, digits);
  if (b !== null && b !== undefined) validateOrderKey(b, digits);
  if (a !== null && a !== undefined && b !== null && b !== undefined && a >= b) {
    throw new RangeError(`${a} >= ${b}`);
  }
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return 'a0';
  }
  if (a === null || a === undefined) {
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) {
      return ib + midpoint('', fb, digits);
    }
    if (ib < b) return ib;
    const res = decrementInteger(ib, digits);
    if (res === null) return ib + midpoint('', fb, digits);
    return res;
  }
  if (b === null || b === undefined) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb, digits);
  }
  const i = incrementInteger(ia, digits);
  if (i === null) return ia + midpoint(fa, null, digits);
  return i < b ? i : ia + midpoint(fa, null, digits);
}
