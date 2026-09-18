/**
 * End-to-end API test suite.
 *
 * Runs against a live server over HTTP (no mocks), so it proves the same thing a
 * client would experience: routing, validation, auth, roles and the full CRUD
 * life-cycle of every writable resource.
 *
 *   npm run test:api                        # http://localhost:4000
 *   BASE_URL=https://api.roomeasy.fr npm run test:api
 *
 * Every account it creates is namespaced with a timestamp, and each test cleans
 * up what it created, so the suite is safe to re-run.
 */

const BASE = (process.env["BASE_URL"] ?? "http://localhost:4000").replace(/\/+$/, "");
const API = `${BASE}/api`;
const STAMP = Date.now();

/* ----------------------------------------------------------------- runner -- */

interface Result {
  name: string;
  group: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const results: Result[] = [];
let group = "general";
let skipRest = false;

const c = {
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  grey: (s: string) => `\u001b[90m${s}\u001b[0m`,
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
};

function section(name: string) {
  group = name;
  console.log(`\n${c.bold(c.cyan(name))}`);
}

async function test(name: string, fn: () => Promise<void>) {
  if (skipRest) {
    results.push({ name, group, ok: false, ms: 0, detail: "skipped" });
    return;
  }
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ name, group, ok: true, ms });
    console.log(`  ${c.green("PASS")} ${name} ${c.grey(`${ms}ms`)}`);
  } catch (error) {
    const ms = Date.now() - started;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, group, ok: false, ms, detail });
    console.log(`  ${c.red("FAIL")} ${name} ${c.grey(`${ms}ms`)}\n       ${c.red(detail)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ http -- */

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  expect?: number | number[];
  query?: Record<string, string | number | boolean | undefined>;
}

async function call<T = any>(path: string, options: CallOptions = {}): Promise<{ status: number; body: any }> {
  const { method = "GET", body, token, expect = [200, 201, 204], query } = options;
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const allowed = Array.isArray(expect) ? expect : [expect];
  if (!allowed.includes(response.status)) {
    const shown = typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed)?.slice(0, 300);
    throw new Error(`${method} ${path} -> ${response.status} (expected ${allowed.join("/")}) ${shown ?? ""}`);
  }

  return { status: response.status, body: parsed as T };
}

const data = async (path: string, options: CallOptions = {}) => (await call(path, options)).body?.data;

/* ------------------------------------------------------------------ state -- */

const state: {
  guestToken?: string;
  guestId?: string;
  hostToken?: string;
  hostId?: string;
  adminToken?: string;
  listingId?: string;
  propertyId?: string;
  publicPropertyId?: string;
  ticketId?: string;
  bookingId?: string;
  threadId?: string;
} = {};

const guestEmail = `qa.guest.${STAMP}@roomeasy.test`;
const hostEmail = `qa.host.${STAMP}@roomeasy.test`;
const adminEmail = `qa.admin.${STAMP}@roomeasy.test`;
const PASSWORD = "QaPassword!2026";

function futureDate(daysFromNow: number): string {
  const date = new Date(Date.now() + daysFromNow * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function listingDraft(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: "",
    listingId: state.listingId ?? "",
    title: `QA test stay ${STAMP}`,
    category: "apartment",
    summary: "Created by the automated API test suite.",
    description: "This listing is created and deleted again by the automated API test suite.",
    location: { city: "Tunis", country: "Tunisia", postal: "1000", neighbourhood: "Lac 2" },
    capacity: { guests: 4, rooms: 2, beds: 3, baths: 1, area: 90 },
    amenities: ["wifi", "kitchen"],
    equipment: [],
    photos: ["https://images.roomeasy.fr/qa/test-stay.jpg"],
    pricing: {
      nightlyUsd: 120,
      cleaningFeeUsd: 20,
      minNights: 1,
      longStay: { enabled: false, threshold: 28, discount: 10 },
      mobile: { enabled: false, discount: 5 },
    },
    policies: {
      cancellationPolicy: "flexible",
      houseRules: "No parties.",
      checkIn: "15:00",
      checkOut: "11:00",
      instantBook: true,
    },
    status: "draft",
    ...overrides,
  };
}

/** Creates (or reuses) an administrator token; returns null in production where the helper is off. */
async function ensureAdmin(): Promise<string | null> {
  if (state.adminToken) return state.adminToken;
  const { status, body } = await call("/accounts/dev/admin", {
    method: "POST",
    body: { email: adminEmail, password: PASSWORD, fullName: "QA Admin" },
    expect: [200, 201, 403],
  });
  if (status === 403) return null;
  state.adminToken = body.data?.token;
  return state.adminToken ?? null;
}

/* ------------------------------------------------------------------ suite -- */

async function run() {
  console.log(c.bold(`\nRoomEasy API test suite`));
  console.log(c.grey(`target: ${API}\n`));

  section("Health and documentation");

  await test("GET /health answers ok", async () => {
    const payload = await data("/health");
    assert(payload?.status === "ok", "status is not ok");
  });

  await test("GET /health/ready reaches the database", async () => {
    const payload = await data("/health/ready");
    assert(payload?.status === "ready", "the database is not reachable");
  });

  await test("GET /docs/openapi.json is a valid OpenAPI document", async () => {
    const { body } = await call("/docs/openapi.json");
    assert(body?.openapi?.startsWith("3."), "openapi version missing");
    assert(Object.keys(body.paths ?? {}).length > 80, "too few documented paths");
    assert(body.components?.securitySchemes?.bearerAuth, "bearer security scheme missing");
  });

  await test("GET /docs serves the Swagger UI page", async () => {
    const response = await fetch(`${API}/docs`);
    const html = await response.text();
    assert(response.status === 200, `status ${response.status}`);
    assert(html.includes("SwaggerUIBundle"), "Swagger UI script missing");
  });

  await test("GET /docs/summary lists every documented operation", async () => {
    const payload = await data("/docs/summary");
    assert(payload.operations > 100, `only ${payload.operations} operations documented`);
    console.log(c.grey(`       ${payload.paths} paths / ${payload.operations} operations documented`));
  });

  section("Public catalogue (read)");

  await test("GET /stays returns a paginated search", async () => {
    const { body } = await call("/stays", { query: { limit: 5 } });
    assert(Array.isArray(body.data), "data is not a list");
    assert(typeof body.meta?.total === "number", "meta.total missing");
    state.publicPropertyId = body.data[0]?.id;
  });

  await test("GET /stays/categories returns counts", async () => {
    const payload = await data("/stays/categories");
    assert(payload && typeof payload === "object", "no category counts");
  });

  await test("GET /stays with filters is accepted", async () => {
    await call("/stays", {
      query: { where: "Tunis", minPrice: 10, maxPrice: 2000, guests: 2, sort: "price-low", locale: "fr", limit: 3 },
    });
  });

  await test("GET /stays rejects an inverted date range", async () => {
    const { body } = await call("/stays", { query: { from: futureDate(10), to: futureDate(5) }, expect: [400, 422] });
    assert(body?.error?.code, "no error code returned");
  });

  await test("GET /stays/{id} returns 404 for an unknown stay", async () => {
    await call("/stays/does-not-exist-" + STAMP, { expect: 404 });
  });

  await test("GET /equipment and /equipment/groups return the catalogue", async () => {
    const items = await data("/equipment");
    const groups = await data("/equipment/groups");
    assert(Array.isArray(items), "equipment catalogue is not a list");
    assert(groups && typeof groups === "object", "equipment groups missing");
  });

  await test("GET /settings returns public platform settings", async () => {
    const payload = await data("/settings");
    assert(payload && typeof payload === "object", "no settings returned");
  });

  await test("GET /currency/rates and /currency/convert work", async () => {
    const rates = await data("/currency/rates");
    assert(rates, "no rates returned");
    const converted = await data("/currency/convert", { query: { amountUsd: 100, to: "EUR" } });
    assert(converted, "conversion failed");
  });

  await test("GET /payments/config returns the publishable configuration", async () => {
    const payload = await data("/payments/config");
    assert(payload && typeof payload === "object", "no payment config");
  });

  section("Accounts (create, read, update)");

  await test("POST /accounts/signup creates a guest", async () => {
    const { status, body } = await call("/accounts/signup", {
      method: "POST",
      body: { fullName: "QA Guest", email: guestEmail, password: PASSWORD },
      expect: 201,
    });
    assert(status === 201, "signup did not return 201");
    assert(body.data?.token, "no token returned");
    state.guestToken = body.data.token;
    state.guestId = body.data.account.id;
  });

  await test("POST /accounts/signup rejects a duplicate address", async () => {
    await call("/accounts/signup", {
      method: "POST",
      body: { fullName: "QA Guest", email: guestEmail, password: PASSWORD },
      expect: [400, 409, 422],
    });
  });

  await test("POST /accounts/signup rejects a weak password", async () => {
    await call("/accounts/signup", {
      method: "POST",
      body: { fullName: "QA", email: `weak.${STAMP}@roomeasy.test`, password: "123" },
      expect: [400, 422],
    });
  });

  await test("POST /accounts/login returns a token", async () => {
    const payload = await data("/accounts/login", { method: "POST", body: { email: guestEmail, password: PASSWORD } });
    assert(payload.token, "no token");
    state.guestToken = payload.token;
  });

  await test("POST /accounts/login refuses a wrong password", async () => {
    await call("/accounts/login", { method: "POST", body: { email: guestEmail, password: "wrong-password" }, expect: 401 });
  });

  await test("GET /accounts/me needs a token", async () => {
    await call("/accounts/me", { expect: 401 });
  });

  await test("GET /accounts/me returns the account", async () => {
    const account = await data("/accounts/me", { token: state.guestToken });
    assert(account.email === guestEmail, "wrong account returned");
  });

  await test("PATCH /accounts/me updates the profile", async () => {
    const account = await data("/accounts/me", {
      method: "PATCH",
      token: state.guestToken,
      body: { fullName: "QA Guest Renamed", locale: "fr" },
    });
    assert(account.fullName === "QA Guest Renamed", "the name was not updated");
    assert(account.locale === "fr", "the language was not updated");
  });

  await test("POST /accounts/refresh issues a new token", async () => {
    const payload = await data("/accounts/refresh", { method: "POST", token: state.guestToken });
    assert(payload.token, "no refreshed token");
    state.guestToken = payload.token;
  });

  await test("GET /accounts/me/trust-badges works", async () => {
    const badges = await data("/accounts/me/trust-badges", { token: state.guestToken });
    assert(badges !== undefined, "no badges payload");
  });

  const PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await test("PUT /accounts/me/avatar needs a token", async () => {
    await call("/accounts/me/avatar", { method: "PUT", body: { dataUrl: PNG_DATA_URL }, expect: 401 });
  });

  await test("PUT /accounts/me/avatar refuses a non-image payload", async () => {
    await call("/accounts/me/avatar", {
      method: "PUT",
      token: state.guestToken,
      body: { dataUrl: "data:text/plain;base64,aGVsbG8=" },
      expect: [400, 415, 422],
    });
  });

  await test("PUT /accounts/me/avatar stores the profile photo", async () => {
    const account = await data("/accounts/me/avatar", {
      method: "PUT",
      token: state.guestToken,
      body: { dataUrl: PNG_DATA_URL },
    });
    assert(account.avatarUrl === `/api/accounts/${state.guestId}/avatar`, "avatarUrl was not linked");
  });

  await test("GET /accounts/:id/avatar serves the image publicly", async () => {
    const response = await fetch(`${API}/accounts/${state.guestId}/avatar`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert((response.headers.get("content-type") ?? "").startsWith("image/png"), "wrong content type");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length > 0 && bytes[0] === 0x89, "the stored bytes are not a PNG");
  });

  await test("DELETE /accounts/me/avatar removes the profile photo", async () => {
    const account = await data("/accounts/me/avatar", { method: "DELETE", token: state.guestToken });
    assert(!account.avatarUrl, "avatarUrl was not cleared");
    const response = await fetch(`${API}/accounts/${state.guestId}/avatar`);
    assert(response.status === 404, `expected 404 after removal, got ${response.status}`);
  });



  await test("POST /accounts/forgot-password never leaks whether the address exists", async () => {
    const known = await data("/accounts/forgot-password", { method: "POST", body: { email: guestEmail } });
    const unknown = await data("/accounts/forgot-password", {
      method: "POST",
      body: { email: `nobody.${STAMP}@roomeasy.test` },
    });
    assert(known.message === unknown.message, "the two answers differ");
  });

  await test("POST /accounts/cookie-consent is recorded", async () => {
    await call("/accounts/cookie-consent", {
      method: "POST",
      token: state.guestToken,
      body: { choice: "accepted", deviceId: `qa-${STAMP}` },
      expect: [200, 201, 204],
    });
  });

  section("Host account and listing CRUD");

  await test("POST /accounts/signup creates a host", async () => {
    const payload = (await call("/accounts/signup", {
      method: "POST",
      body: { fullName: "QA Host", email: hostEmail, password: PASSWORD, asHost: true },
      expect: 201,
    })).body.data;
    assert(payload.account.roles.includes("host"), "the host role is missing");
    state.hostToken = payload.token;
    state.hostId = payload.account.id;
  });

  await test("GET /listings is refused for a guest", async () => {
    await call("/listings", { token: state.guestToken, expect: 403 });
  });

  await test("CREATE: PUT /listings saves a new listing", async () => {
    const saved = await data("/listings", { method: "PUT", token: state.hostToken, body: listingDraft() });
    assert(saved.listingId, "no listing id returned");
    state.listingId = saved.listingId;
    state.propertyId = saved.propertyId ?? saved.property?.id ?? saved.listingId;
  });

  await test("PUT /listings rejects an invalid draft", async () => {
    await call("/listings", {
      method: "PUT",
      token: state.hostToken,
      body: listingDraft({ title: "no", pricing: { ...listingDraft().pricing, nightlyUsd: 1 } }),
      expect: [400, 422],
    });
  });

  await test("READ: GET /listings lists the host's own listings", async () => {
    const items = await data("/listings", { token: state.hostToken });
    assert(Array.isArray(items) && items.some((item: any) => item.listingId === state.listingId), "the new listing is missing");
  });

  await test("READ: GET /listings/{id} returns the listing", async () => {
    const listing = await data(`/listings/${state.listingId}`, { token: state.hostToken });
    assert(listing, "no listing returned");
  });

  await test("UPDATE: PUT /listings changes the title", async () => {
    const saved = await data("/listings", {
      method: "PUT",
      token: state.hostToken,
      body: listingDraft({ listingId: state.listingId, title: `QA test stay ${STAMP} updated` }),
    });
    assert(saved.listingId === state.listingId, "a second listing was created instead of an update");
  });

  await test("UPDATE: PATCH /listings/{id}/status publishes the listing", async () => {
    await call(`/listings/${state.listingId}/status`, {
      method: "PATCH",
      token: state.hostToken,
      body: { status: "published" },
    });
  });

  await test("UPDATE: an administrator approves the listing so it becomes bookable", async () => {
    const token = await ensureAdmin();
    if (!token) return;
    await call(`/admin/listings/${state.listingId}/approve`, { method: "POST", token, expect: [200, 204] });
  });

  await test("READ: GET /listings/{id}/history returns the submission trail", async () => {
    const history = await data(`/listings/${state.listingId}/history`, { token: state.hostToken });
    assert(history !== undefined, "no history payload");
  });

  await test("CRUD: listing calendar write, read and clear", async () => {
    const night = futureDate(30);
    await call(`/listings/${state.listingId}/calendar`, {
      method: "PUT",
      token: state.hostToken,
      body: { nights: [{ night, blocked: true }] },
    });
    const calendar = await data(`/listings/${state.listingId}/calendar`, { token: state.hostToken });
    assert(calendar !== undefined, "no calendar returned");
    await call(`/listings/${state.listingId}/calendar`, {
      method: "DELETE",
      token: state.hostToken,
      body: { nights: [night] },
      expect: [200, 204],
    });
  });

  await test("GET /listings/{id} is refused for another host", async () => {
    await call(`/listings/${state.listingId}`, { token: state.guestToken, expect: [403, 404] });
  });

  section("Host workspace (read and update)");

  for (const path of ["/host/profile", "/host/dashboard", "/host/earnings", "/host/payouts", "/host/rate-rules", "/host/team"]) {
    await test(`GET ${path}`, async () => {
      const payload = await data(path, { token: state.hostToken });
      assert(payload !== undefined, "empty payload");
    });
  }

  await test("PATCH /host/profile updates the public profile", async () => {
    const profile = await data("/host/profile", {
      method: "PATCH",
      token: state.hostToken,
      body: { displayName: `QA Host ${STAMP}` },
    });
    assert(profile, "no profile returned");
  });

  section("Favourites CRUD");

  await test("CREATE + READ: save a stay and read it back", async () => {
    const target = state.propertyId ?? state.publicPropertyId;
    assert(target, "no stay available to save");
    await call(`/favorites/${target}`, { method: "PUT", token: state.guestToken });
    const ids = await data("/favorites/ids", { token: state.guestToken });
    assert(Array.isArray(ids) && ids.includes(target), "the stay was not saved");
  });

  await test("READ: GET /favorites returns the saved stays in full", async () => {
    const items = await data("/favorites", { token: state.guestToken });
    assert(Array.isArray(items), "favourites is not a list");
  });

  await test("UPDATE: POST /favorites/sync merges offline favourites", async () => {
    const target = state.propertyId ?? state.publicPropertyId;
    const payload = await data("/favorites/sync", {
      method: "POST",
      token: state.guestToken,
      body: { propertyIds: [target] },
    });
    assert(payload !== undefined, "sync returned nothing");
  });

  await test("DELETE: remove the saved stay", async () => {
    const target = state.propertyId ?? state.publicPropertyId;
    await call(`/favorites/${target}`, { method: "DELETE", token: state.guestToken, expect: [200, 204] });
    const ids = await data("/favorites/ids", { token: state.guestToken });
    assert(!ids.includes(target), "the stay is still saved");
  });

  await test("Favourites need a token", async () => {
    await call("/favorites/ids", { expect: 401 });
  });

  section("Bookings life-cycle");

  await test("GET /bookings/availability answers for the new listing", async () => {
    const payload = await data("/bookings/availability", {
      query: { propertyId: state.propertyId, from: futureDate(40), to: futureDate(43) },
    });
    assert(payload !== undefined, "no availability payload");
  });

  await test("GET /bookings/quote prices the stay", async () => {
    const quote = await data("/bookings/quote", {
      query: { propertyId: state.propertyId, from: futureDate(40), to: futureDate(43), guests: 2 },
    });
    assert(quote, "no quote returned");
  });

  await test("GET /bookings/quote rejects an inverted range", async () => {
    await call("/bookings/quote", {
      query: { propertyId: state.propertyId, from: futureDate(43), to: futureDate(40) },
      expect: [400, 422],
    });
  });

  await test("CREATE: POST /bookings books the stay", async () => {
    const { body } = await call("/bookings", {
      method: "POST",
      token: state.guestToken,
      body: {
        propertyId: state.propertyId,
        from: futureDate(40),
        to: futureDate(43),
        guests: 2,
        message: "QA booking",
        guest: { name: "QA Guest", email: guestEmail, phone: "+21600000000" },
        card: { number: "4242424242424242", name: "QA Guest", expiry: "12/30", cvc: "123" },
      },
      expect: [200, 201],
    });
    state.bookingId = body.data?.id ?? body.data?.bookingId;
    assert(state.bookingId, "no booking id returned");
  });

  await test("READ: GET /bookings lists the guest's bookings", async () => {
    const items = await data("/bookings", { token: state.guestToken });
    assert(Array.isArray(items), "bookings is not a list");
  });

  await test("READ: GET /bookings/host lists the host's bookings", async () => {
    const items = await data("/bookings/host", { token: state.hostToken });
    assert(Array.isArray(items), "host bookings is not a list");
  });

  await test("READ: GET /bookings/{id} returns the booking", async () => {
    const booking = await data(`/bookings/${state.bookingId}`, { token: state.guestToken });
    assert(booking, "no booking returned");
  });

  await test("GET /bookings/{id} is refused for an unrelated account", async () => {
    const stranger = (await call("/accounts/signup", {
      method: "POST",
      body: { fullName: "QA Stranger", email: `qa.stranger.${STAMP}@roomeasy.test`, password: PASSWORD },
      expect: 201,
    })).body.data.token;
    await call(`/bookings/${state.bookingId}`, { token: stranger, expect: [401, 403, 404] });
  });

  await test("DELETE (cancel): POST /bookings/{id}/cancel", async () => {
    await call(`/bookings/${state.bookingId}/cancel`, {
      method: "POST",
      token: state.guestToken,
      body: { reason: "Automated test cleanup" },
      expect: [200, 204],
    });
  });

  section("Messaging CRUD");

  await test("CREATE: POST /messaging/threads starts a conversation", async () => {
    const thread = await data("/messaging/threads", {
      method: "POST",
      token: state.guestToken,
      body: { propertyId: state.propertyId, body: "Hello from the automated test suite." },
    });
    state.threadId = thread?.id ?? thread?.threadId;
    assert(state.threadId, "no thread id returned");
  });

  await test("READ: GET /messaging/threads and /messaging/unread", async () => {
    const threads = await data("/messaging/threads", { token: state.guestToken });
    assert(Array.isArray(threads), "threads is not a list");
    const unread = await data("/messaging/unread", { token: state.guestToken });
    assert(unread !== undefined, "no unread payload");
  });

  await test("CREATE: POST /messaging/threads/{id}/messages sends a reply", async () => {
    await call(`/messaging/threads/${state.threadId}/messages`, {
      method: "POST",
      token: state.hostToken,
      body: { body: "Host reply from the automated test suite." },
      expect: [200, 201],
    });
  });

  await test("READ: GET /messaging/threads/{id} returns the messages", async () => {
    const thread = await data(`/messaging/threads/${state.threadId}`, { token: state.guestToken });
    assert(thread, "no thread returned");
  });

  await test("UPDATE: mark read and archive the conversation", async () => {
    await call(`/messaging/threads/${state.threadId}/read`, { method: "POST", token: state.guestToken, expect: [200, 204] });
    await call(`/messaging/threads/${state.threadId}`, {
      method: "PATCH",
      token: state.guestToken,
      body: { closed: true },
      expect: [200, 204],
    });
  });

  await test("POST /messaging/threads/{id}/messages rejects an empty message", async () => {
    await call(`/messaging/threads/${state.threadId}/messages`, {
      method: "POST",
      token: state.guestToken,
      body: { body: "" },
      expect: [400, 422],
    });
  });

  section("Support tickets CRUD");

  await test("CREATE: POST /support/tickets opens a ticket", async () => {
    const ticket = await data("/support/tickets", {
      method: "POST",
      token: state.guestToken,
      body: {
        subject: `QA ticket ${STAMP}`,
        category: "other",
        body: "Opened by the automated API test suite to verify the support flow.",
      },
      expect: [200, 201],
    });
    state.ticketId = ticket?.id ?? ticket?.ticketId;
    assert(state.ticketId, "no ticket id returned");
  });

  await test("READ: GET /support/tickets lists the tickets", async () => {
    const items = await data("/support/tickets", { token: state.guestToken });
    assert(Array.isArray(items), "tickets is not a list");
  });

  await test("READ: GET /support/tickets/{id} returns the ticket", async () => {
    const ticket = await data(`/support/tickets/${state.ticketId}`, { token: state.guestToken });
    assert(ticket, "no ticket returned");
  });

  await test("UPDATE: POST /support/tickets/{id}/messages adds a reply", async () => {
    await call(`/support/tickets/${state.ticketId}/messages`, {
      method: "POST",
      token: state.guestToken,
      body: { body: "Follow-up message from the automated test suite." },
      expect: [200, 201, 204],
    });
  });

  await test("CREATE: POST /support/reports reports a listing", async () => {
    await call("/support/reports", {
      method: "POST",
      token: state.guestToken,
      body: { listingId: state.listingId, reason: "other", details: "Automated test report." },
      expect: [200, 201, 204],
    });
  });

  await test("Support tickets need a token", async () => {
    await call("/support/tickets", { expect: 401 });
  });

  section("Reviews");

  await test("GET /reviews/mine/written and /reviews/mine/pending", async () => {
    assert((await data("/reviews/mine/written", { token: state.guestToken })) !== undefined, "no written reviews payload");
    assert((await data("/reviews/mine/pending", { token: state.guestToken })) !== undefined, "no pending reviews payload");
  });

  await test("GET /reviews/host/received", async () => {
    assert((await data("/reviews/host/received", { token: state.hostToken })) !== undefined, "no received reviews payload");
  });

  await test("POST /reviews refuses a review without a completed stay", async () => {
    await call("/reviews", {
      method: "POST",
      token: state.guestToken,
      body: { bookingId: state.bookingId, rating: 5, comment: "Automated test review." },
      expect: [400, 403, 404, 409, 422],
    });
  });

  section("Administration");

  await test("POST /accounts/dev/admin creates an administrator (development only)", async () => {
    const token = await ensureAdmin();
    if (!token) {
      console.log(c.grey("       the helper is disabled in production — admin routes are checked for 401/403 instead"));
      return;
    }
    assert(token, "no admin token returned");
  });

  await test("Admin routes refuse a guest token", async () => {
    await call("/admin/overview", { token: state.guestToken, expect: 403 });
    await call("/admin/users", { expect: 401 });
  });

  const adminReads = [
    "/admin/me",
    "/admin/overview",
    "/admin/reports",
    "/admin/listings",
    "/admin/users",
    "/admin/moderation-log",
    "/admin/reviews",
    "/admin/bookings",
    "/admin/payouts",
    "/admin/listing-reports",
    "/admin/verifications",
    "/admin/commissions",
    "/admin/tickets",
    "/admin/notifications",
    "/admin/email/status",
    "/settings/admin",
  ];

  for (const path of adminReads) {
    await test(`GET ${path}`, async () => {
      if (!state.adminToken) {
        await call(path, { expect: 401 });
        return;
      }
      const payload = await data(path, { token: state.adminToken });
      assert(payload !== undefined, "empty payload");
    });
  }

  await test("UPDATE: admin approves and suspends the test listing", async () => {
    if (!state.adminToken) return;
    await call(`/admin/listings/${state.listingId}/suspend`, {
      method: "POST",
      token: state.adminToken,
      body: { reason: "Automated test" },
      expect: [200, 204],
    });
    await call(`/admin/listings/${state.listingId}/restore`, { method: "POST", token: state.adminToken, expect: [200, 204] });
  });

  await test("UPDATE: admin suspends and restores the test guest", async () => {
    if (!state.adminToken) return;
    await call(`/admin/users/${state.guestId}/suspend`, {
      method: "POST",
      token: state.adminToken,
      body: { reason: "Automated test" },
      expect: [200, 204],
    });
    await call(`/admin/users/${state.guestId}/restore`, { method: "POST", token: state.adminToken, expect: [200, 204] });
  });

  await test("UPDATE: admin sets a host commission", async () => {
    if (!state.adminToken) return;
    await call(`/admin/commissions/${state.hostId}`, {
      method: "PUT",
      token: state.adminToken,
      body: { commissionRate: 12 },
      expect: [200, 204],
    });
  });

  await test("UPDATE: admin answers the support ticket", async () => {
    if (!state.adminToken || !state.ticketId) return;
    await call(`/admin/tickets/${state.ticketId}/messages`, {
      method: "POST",
      token: state.adminToken,
      body: { body: "Answer from the automated test suite." },
      expect: [200, 201, 204],
    });
    await call(`/admin/tickets/${state.ticketId}/status`, {
      method: "POST",
      token: state.adminToken,
      body: { status: "resolved" },
      expect: [200, 204],
    });
  });

  await test("GET /admin/stats/export.csv returns a CSV file", async () => {
    if (!state.adminToken) return;
    const response = await fetch(`${API}/admin/stats/export.csv`, {
      headers: { authorization: `Bearer ${state.adminToken}` },
    });
    assert(response.status === 200, `status ${response.status}`);
    const text = await response.text();
    assert(text.includes(","), "the export does not look like CSV");
  });

  section("Cleanup");

  await test("DELETE: remove the test listing", async () => {
    if (!state.listingId) return;
    // A listing with bookings attached is kept on purpose: the API refuses the delete.
    await call(`/listings/${state.listingId}`, { method: "DELETE", token: state.hostToken, expect: [200, 204, 409, 422] });
  });

  await test("Unknown routes answer 404 in the standard error shape", async () => {
    const { body } = await call(`/definitely-not-a-route-${STAMP}`, { expect: 404 });
    assert(body?.error?.code, "no error envelope");
  });

  /* ---------------------------------------------------------------- report */

  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  const duration = results.reduce((total, result) => total + result.ms, 0);

  console.log(`\n${c.bold("Summary")}`);
  console.log(`  target   ${API}`);
  console.log(`  tests    ${results.length}`);
  console.log(`  passed   ${c.green(String(passed))}`);
  console.log(`  failed   ${failed.length ? c.red(String(failed.length)) : "0"}`);
  console.log(`  duration ${duration}ms`);

  if (failed.length) {
    console.log(`\n${c.red("Failures")}`);
    for (const result of failed) console.log(`  - [${result.group}] ${result.name}: ${result.detail}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${c.green("Every endpoint behaved as documented.")}\n`);
  }
}

run().catch((error) => {
  console.error(c.red(`the suite could not run: ${error instanceof Error ? error.message : String(error)}`));
  console.error(c.grey(`is the API running at ${API}?`));
  process.exit(1);
});
