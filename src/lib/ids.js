import { randomBytes, randomInt } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/** Time-sortable 26-char id (ULID layout). Valid Firestore document id. */
export function ulid(now = Date.now()) {
  return encodeTime(now) + encodeRandom();
}

/** Short lowercase base36 key for campaign URLs. */
export function shortKey(len = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** URL-safe random token (hex). */
export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}
