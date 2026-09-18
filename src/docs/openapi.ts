/**
 * Hand-written OpenAPI 3.0 description of every route mounted under `/api`.
 *
 * Kept as plain data (no code generation, no extra runtime dependency) so the
 * document is easy to read, easy to diff, and cheap to serve. `docs.routes.ts`
 * exposes it as JSON and renders it with Swagger UI.
 */

type Method = "get" | "post" | "put" | "patch" | "delete";

interface OpDef {
  summary: string;
  tags: string[];
  auth?: "none" | "user" | "host" | "admin";
  params?: string[];
  query?: Record<string, string>;
  body?: unknown;
  status?: number;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  ...(required.length ? { required } : {}),
  properties,
});
const arr = (items: unknown) => ({ type: "array", items });

const paths: Record<string, Partial<Record<Method, OpDef>>> = {};

function op(method: Method, path: string, def: OpDef) {
  const entry = (paths[path] ??= {});
  entry[method] = def;
}

/* ------------------------------------------------------------------ health */

op("get", "/health", { summary: "Liveness probe", tags: ["Health"], auth: "none" });
op("get", "/health/ready", { summary: "Readiness probe (checks the database)", tags: ["Health"], auth: "none" });

/* ---------------------------------------------------------------- accounts */

op("post", "/accounts/signup", {
  summary: "Create an account and return a session token",
  tags: ["Accounts"],
  auth: "none",
  status: 201,
  body: obj(
    {
      fullName: str,
      email: { type: "string", format: "email" },
      password: { type: "string", minLength: 8 },
      phone: str,
      locale: { type: "string", enum: ["en", "fr", "es", "de", "pt"] },
      currency: str,
      asHost: bool,
    },
    ["fullName", "email", "password"],
  ),
});
op("post", "/accounts/login", {
  summary: "Sign in with email and password",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ email: { type: "string", format: "email" }, password: str }, ["email", "password"]),
});
op("post", "/accounts/refresh", { summary: "Issue a fresh token for the current session", tags: ["Accounts"], auth: "user" });
op("get", "/accounts/me", { summary: "The signed-in account", tags: ["Accounts"], auth: "user" });
op("patch", "/accounts/me", {
  summary: "Update the signed-in profile",
  tags: ["Accounts"],
  auth: "user",
  body: obj({
    fullName: str,
    phone: { type: "string", nullable: true },
    avatarUrl: { type: "string", nullable: true },
    locale: { type: "string", enum: ["en", "fr", "es", "de", "pt"] },
    currency: str,
    twoFactorEnabled: bool,
  }),
});
op("post", "/accounts/me/password", {
  summary: "Change the password",
  tags: ["Accounts"],
  auth: "user",
  status: 204,
  body: obj({ currentPassword: str, newPassword: str }, ["currentPassword", "newPassword"]),
});
op("post", "/accounts/me/become-host", {
  summary: "Add the host role to the current account",
  tags: ["Accounts"],
  auth: "user",
  body: obj({ displayName: str }),
});
op("get", "/accounts/me/trust-badges", { summary: "Trust badges for the current account", tags: ["Accounts"], auth: "user" });
op("put", "/accounts/me/avatar", {
  summary: "Upload or replace the profile photo (JPEG, PNG or WebP data URL, max 2 MB)",
  tags: ["Accounts"],
  auth: "user",
  body: obj({ dataUrl: { type: "string", example: "data:image/jpeg;base64,..." } }, ["dataUrl"]),
});
op("delete", "/accounts/me/avatar", {
  summary: "Remove the profile photo",
  tags: ["Accounts"],
  auth: "user",
});
op("get", "/accounts/{userId}/avatar", {
  summary: "The public profile photo of an account (image bytes)",
  tags: ["Accounts"],
  auth: "none",
  params: ["userId"],
});
op("post", "/accounts/forgot-password", {
  summary: "Email a 4-digit password reset code",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ email: { type: "string", format: "email" } }, ["email"]),
});
op("post", "/accounts/verify-reset-code", {
  summary: "Trade the 4-digit code for a single-use reset ticket",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ email: { type: "string", format: "email" }, code: str }, ["email", "code"]),
});
op("post", "/accounts/reset-password", {
  summary: "Set a new password with a reset ticket",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ token: str, password: str }, ["token", "password"]),
});
op("post", "/accounts/dev/admin", {
  summary: "Development helper: create or promote an administrator (disabled in production)",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ email: { type: "string", format: "email" }, password: str, fullName: str, role: str }, ["email", "password"]),
});
op("post", "/accounts/cookie-consent", {
  summary: "Record a cookie consent choice",
  tags: ["Accounts"],
  auth: "none",
  body: obj({ choice: { type: "string", enum: ["accepted", "essential"] }, deviceId: str }, ["choice"]),
});

/* ------------------------------------------------------------------- stays */

const searchQuery: Record<string, string> = {
  where: "Free-text destination",
  category: "Property type",
  minPrice: "Minimum nightly price",
  maxPrice: "Maximum nightly price",
  rating: "Minimum rating",
  beds: "Minimum beds",
  baths: "Minimum bathrooms",
  rooms: "Minimum rooms",
  guests: "Minimum guest capacity",
  amenities: "Comma separated amenity keys",
  equipment: "Comma separated equipment keys",
  superhost: "Only superhosts (true/false)",
  from: "Check-in (YYYY-MM-DD)",
  to: "Check-out (YYYY-MM-DD)",
  sort: "recommended | price-low | price-high | rating | distance",
  locale: "en | fr | es | de | pt",
  limit: "Page size (1-100)",
  offset: "Rows to skip",
};

op("get", "/stays", { summary: "Search published stays", tags: ["Stays"], auth: "none", query: searchQuery });
op("get", "/stays/categories", { summary: "Result counts per property type", tags: ["Stays"], auth: "none", query: searchQuery });
op("get", "/stays/{id}", { summary: "One stay in full", tags: ["Stays"], auth: "none", params: ["id"], query: { locale: "Language" } });
op("get", "/stays/{id}/reviews", {
  summary: "Reviews for a stay",
  tags: ["Stays"],
  auth: "none",
  params: ["id"],
  query: { limit: "Page size", offset: "Rows to skip" },
});
op("get", "/stays/{id}/calendar", {
  summary: "Availability and price overrides",
  tags: ["Stays"],
  auth: "none",
  params: ["id"],
  query: { from: "Range start", to: "Range end" },
});

/* --------------------------------------------------------------- equipment */

op("get", "/equipment", { summary: "Equipment catalogue", tags: ["Equipment"], auth: "none" });
op("get", "/equipment/groups", { summary: "Equipment grouped by category", tags: ["Equipment"], auth: "none" });

/* --------------------------------------------------------------- favorites */

op("get", "/favorites", { summary: "Saved stays with full detail", tags: ["Favorites"], auth: "user" });
op("get", "/favorites/ids", { summary: "Saved stay ids only", tags: ["Favorites"], auth: "user" });
op("put", "/favorites/{propertyId}", { summary: "Save a stay", tags: ["Favorites"], auth: "user", params: ["propertyId"] });
op("delete", "/favorites/{propertyId}", {
  summary: "Remove a saved stay",
  tags: ["Favorites"],
  auth: "user",
  params: ["propertyId"],
  status: 204,
});
op("post", "/favorites/sync", {
  summary: "Merge favourites saved while signed out",
  tags: ["Favorites"],
  auth: "user",
  body: obj({ propertyIds: arr(str) }, ["propertyIds"]),
});

/* ---------------------------------------------------------------- listings */

const listingDraft = obj(
  {
    propertyId: str,
    listingId: str,
    title: { type: "string", minLength: 4 },
    category: str,
    summary: str,
    description: str,
    location: obj({ city: str, country: str, postal: str, neighbourhood: str }, ["city", "country"]),
    capacity: obj({ guests: int, rooms: int, beds: int, baths: int, area: int }, ["guests", "rooms", "beds", "baths", "area"]),
    amenities: arr(str),
    equipment: arr(str),
    photos: arr(str),
    pricing: obj(
      {
        nightlyUsd: num,
        cleaningFeeUsd: num,
        minNights: int,
        longStay: obj({ enabled: bool, threshold: int, discount: num }),
        mobile: obj({ enabled: bool, discount: num }),
      },
      ["nightlyUsd"],
    ),
    policies: obj({
      cancellationPolicy: { type: "string", enum: ["flexible", "moderate", "strict"] },
      houseRules: str,
      checkIn: str,
      checkOut: str,
      instantBook: bool,
    }),
    status: { type: "string", enum: ["draft", "published", "suspended"] },
  },
  ["title", "category", "location", "capacity", "pricing", "policies"],
);

op("get", "/listings", { summary: "The host's own listings", tags: ["Listings"], auth: "host" });
op("put", "/listings", { summary: "Create or update a listing", tags: ["Listings"], auth: "host", body: listingDraft });
op("get", "/listings/{listingId}", { summary: "Host preview of one listing", tags: ["Listings"], auth: "host", params: ["listingId"] });
op("get", "/listings/{listingId}/history", {
  summary: "Submission and moderation history",
  tags: ["Listings"],
  auth: "host",
  params: ["listingId"],
});
op("patch", "/listings/{listingId}/status", {
  summary: "Publish, unpublish or suspend a listing",
  tags: ["Listings"],
  auth: "host",
  params: ["listingId"],
  body: obj({ status: { type: "string", enum: ["draft", "published", "suspended"] } }, ["status"]),
});
op("delete", "/listings/{listingId}", { summary: "Delete a listing", tags: ["Listings"], auth: "host", params: ["listingId"], status: 204 });
op("get", "/listings/{listingId}/calendar", { summary: "Listing calendar", tags: ["Listings"], auth: "host", params: ["listingId"] });
op("put", "/listings/{listingId}/calendar", {
  summary: "Block nights or set price overrides",
  tags: ["Listings"],
  auth: "host",
  params: ["listingId"],
  body: obj({
    nights: arr(obj({ night: str, blocked: bool, priceUsd: num, note: str }, ["night"])),
    range: obj({ from: str, to: str, blocked: bool, note: str }),
  }),
});
op("delete", "/listings/{listingId}/calendar", {
  summary: "Clear calendar entries",
  tags: ["Listings"],
  auth: "host",
  params: ["listingId"],
  body: obj({ nights: arr(str) }, ["nights"]),
  status: 204,
});

/* ---------------------------------------------------------------- bookings */

op("get", "/bookings/availability", {
  summary: "Check whether a stay is free for a date range",
  tags: ["Bookings"],
  auth: "none",
  query: { propertyId: "Stay id", from: "Check-in", to: "Check-out", guests: "Guest count", isMobile: "Apply the mobile discount" },
});
op("get", "/bookings/quote", {
  summary: "Price a stay for a date range",
  tags: ["Bookings"],
  auth: "none",
  query: { propertyId: "Stay id", from: "Check-in", to: "Check-out", guests: "Guest count" },
});
op("post", "/bookings", {
  summary: "Create a booking request",
  tags: ["Bookings"],
  auth: "user",
  status: 201,
  body: obj(
    {
      propertyId: str,
      from: str,
      to: str,
      guests: int,
      isMobile: bool,
      message: str,
      guest: obj({ name: str, email: str, phone: str }, ["name"]),
      card: obj({ number: str, name: str, expiry: str, cvc: str }),
      paymentMethod: { type: "string", enum: ["card", "stripe"] },
    },
    ["propertyId", "from", "to", "guests", "guest"],
  ),
});
op("get", "/bookings", { summary: "The guest's bookings", tags: ["Bookings"], auth: "user" });
op("get", "/bookings/host", { summary: "Bookings on the host's listings", tags: ["Bookings"], auth: "host" });
op("get", "/bookings/{bookingId}", { summary: "One booking", tags: ["Bookings"], auth: "user", params: ["bookingId"] });
op("post", "/bookings/{bookingId}/decision", {
  summary: "Host accepts or declines a request",
  tags: ["Bookings"],
  auth: "host",
  params: ["bookingId"],
  body: obj({ decision: { type: "string", enum: ["accept", "decline"] }, reason: str }, ["decision"]),
});
op("post", "/bookings/{bookingId}/cancel", {
  summary: "Cancel a booking",
  tags: ["Bookings"],
  auth: "user",
  params: ["bookingId"],
  body: obj({ reason: str }),
});

/* ----------------------------------------------------------------- reviews */

op("get", "/reviews/mine/written", { summary: "Reviews written by the current user", tags: ["Reviews"], auth: "user" });
op("get", "/reviews/mine/pending", { summary: "Stays still waiting for a review", tags: ["Reviews"], auth: "user" });
op("get", "/reviews/host/received", { summary: "Reviews received by the host", tags: ["Reviews"], auth: "host" });
op("get", "/reviews/{reviewId}", { summary: "One review", tags: ["Reviews"], auth: "none", params: ["reviewId"] });
op("post", "/reviews", {
  summary: "Publish a review for a completed stay",
  tags: ["Reviews"],
  auth: "user",
  status: 201,
  body: obj({ bookingId: str, rating: int, comment: str }, ["bookingId", "rating"]),
});
op("patch", "/reviews/{reviewId}", {
  summary: "Edit a review",
  tags: ["Reviews"],
  auth: "user",
  params: ["reviewId"],
  body: obj({ rating: int, comment: str }),
});
op("post", "/reviews/{reviewId}/reply", {
  summary: "Host reply to a review",
  tags: ["Reviews"],
  auth: "host",
  params: ["reviewId"],
  body: obj({ reply: str }, ["reply"]),
});

/* ---------------------------------------------------------------- messaging */

op("get", "/messaging/threads", { summary: "Conversation list", tags: ["Messaging"], auth: "user" });
op("get", "/messaging/unread", { summary: "Unread message count", tags: ["Messaging"], auth: "user" });
op("get", "/messaging/threads/{threadId}", { summary: "One conversation with its messages", tags: ["Messaging"], auth: "user", params: ["threadId"] });
op("post", "/messaging/threads", {
  summary: "Start a conversation",
  tags: ["Messaging"],
  auth: "user",
  status: 201,
  body: obj({ propertyId: str, bookingId: str, recipientId: str, body: str }),
});
op("post", "/messaging/threads/{threadId}/messages", {
  summary: "Send a message",
  tags: ["Messaging"],
  auth: "user",
  params: ["threadId"],
  status: 201,
  body: obj({ body: str }, ["body"]),
});
op("post", "/messaging/threads/{threadId}/read", { summary: "Mark a conversation as read", tags: ["Messaging"], auth: "user", params: ["threadId"] });
op("patch", "/messaging/threads/{threadId}", {
  summary: "Close or reopen a conversation",
  tags: ["Messaging"],
  auth: "user",
  params: ["threadId"],
  body: obj({ closed: bool }, ["closed"]),
});

/* ---------------------------------------------------------------- payments */

op("get", "/payments/config", { summary: "Publishable payment configuration", tags: ["Payments"], auth: "none" });
op("post", "/payments/intents", {
  summary: "Create a payment intent for a booking",
  tags: ["Payments"],
  auth: "user",
  body: obj({ bookingId: str }, ["bookingId"]),
});
op("get", "/payments/connect/status", { summary: "Host payout account status", tags: ["Payments"], auth: "host" });
op("post", "/payments/connect/onboarding-link", { summary: "Link to finish payout onboarding", tags: ["Payments"], auth: "host" });
op("post", "/payments/connect/dashboard-link", { summary: "Link to the payout dashboard", tags: ["Payments"], auth: "host" });

/* -------------------------------------------------------------------- host */

op("get", "/host/profile", { summary: "Public host profile", tags: ["Host"], auth: "host" });
op("patch", "/host/profile", {
  summary: "Update the host profile",
  tags: ["Host"],
  auth: "host",
  body: obj({ displayName: str, bio: str, responseTimeHours: int }),
});
op("get", "/host/dashboard", { summary: "Host dashboard totals", tags: ["Host"], auth: "host" });
op("get", "/host/earnings", { summary: "Earnings breakdown", tags: ["Host"], auth: "host" });
op("post", "/host/payouts/onboarding", { summary: "Start payout onboarding", tags: ["Host"], auth: "host" });
op("get", "/host/payouts", { summary: "Payout history", tags: ["Host"], auth: "host" });
op("get", "/host/rate-rules", { summary: "Pricing rules", tags: ["Host"], auth: "host" });
op("put", "/host/rate-rules", { summary: "Replace pricing rules", tags: ["Host"], auth: "host", body: obj({ rules: arr(obj({})) }) });
op("get", "/host/team", { summary: "Co-hosts", tags: ["Host"], auth: "host" });
op("post", "/host/team", { summary: "Invite a co-host", tags: ["Host"], auth: "host", body: obj({ email: str, role: str }, ["email"]) });
op("delete", "/host/team/{memberId}", { summary: "Remove a co-host", tags: ["Host"], auth: "host", params: ["memberId"], status: 204 });

/* ----------------------------------------------------------------- support */

op("get", "/support/tickets", { summary: "The user's support tickets", tags: ["Support"], auth: "user" });
op("post", "/support/tickets", {
  summary: "Open a support ticket",
  tags: ["Support"],
  auth: "user",
  status: 201,
  body: obj({ subject: str, category: { type: "string", enum: ["booking", "payment", "listing", "account", "dispute", "other"] }, body: str, bookingId: str, listingId: str }, ["subject", "body"]),
});
op("get", "/support/tickets/{ticketId}", { summary: "One ticket with its messages", tags: ["Support"], auth: "user", params: ["ticketId"] });
op("post", "/support/tickets/{ticketId}/messages", {
  summary: "Reply on a ticket",
  tags: ["Support"],
  auth: "user",
  params: ["ticketId"],
  status: 201,
  body: obj({ body: str }, ["body"]),
});
op("post", "/support/reports", {
  summary: "Report a listing or a user",
  tags: ["Support"],
  auth: "user",
  status: 201,
  body: obj({ listingId: str, reason: { type: "string", enum: ["fraud", "inappropriate", "wrong_information", "unavailable", "safety", "other"] }, details: str }, ["listingId", "reason"]),
});

/* ---------------------------------------------------------------- settings */

op("get", "/settings", { summary: "Public platform settings", tags: ["Settings"], auth: "none" });
op("get", "/settings/admin", { summary: "Full settings with private values", tags: ["Settings"], auth: "admin" });
op("put", "/settings/admin", { summary: "Update platform settings", tags: ["Settings"], auth: "admin", body: obj({}) });

/* ---------------------------------------------------------------- currency */

op("get", "/currency/rates", { summary: "Exchange rates", tags: ["Currency"], auth: "none" });
op("get", "/currency/convert", {
  summary: "Convert an amount",
  tags: ["Currency"],
  auth: "none",
  query: { amountUsd: "Amount in USD", to: "Target currency" },
});
op("post", "/currency/rates/refresh", { summary: "Refresh rates from the provider", tags: ["Currency"], auth: "admin" });

/* ------------------------------------------------------------------- admin */

const A = ["Admin"];
op("get", "/admin/me", { summary: "The administrator session", tags: A, auth: "admin" });
op("get", "/admin/overview", { summary: "Back-office KPIs", tags: A, auth: "admin" });
op("get", "/admin/reports", { summary: "Reporting series", tags: A, auth: "admin", query: { from: "Range start", to: "Range end" } });
op("get", "/admin/listings", { summary: "All listings with moderation state", tags: A, auth: "admin", query: { status: "Filter by status", q: "Search" } });
op("post", "/admin/listings/{listingId}/approve", { summary: "Approve a listing", tags: A, auth: "admin", params: ["listingId"] });
op("post", "/admin/listings/{listingId}/reject", { summary: "Reject a listing", tags: A, auth: "admin", params: ["listingId"], body: obj({ reason: str }) });
op("post", "/admin/listings/{listingId}/suspend", { summary: "Suspend a listing", tags: A, auth: "admin", params: ["listingId"], body: obj({ reason: str }) });
op("post", "/admin/listings/{listingId}/restore", { summary: "Restore a listing", tags: A, auth: "admin", params: ["listingId"] });
op("get", "/admin/users", { summary: "User directory", tags: A, auth: "admin", query: { q: "Search", role: "Filter by role" } });
op("post", "/admin/users/{userId}/suspend", { summary: "Suspend a user", tags: A, auth: "admin", params: ["userId"], body: obj({ reason: str }) });
op("post", "/admin/users/{userId}/restore", { summary: "Restore a user", tags: A, auth: "admin", params: ["userId"] });
op("post", "/admin/users/{userId}/roles", { summary: "Grant a role", tags: A, auth: "admin", params: ["userId"], body: obj({ role: str }, ["role"]) });
op("delete", "/admin/users/{userId}/roles/{role}", { summary: "Revoke a role", tags: A, auth: "admin", params: ["userId", "role"] });
op("get", "/admin/moderation-log", { summary: "Moderation audit trail", tags: A, auth: "admin" });
op("get", "/admin/reviews", { summary: "Reviews queue", tags: A, auth: "admin" });
op("post", "/admin/reviews/{reviewId}/hide", { summary: "Hide a review", tags: A, auth: "admin", params: ["reviewId"] });
op("post", "/admin/reviews/{reviewId}/restore", { summary: "Restore a review", tags: A, auth: "admin", params: ["reviewId"] });
op("delete", "/admin/reviews/{reviewId}", { summary: "Delete a review", tags: A, auth: "admin", params: ["reviewId"], status: 204 });
op("get", "/admin/bookings", { summary: "All bookings", tags: A, auth: "admin" });
op("get", "/admin/payouts", { summary: "Payout runs", tags: A, auth: "admin" });
op("post", "/admin/payouts", { summary: "Create a payout run", tags: A, auth: "admin", body: obj({ hostId: str, amountUsd: num }) });
op("post", "/admin/payouts/{payoutId}/paid", { summary: "Mark a payout as paid", tags: A, auth: "admin", params: ["payoutId"] });

const O = ["Admin operations"];
op("get", "/admin/listing-reports", { summary: "Reported listings", tags: O, auth: "admin" });
op("post", "/admin/listing-reports/{reportId}/status", { summary: "Change a report status", tags: O, auth: "admin", params: ["reportId"], body: obj({ status: str }, ["status"]) });
op("post", "/admin/listings/{listingId}/unpublish", { summary: "Unpublish a listing", tags: O, auth: "admin", params: ["listingId"], body: obj({ reason: str }) });
op("get", "/admin/verifications", { summary: "Identity verification queue", tags: O, auth: "admin" });
op("post", "/admin/users/{userId}/verification", { summary: "Approve or reject a verification", tags: O, auth: "admin", params: ["userId"], body: obj({ status: str, note: str }, ["status"]) });
op("post", "/admin/users/{userId}/ban", { summary: "Ban a user", tags: O, auth: "admin", params: ["userId"], body: obj({ reason: str }) });
op("post", "/admin/users/{userId}/unban", { summary: "Lift a ban", tags: O, auth: "admin", params: ["userId"] });
op("get", "/admin/commissions", { summary: "Commission rates per host", tags: O, auth: "admin" });
op("put", "/admin/commissions/{hostId}", { summary: "Set a host commission", tags: O, auth: "admin", params: ["hostId"], body: obj({ commissionRate: { type: "number", nullable: true }, note: str }, ["commissionRate"]) });
op("get", "/admin/bookings/{bookingId}/audit", { summary: "Booking audit trail", tags: O, auth: "admin", params: ["bookingId"] });
op("post", "/admin/bookings/{bookingId}/cancel", { summary: "Cancel a booking as an administrator", tags: O, auth: "admin", params: ["bookingId"], body: obj({ reason: str }) });
op("post", "/admin/bookings/{bookingId}/refund", { summary: "Refund a booking", tags: O, auth: "admin", params: ["bookingId"], body: obj({ amountUsd: num, reason: str }) });
op("post", "/admin/bookings/{bookingId}/adjust", { summary: "Adjust a booking total", tags: O, auth: "admin", params: ["bookingId"], body: obj({ amountUsd: num, reason: str }) });
op("get", "/admin/tickets", { summary: "Support queue", tags: O, auth: "admin" });
op("get", "/admin/tickets/{ticketId}", { summary: "One ticket", tags: O, auth: "admin", params: ["ticketId"] });
op("post", "/admin/tickets/{ticketId}/messages", { summary: "Answer a ticket", tags: O, auth: "admin", params: ["ticketId"], body: obj({ body: str }, ["body"]) });
op("post", "/admin/tickets/{ticketId}/assign", { summary: "Assign a ticket", tags: O, auth: "admin", params: ["ticketId"], body: obj({ assigneeId: str }) });
op("post", "/admin/tickets/{ticketId}/status", { summary: "Change a ticket status", tags: O, auth: "admin", params: ["ticketId"], body: obj({ status: str }, ["status"]) });
op("get", "/admin/notifications", { summary: "Notification / email queue", tags: O, auth: "admin" });
op("post", "/admin/notifications/{id}/retry", { summary: "Retry a queued notification", tags: O, auth: "admin", params: ["id"] });
op("get", "/admin/stats/compare", { summary: "Compare two periods", tags: O, auth: "admin" });
op("get", "/admin/stats/export.csv", { summary: "Export statistics as CSV", tags: O, auth: "admin" });
op("get", "/admin/email/status", { summary: "SMTP status", tags: O, auth: "admin" });
op("post", "/admin/email/verify", { summary: "Verify the SMTP connection", tags: O, auth: "admin" });
op("post", "/admin/email/dispatch", { summary: "Flush the outgoing mail queue", tags: O, auth: "admin" });
op("post", "/admin/email/test", { summary: "Send a test email", tags: O, auth: "admin", body: obj({ to: str }, ["to"]) });

/* ------------------------------------------------------------- assembly -- */

function toOperation(method: Method, def: OpDef) {
  const parameters = [
    ...(def.params ?? []).map((name) => ({ name, in: "path", required: true, schema: str })),
    ...Object.entries(def.query ?? {}).map(([name, description]) => ({
      name,
      in: "query",
      required: false,
      description,
      schema: str,
    })),
  ];

  const successCode = String(def.status ?? 200);
  const responses: Record<string, unknown> = {
    [successCode]:
      successCode === "204"
        ? { description: "No content" }
        : { description: "Success", content: { "application/json": { schema: ref("Envelope") } } },
    "422": { description: "Validation failed", content: { "application/json": { schema: ref("Error") } } },
  };
  if (def.auth && def.auth !== "none") {
    responses["401"] = { description: "Missing or invalid token", content: { "application/json": { schema: ref("Error") } } };
    if (def.auth !== "user") {
      responses["403"] = { description: "The role is not allowed here", content: { "application/json": { schema: ref("Error") } } };
    }
  }
  if (def.params?.length) {
    responses["404"] = { description: "Not found", content: { "application/json": { schema: ref("Error") } } };
  }

  return {
    summary: def.summary,
    tags: def.tags,
    description:
      def.auth && def.auth !== "none"
        ? `Requires a bearer token${def.auth === "user" ? "" : ` with the \`${def.auth}\` role`}.`
        : "Public endpoint.",
    ...(parameters.length ? { parameters } : {}),
    ...(def.body && method !== "get"
      ? { requestBody: { required: true, content: { "application/json": { schema: def.body } } } }
      : {}),
    ...(def.auth && def.auth !== "none" ? { security: [{ bearerAuth: [] }] } : { security: [] }),
    responses,
  };
}

export function buildOpenApiDocument(serverUrl: string) {
  const openapiPaths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(paths)) {
    openapiPaths[path] = {};
    for (const [method, def] of Object.entries(methods) as [Method, OpDef][]) {
      openapiPaths[path][method] = toOperation(method, def);
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "RoomEasy API",
      version: "1.0.0",
      description:
        "Every endpoint of the RoomEasy backend. Responses are wrapped in `{ data, meta? }`; errors return `{ error: { code, message, issues? } }`.\n\n" +
        "**Trying protected routes:** call `POST /accounts/login` (or `/accounts/signup`), copy the `data.token` value, then press *Authorize* and paste it.",
    },
    servers: [{ url: serverUrl, description: "This server" }],
    tags: [
      "Health",
      "Accounts",
      "Stays",
      "Equipment",
      "Favorites",
      "Listings",
      "Bookings",
      "Reviews",
      "Messaging",
      "Payments",
      "Host",
      "Support",
      "Settings",
      "Currency",
      "Admin",
      "Admin operations",
    ].map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Envelope: obj({ data: {}, meta: obj({ total: int, limit: int, offset: int, hasMore: bool }) }, ["data"]),
        Error: obj(
          {
            error: obj(
              {
                code: str,
                message: str,
                issues: arr(obj({ field: str, message: str })),
                requestId: str,
              },
              ["code", "message"],
            ),
          },
          ["error"],
        ),
      },
    },
    paths: openapiPaths,
  };
}

/** Number of documented operations — used by the docs page and the test suite. */
export function documentedOperationCount(): number {
  return Object.values(paths).reduce((total, methods) => total + Object.keys(methods).length, 0);
}
