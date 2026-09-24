/**
 * Every failure the API can return, as a stable machine code plus a default
 * human message. The front-end branches on `code`, never on the message.
 *
 * The first block mirrors `src/api/types.ts :: ApiErrorCode` in the app so the
 * existing screens keep working unchanged.
 */

export const errorCatalogue = {
  // --- mirrored from the front-end contract ---------------------------------
  INVALID_DATES: { status: 422, message: "Check-out must be after check-in." },
  UNAVAILABLE: { status: 409, message: "Those nights are no longer available." },
  TOO_MANY_GUESTS: { status: 422, message: "That stay cannot host this many guests." },
  PAYMENT_DECLINED: { status: 402, message: "The payment was declined by the bank." },
  CARD_INVALID: { status: 422, message: "The card details are invalid." },
  NOT_FOUND: { status: 404, message: "The requested resource does not exist." },
  NOT_CANCELLABLE: { status: 409, message: "This booking can no longer be cancelled." },

  // --- validation & request shape -------------------------------------------
  VALIDATION_FAILED: { status: 422, message: "Some fields are invalid." },
  MALFORMED_JSON: { status: 400, message: "The request body is not valid JSON." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Send the body as application/json." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request body is too large." },

  // --- auth & access ---------------------------------------------------------
  UNAUTHENTICATED: { status: 401, message: "Sign in to continue." },
  INVALID_CREDENTIALS: { status: 401, message: "Email or password is incorrect." },
  TOKEN_EXPIRED: { status: 401, message: "Your session has expired. Sign in again." },
  TOKEN_INVALID: { status: 401, message: "Your session token is not valid." },
  FORBIDDEN: { status: 403, message: "You do not have access to this resource." },
  ACCOUNT_SUSPENDED: { status: 403, message: "This account has been suspended by an administrator." },
  EMAIL_TAKEN: { status: 409, message: "An account already uses this email address." },
  PASSWORD_TOO_WEAK: { status: 422, message: "Use at least 8 characters for the password." },
  TWO_FACTOR_REQUIRED: { status: 401, message: "Enter the 6-digit code from your authenticator app." },
  TWO_FACTOR_INVALID: { status: 401, message: "That code is not valid. Try the current code from your app." },
  RESET_TOKEN_INVALID: { status: 400, message: "This password reset link is invalid or has expired." },

  // --- listings & properties -------------------------------------------------
  LISTING_INCOMPLETE: { status: 422, message: "Complete every required step before publishing." },
  LISTING_NOT_APPROVED: { status: 409, message: "An administrator must approve this listing before it goes live." },
  PROPERTY_ID_TAKEN: { status: 409, message: "Another listing already uses this address slug." },
  PHOTO_LIMIT_REACHED: { status: 422, message: "A listing can hold at most 10 photos." },
  UNKNOWN_EQUIPMENT: { status: 422, message: "One of the selected equipment items does not exist." },
  LISTING_HAS_BOOKINGS: { status: 409, message: "This listing has live bookings and cannot be deleted." },

  // --- bookings & money ------------------------------------------------------
  MIN_NIGHTS_NOT_MET: { status: 422, message: "This stay has a longer minimum length." },
  DATES_IN_PAST: { status: 422, message: "Choose a check-in date in the future." },
  OWN_PROPERTY_BOOKING: { status: 409, message: "You cannot book your own listing." },
  BOOKING_NOT_PENDING: { status: 409, message: "Only a pending request can be answered." },
  ALREADY_REVIEWED: { status: 409, message: "This stay has already been reviewed." },
  REVIEW_NOT_ALLOWED: { status: 403, message: "Only the guest of a completed stay can review it." },
  PAYOUT_NOT_READY: { status: 409, message: "Complete payout onboarding before requesting money." },

  // --- messaging -------------------------------------------------------------
  THREAD_CLOSED: { status: 409, message: "This conversation is closed." },
  NOT_THREAD_PARTICIPANT: { status: 403, message: "You are not part of this conversation." },

  // --- generic ---------------------------------------------------------------
  CONFLICT: { status: 409, message: "That change conflicts with the current state." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Try again in a moment." },
  ROUTE_NOT_FOUND: { status: 404, message: "No API route matches this URL." },
  DATABASE_UNAVAILABLE: { status: 503, message: "The database is unreachable. Try again shortly." },
  SCHEMA_REPAIR_FAILED: { status: 500, message: "The database schema could not be repaired automatically." },
  INTERNAL: { status: 500, message: "Something went wrong on our side." },
} as const;

export type ApiErrorCode = keyof typeof errorCatalogue;

export type FieldIssue = { field: string; message: string; rule?: string };

/** The single error type every service and controller throws. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly issues: FieldIssue[];
  /** Not serialised — kept for the logs only. */
  readonly cause?: unknown;

  constructor(
    code: ApiErrorCode,
    options: { message?: string; details?: Record<string, unknown>; issues?: FieldIssue[]; cause?: unknown } = {},
  ) {
    const entry = errorCatalogue[code];
    super(options.message ?? entry.message);
    this.name = "ApiError";
    this.code = code;
    this.status = entry.status;
    this.details = options.details ?? {};
    this.issues = options.issues ?? [];
    this.cause = options.cause;
    Error.captureStackTrace?.(this, ApiError);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues.length ? { issues: this.issues } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export function apiError(
  code: ApiErrorCode,
  options?: { message?: string; details?: Record<string, unknown>; issues?: FieldIssue[]; cause?: unknown },
) {
  return new ApiError(code, options);
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Throws NOT_FOUND with a helpful message when a lookup came back empty. */
export function requireFound<T>(value: T | null | undefined, what: string, id: unknown): T {
  if (value === null || value === undefined) {
    throw apiError("NOT_FOUND", { message: `${what} was not found.`, details: { id } });
  }
  return value;
}
