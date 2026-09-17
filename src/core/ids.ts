import { randomBytes, randomUUID } from "node:crypto";

/** Same slug rules as the wizard (`src/models/listing.ts :: slugifyListing`). */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 48) || "listing"
  );
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function code(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Guest-facing booking code, e.g. `RE-8H4K2P`. */
export function bookingReference(): string {
  return `RE-${code(6)}`;
}

export function bookingId(): string {
  return `bk-${code(6).toLowerCase()}`;
}

export function payoutId(): string {
  return `po-${code(6).toLowerCase()}`;
}

export function threadId(propertyId: string): string {
  return `th-${propertyId}`.slice(0, 120);
}

export function teamMemberId(): string {
  return `tm-${code(6).toLowerCase()}`;
}

export function paymentIntentReference(): string {
  return `pi_${randomBytes(8).toString("hex")}`;
}

export function uuid(): string {
  return randomUUID();
}
