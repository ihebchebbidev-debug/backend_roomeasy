import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 time-based one-time passwords (Google Authenticator, 1Password,
 * Authy…). 30-second steps, 6 digits, SHA-1 — the defaults every app supports.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Accepts the current step and one step either side (clock drift). */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): boolean {
  const candidate = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(now / 30_000);
  for (const drift of [-1, 0, 1]) {
    const expected = hotp(secret, step + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return true;
  }
  return false;
}

export function otpauthUrl(options: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const params = new URLSearchParams({ secret: options.secret, issuer: options.issuer, digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
