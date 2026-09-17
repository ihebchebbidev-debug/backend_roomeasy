import { apiError } from "@/core/errors.js";

/** Card validation and the deterministic payment simulator (mock PSP). */

export type CardBrand = "visa" | "mastercard" | "amex" | "card";

export function cardBrand(number: string): CardBrand {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("4")) return "visa";
  if (/^5[1-5]/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  return "card";
}

export function luhnValid(number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function expiryValid(expiry: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry.trim());
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  return new Date(Date.UTC(year, month, 1)).getTime() > Date.now();
}

export type CardInput = { number: string; name: string; expiry: string; cvc: string };

/**
 * Validates the card and "charges" it. Replace the body of this function with
 * a real PSP call (Stripe PaymentIntent) — the callers stay unchanged.
 */
export function authorizeCard(card: CardInput, amountUsd: number) {
  const issues: { field: string; message: string }[] = [];
  if (!luhnValid(card.number)) issues.push({ field: "card.number", message: "That card number is not valid." });
  if (!expiryValid(card.expiry)) {
    issues.push({ field: "card.expiry", message: "Use a future expiry date in MM/YY format." });
  }
  if (!/^\d{3,4}$/.test(card.cvc.trim())) {
    issues.push({ field: "card.cvc", message: "The security code is 3 or 4 digits." });
  }
  if (!card.name.trim()) issues.push({ field: "card.name", message: "Enter the name printed on the card." });

  if (issues.length) throw apiError("CARD_INVALID", { issues, details: { checked: issues.length } });

  const digits = card.number.replace(/\D/g, "");
  // Deterministic decline card, kept from the front-end mock so the declined
  // path stays testable end to end.
  if (digits.endsWith("0002")) {
    throw apiError("PAYMENT_DECLINED", {
      message: "The bank declined this card. Try another payment method.",
      details: { declineCode: "generic_decline" },
    });
  }

  return {
    brand: cardBrand(card.number),
    last4: digits.slice(-4),
    amountUsd,
    status: "authorized" as const,
  };
}
