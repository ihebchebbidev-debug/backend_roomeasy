/**
 * The fixed list of reasons a moderator can pick when refusing a listing.
 * Mirrored in the app at `src/lib/listingRejectionReasons.ts` — keep both in sync.
 */
export const LISTING_REJECTION_REASONS = [
  { code: "photos_insufficient", label: "Photos missing, too few, or of poor quality" },
  { code: "description_incomplete", label: "Description incomplete or not informative enough" },
  { code: "address_invalid", label: "Address or location is inaccurate" },
  { code: "price_unrealistic", label: "Price is unrealistic for this listing" },
  { code: "duplicate_listing", label: "Duplicate of an existing listing" },
  { code: "prohibited_content", label: "Contains prohibited or offensive content" },
  { code: "contact_details", label: "Contains contact details or off-platform booking" },
  { code: "not_compliant", label: "Does not meet legal or safety requirements" },
  { code: "other", label: "Other reason (explained below)" },
] as const;

export type ListingRejectionCode = (typeof LISTING_REJECTION_REASONS)[number]["code"];

export const LISTING_REJECTION_CODES = LISTING_REJECTION_REASONS.map((reason) => reason.code) as [
  ListingRejectionCode,
  ...ListingRejectionCode[],
];

/** Builds the message stored on the listing and emailed to the host. */
export function rejectionMessage(code: ListingRejectionCode, details?: string | null): string {
  const label = LISTING_REJECTION_REASONS.find((reason) => reason.code === code)?.label ?? code;
  const extra = details?.trim();
  return extra ? `${label} — ${extra}` : label;
}
