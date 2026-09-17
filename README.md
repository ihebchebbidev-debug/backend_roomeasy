# Nestara backend

Node.js + Express + PostgreSQL API serving the whole stay-rental front end:
guest search and booking, the host dashboard and listing wizard, messaging,
reviews, payouts, the admin console and platform settings.

TypeScript, ES modules, one folder per group of functionality.

---

## Quick start

```bash
cd nodejs_backend
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
npm install
npm run seed                  # creates the schema + reference data (+ demo logins)
npm run dev                   # http://localhost:4000
```

Check it is alive:

```bash
curl http://localhost:4000/api/health
curl http://localhost:4000/api/health/ready   # also proves the database answers
```

### Scripts

| Script            | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `npm run dev`     | Watch mode (tsx), reconciles the schema on boot                      |
| `npm run build`   | Compiles to `dist/`                                                  |
| `npm start`       | Runs the compiled server                                             |
| `npm run typecheck` | Type check only                                                    |
| `npm run migrate` | Reconciles the database schema and exits                             |
| `npm run seed`    | Reference data (amenities, settings, badge rule) + demo accounts      |

---

## Configuration

Every variable lives in `.env` (see `.env.example`). The important ones:

- `DATABASE_URL` — full Postgres connection string. If empty, the discrete
  `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` values are used.
- `JWT_SECRET` — **required**, at least 32 characters. The server refuses to
  start without it.
- `CORS_ORIGINS` — comma-separated list of browser origins allowed to call the API.
- `AUTO_MIGRATE` — reconcile the schema on boot (default on).
- `AUTO_HEAL` — repair the schema mid-request if a query hits a missing table
  or column, then retry the query once (default on).
- `LOG_LEVEL`, `LOG_PRETTY`, `LOG_DIR` — logging behaviour.

Invalid configuration fails fast at startup with a list of what is wrong.

---

## Automatic migrations

The schema is declared in code under `src/db/registry/` (`accounts`,
`listings`, `bookings`, `social`, `platform`, plus enums, views and
finalisers). On boot — and on `npm run migrate` — `reconcileSchema()` compares
the declaration with the live database and creates whatever is missing:

extensions → enum types (and new values) → functions → tables → **columns** →
defaults and not-null → constraints → indexes → triggers → views → finalisers.

It only ever adds; it never drops a column or a table, so no data is lost.
Each run is recorded in the `schema_migration_run` table.

If a request reaches a column that does not exist yet (for example right after
adding a field), the query layer detects the Postgres error, runs the
reconciler once and retries the query. That is `AUTO_HEAL`; turn it off in
production if you prefer migrations to be an explicit deployment step.

---

## Logging

Pino, one line per request, with the request id, method, path, status,
duration and the signed-in user id. Development prints colourised output;
production emits JSON and also writes daily files into `LOG_DIR`. Passwords,
tokens, card numbers and authorization headers are redacted automatically.
Every response carries an `x-request-id` header — quote it when reporting a
problem and the matching log lines can be found instantly.

---

## Errors

Every failure returns the same envelope:

```json
{
  "error": {
    "code": "DATES_UNAVAILABLE",
    "message": "Those nights are already booked. Pick different dates.",
    "details": { "unavailable": ["2026-04-11"] },
    "requestId": "b1f2…"
  }
}
```

Codes come from a single catalogue (`src/core/errors.ts`) so the front end can
branch on `code` while the `message` is already written for the guest or host.
Validation failures list the exact field and the reason.

---

## API map

Base path `/api`. Authentication is `Authorization: Bearer <access token>`.

| Area | Prefix | Highlights |
| --- | --- | --- |
| Accounts | `/accounts` | sign-up, sign-in, refresh, profile, password change, reset, become a host, cookie consent, trust badges |
| Stays (public) | `/stays` | search with filters and sorting, category counts, stay detail, reviews, public availability |
| Equipment | `/equipment` | amenity catalogue and counts per group |
| Saved stays | `/favorites` | list, add, remove, sync from the browser |
| Listings (host) | `/listings` | wizard create/update, publish, unpublish, delete, edit history, calendar blocking and price overrides |
| Bookings | `/bookings` | availability check, price quote, checkout, guest/host lists, accept/decline, cancellation with refunds |
| Reviews | `/reviews` | write, edit, host reply, stays waiting for a review, received reviews |
| Host area | `/host` | host profile, dashboard figures, monthly earnings, payout onboarding, payouts, rate rules, team members |
| Messaging | `/messaging` | inbox, unread badge, thread detail, start a conversation, send, mark read, close/reopen |
| Admin | `/admin` | overview, listing approvals, users and roles, moderation log, review moderation, bookings, payouts, reports |
| Settings | `/settings` | platform fees and rates (public read, admin write) |
| Currency | `/currency` | cached USD exchange rates, conversion helper, admin refresh |

Responses are always `{ "data": … }`, with `{ "meta": … }` added for paginated
lists (`total`, `limit`, `offset`).

---

## Project layout

```
src/
  app.ts                 Express app (security, CORS, parsing, logging, routing)
  server.ts              Boot: migrate → listen → graceful shutdown
  routes.ts              Where every module is mounted
  config/env.ts          Validated configuration
  core/                  errors, http helpers, logger, validation, id helpers
  middleware/            request context, auth, roles, rate limiting, error handler
  db/                    pool, query gateway, migrate, registry (schema as code), CLIs, seed data
  modules/<feature>/     <feature>.routes.ts + <feature>.repository.ts
```

A module never reaches into another module's tables directly; it calls that
module's repository.

---

## Demo logins

Created by `npm run seed` outside production:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@nestara.test` | `Admin!2345` |
| Host | `host@nestara.test` | `Host!2345` |
| Guest | `guest@nestara.test` | `Guest!2345` |

Remove them before going live.
