import { accountTables } from "@/db/registry/accounts.js";
import { adminTables } from "@/db/registry/admin.js";
import { bookingTables } from "@/db/registry/bookings.js";
import { enums } from "@/db/registry/enums.js";
import { functions } from "@/db/registry/functions.js";
import { listingTables } from "@/db/registry/listings.js";
import { platformTables } from "@/db/registry/platform.js";
import { socialTables } from "@/db/registry/social.js";
import type { SchemaDefinition, TableDef, ViewDef } from "@/db/registry/types.js";

/**
 * Tables are created in dependency order. Foreign keys are added in a second
 * pass by the migrator, so the order only has to be *roughly* right.
 */
const orderedTables: TableDef[] = [
  ...accountTables.filter((table) => table.name !== "favorite"),
  ...listingTables,
  ...bookingTables,
  ...socialTables,
  ...platformTables,
  ...adminTables,
  ...accountTables.filter((table) => table.name === "favorite"),
];

const views: ViewDef[] = [
  { name: "public_review", definition: "SELECT * FROM review WHERE hidden = false" },
  {
    name: "thread_unread_count",
    definition: "SELECT thread_id, count(*) FILTER (WHERE read_at IS NULL) AS unread FROM message GROUP BY thread_id",
  },
  {
    name: "trust_badge_eligibility",
    definition: `SELECT u.id AS user_id,
                        r.code,
                        count(b.id) AS qualifying_reservations,
                        r.min_reservations,
                        count(b.id) >= r.min_reservations
                          AND (NOT r.requires_verified_account OR u.verified) AS eligible
                   FROM app_user u
                   CROSS JOIN trust_badge_rule r
                   LEFT JOIN booking b
                     ON b.guest_id = u.id
                    AND b.status = 'completed'
                    AND b.check_out >= (CURRENT_DATE - make_interval(months => r.window_months))
                  WHERE r.active
                  GROUP BY u.id, r.code, r.min_reservations, r.requires_verified_account, u.verified`,
  },
  {
    name: "host_listing_view",
    definition: `SELECT l.id AS listing_id, l.property_id, l.status, l.approved, l.nightly_usd,
                        l.long_stay_enabled, l.long_stay_threshold, l.long_stay_discount,
                        l.mobile_enabled, l.mobile_discount,
                        p.host_id, p.name, p.city, p.country, p.category, p.guests, p.rating, p.review_count
                   FROM listing l
                   JOIN property p ON p.id = l.property_id`,
  },
];

/** Triggers and one-off guards applied after every table exists. */
const finalisers: string[] = [
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'review_rating_sync') THEN
       CREATE TRIGGER review_rating_sync AFTER INSERT OR UPDATE OR DELETE ON review
         FOR EACH ROW EXECUTE FUNCTION refresh_property_rating();
     END IF;
   END $$;`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'property_photo_limit') THEN
       CREATE CONSTRAINT TRIGGER property_photo_limit
         AFTER INSERT ON property_photo DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION enforce_photo_limit();
     END IF;
   END $$;`,
  `INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;`,
  `INSERT INTO trust_badge_rule (code, min_reservations, window_months, notes)
     VALUES ('genuse', 5, 24, 'Provisional rule: 5 completed reservations within 24 months.')
     ON CONFLICT (code) DO NOTHING;`,
];

export const schemaDefinition: SchemaDefinition = {
  extensions: ["pgcrypto", "btree_gist"],
  enums,
  functions,
  tables: orderedTables,
  views,
  finalisers,
};

export const tableByName = new Map(orderedTables.map((table) => [table.name, table]));
