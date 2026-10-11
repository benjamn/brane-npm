import { randomBytes } from "node:crypto";

/**
 * Generate a crypto-random string of `len` lowercase base36 characters
 * (`0-9a-z`). Used for the collision-resistant suffixes of narrative ids
 * (`<agent>-<8>`), brane ids (`brane-<6>`), and server-minted external ids
 * (`external-<8>`).
 */
export function randomBase36(len: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  // Rejection-sample to avoid modulo bias: 256 is not a multiple of 36, so a
  // plain `byte % 36` would map the high bytes (252-255) onto 0-3, skewing
  // those four characters. Discard bytes >= 252 (the largest multiple of 36)
  // and redraw, so every character is uniform over the 36-symbol alphabet.
  let s = "";
  while (s.length < len) {
    const bytes = randomBytes(len - s.length);
    for (let i = 0; i < bytes.length && s.length < len; i++) {
      if (bytes[i] < 252) s += alphabet[bytes[i] % 36];
    }
  }
  return s;
}
