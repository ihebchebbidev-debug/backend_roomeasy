/**
 * Demo dataset generator.
 *
 * Builds a realistic, fully-populated French marketplace: hosts, guests,
 * staff, 54 listings, bookings across the last 14 months, payments, reviews,
 * payouts, messages, favourites, support tickets, reports, verifications and
 * moderation history — enough for every admin KPI to show real numbers.
 *
 * Every row it writes is prefixed `demo-` or uses an `@demo.roomeasy.fr`
 * address, so `seedDemoData()` can wipe and rebuild it safely at any time.
 */
import bcrypt from "bcryptjs";

import { log } from "@/core/logger.js";
import { query, queryOne } from "@/db/query.js";

const logger = log("seed-demo");

export const DEMO_EMAIL_DOMAIN = "demo.roomeasy.fr";
export const DEMO_PASSWORD = "Demo1234!";

/* ----------------------------------------------------------------- helpers */

/** Deterministic PRNG so two runs produce the same dataset. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = makeRandom(20260917);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const pickSome = <T,>(items: readonly T[], count: number): T[] => {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return out;
};
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const money = (value: number) => Math.round(value * 100) / 100;

const DAY = 86_400_000;
const today = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const daysAgo = (days: number) => addDays(today, -days);

/* -------------------------------------------------------------- vocabulary */

const FIRST_NAMES = [
  "Camille", "Lucas", "Chloé", "Hugo", "Léa", "Nathan", "Manon", "Enzo", "Emma", "Théo",
  "Inès", "Gabriel", "Jade", "Raphaël", "Louise", "Arthur", "Alice", "Adam", "Lina", "Paul",
  "Sarah", "Antoine", "Julie", "Maxime", "Clara", "Benoît", "Amélie", "Mathis", "Élodie", "Victor",
  "Noémie", "Quentin", "Sophie", "Damien", "Margaux", "Julien", "Anaïs", "Pierre", "Céline", "Rémi",
];

const LAST_NAMES = [
  "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit", "Durand", "Leroy", "Moreau",
  "Simon", "Laurent", "Lefebvre", "Michel", "Garcia", "David", "Bertrand", "Roux", "Vincent", "Fournier",
  "Morel", "Girard", "André", "Lefèvre", "Mercier", "Dupont", "Lambert", "Bonnet", "François", "Martinez",
];

type City = { city: string; region: string; postal: string; lat: number; lng: number };

const CITIES: City[] = [
  { city: "Paris", region: "Île-de-France", postal: "75011", lat: 48.8566, lng: 2.3522 },
  { city: "Lyon", region: "Auvergne-Rhône-Alpes", postal: "69002", lat: 45.764, lng: 4.8357 },
  { city: "Marseille", region: "Provence-Alpes-Côte d'Azur", postal: "13006", lat: 43.2965, lng: 5.3698 },
  { city: "Bordeaux", region: "Nouvelle-Aquitaine", postal: "33000", lat: 44.8378, lng: -0.5792 },
  { city: "Nice", region: "Provence-Alpes-Côte d'Azur", postal: "06000", lat: 43.7102, lng: 7.262 },
  { city: "Toulouse", region: "Occitanie", postal: "31000", lat: 43.6047, lng: 1.4442 },
  { city: "Nantes", region: "Pays de la Loire", postal: "44000", lat: 47.2184, lng: -1.5536 },
  { city: "Strasbourg", region: "Grand Est", postal: "67000", lat: 48.5734, lng: 7.7521 },
  { city: "Lille", region: "Hauts-de-France", postal: "59000", lat: 50.6292, lng: 3.0573 },
  { city: "Montpellier", region: "Occitanie", postal: "34000", lat: 43.6108, lng: 3.8767 },
  { city: "Annecy", region: "Auvergne-Rhône-Alpes", postal: "74000", lat: 45.8992, lng: 6.1294 },
  { city: "Biarritz", region: "Nouvelle-Aquitaine", postal: "64200", lat: 43.4832, lng: -1.5586 },
  { city: "Chamonix", region: "Auvergne-Rhône-Alpes", postal: "74400", lat: 45.9237, lng: 6.8694 },
  { city: "Cannes", region: "Provence-Alpes-Côte d'Azur", postal: "06400", lat: 43.5528, lng: 7.0174 },
  { city: "Saint-Malo", region: "Bretagne", postal: "35400", lat: 48.6493, lng: -2.0257 },
  { city: "Colmar", region: "Grand Est", postal: "68000", lat: 48.0794, lng: 7.3585 },
  { city: "Avignon", region: "Provence-Alpes-Côte d'Azur", postal: "84000", lat: 43.9493, lng: 4.8055 },
  { city: "La Rochelle", region: "Nouvelle-Aquitaine", postal: "17000", lat: 46.1591, lng: -1.1520 },
];

const CATEGORIES = ["apartment", "villa", "studio", "chalet", "guesthouse", "lodge", "bungalow", "hotel"] as const;

const TITLE_PREFIX: Record<string, string[]> = {
  apartment: ["Appartement lumineux", "Appartement design", "Bel appartement haussmannien", "Duplex contemporain"],
  villa: ["Villa avec piscine", "Villa familiale", "Villa vue mer", "Grande villa au calme"],
  studio: ["Studio cosy", "Studio moderne", "Studio d'artiste", "Petit studio rénové"],
  chalet: ["Chalet en bois", "Chalet au pied des pistes", "Chalet montagne & spa", "Chalet chaleureux"],
  guesthouse: ["Maison d'hôtes de charme", "Maison d'hôtes au jardin", "Maison d'hôtes conviviale"],
  lodge: ["Lodge nature", "Lodge au bord de l'eau", "Lodge écologique"],
  bungalow: ["Bungalow au jardin", "Bungalow bord de plage", "Bungalow tout confort"],
  hotel: ["Suite d'hôtel centre-ville", "Chambre d'hôtel élégante", "Suite avec terrasse"],
};

const NEIGHBOURHOODS = [
  "Centre historique", "Vieille ville", "Quartier des Halles", "Bord de mer", "Rive gauche",
  "Quartier latin", "Près de la gare", "Quartier des musées", "Port de plaisance", "Colline verte",
];

const SUMMARIES = [
  "Un logement soigné, à quelques minutes à pied des commerces et des transports.",
  "Idéal pour un séjour en famille : lumineux, calme et parfaitement équipé.",
  "Une adresse de charme avec vue dégagée et petit-déjeuner possible sur demande.",
  "Rénové récemment, avec cuisine complète, wifi fibre et espace de travail.",
  "Le point de départ parfait pour découvrir la ville et sa région.",
];

const DESCRIPTIONS = [
  "Vous serez accueilli dans un intérieur clair et chaleureux : grand séjour, cuisine entièrement équipée, literie de qualité et rangements pour un séjour long. Le quartier est vivant, bien desservi, avec marché, boulangerie et restaurants à moins de cinq minutes. Le logement est nettoyé par une équipe professionnelle entre chaque séjour et un guide de la ville vous attend à l'arrivée.",
  "Ce logement mêle matériaux naturels et confort moderne : parquet, grandes fenêtres, chauffage performant et connexion internet rapide. Vous disposez d'un coin bureau, d'une machine à laver et de tout le nécessaire pour cuisiner. Les hôtes répondent rapidement et peuvent organiser l'arrivée autonome à toute heure.",
  "Un espace pensé pour se reposer après la visite : terrasse ensoleillée, mobilier extérieur, salon confortable et chambres calmes sur cour. Les plages, sentiers et sites touristiques principaux sont accessibles en quelques minutes. Parking gratuit à proximité immédiate.",
];

const HOUSE_RULES = [
  "Non-fumeur. Animaux acceptés sur demande. Calme demandé après 22 h.",
  "Arrivée autonome possible. Merci de laisser le logement en bon état au départ.",
  "Pas de fête ni d'évènement. Deux visiteurs maximum en journée.",
];

const AMENITIES = ["wifi", "pool", "kitchen", "parking", "airConditioning", "workspace", "petFriendly", "breakfast"] as const;

const REVIEW_BODIES = [
  "Séjour parfait, logement conforme aux photos et hôte très réactif. Je recommande vivement.",
  "Très bon emplacement, appartement propre et bien équipé. Nous reviendrons sans hésiter.",
  "Accueil chaleureux, arrivée facile et quartier agréable. Un excellent rapport qualité-prix.",
  "Logement spacieux et calme, idéal pour une famille. Quelques bruits de rue le matin, sans plus.",
  "Tout était impeccable : literie confortable, cuisine complète et wifi rapide.",
  "Bon séjour dans l'ensemble. Le chauffage était un peu lent à monter en température.",
];

const REVIEW_REPLIES = [
  "Merci beaucoup pour votre retour, ce fut un plaisir de vous accueillir !",
  "Merci pour votre passage, à très bientôt dans la région.",
];

const GUEST_MESSAGES = [
  "Bonjour, est-il possible d'arriver un peu plus tard, vers 21 h ?",
  "Bonjour, y a-t-il un parking à proximité du logement ?",
  "Merci pour l'accueil, tout était parfait !",
  "Bonjour, le logement dispose-t-il d'un lit bébé ?",
];

const HOST_MESSAGES = [
  "Bonjour et bienvenue ! Oui, l'arrivée tardive est possible, je vous envoie le code de la boîte à clés.",
  "Bonjour, un parking public se trouve à 150 m, et la rue est gratuite le week-end.",
  "Merci à vous, vous êtes les bienvenus quand vous voulez !",
];

const TICKET_SUBJECTS = [
  "Problème de remboursement après annulation",
  "Le chauffage ne fonctionne pas",
  "Demande de facture pour un séjour professionnel",
  "Modification des dates de réservation",
  "Litige sur la caution",
  "Paiement refusé au moment de la réservation",
];

const REPORT_DETAILS = [
  "Les photos ne correspondent pas au logement réellement proposé.",
  "L'annonce demande un paiement en dehors de la plateforme.",
  "Le logement était indisponible à l'arrivée.",
];

/* -------------------------------------------------------------------- wipe */

async function wipeDemoData(): Promise<void> {
  const statements = [
    `DELETE FROM payout_item WHERE payout_id LIKE 'demo-%'`,
    `DELETE FROM payout WHERE id LIKE 'demo-%'`,
    `DELETE FROM support_ticket_message WHERE ticket_id IN (SELECT id FROM support_ticket WHERE reference LIKE 'DEMO-%')`,
    `DELETE FROM support_ticket WHERE reference LIKE 'DEMO-%'`,
    `DELETE FROM listing_report WHERE listing_id LIKE 'demo-%'`,
    `DELETE FROM review WHERE id LIKE 'demo-%'`,
    `DELETE FROM message WHERE thread_id LIKE 'demo-%'`,
    `DELETE FROM message_thread WHERE id LIKE 'demo-%'`,
    `DELETE FROM booking_refund WHERE booking_id LIKE 'demo-%'`,
    `DELETE FROM booking_cancellation WHERE booking_id LIKE 'demo-%'`,
    `DELETE FROM payment WHERE booking_id LIKE 'demo-%'`,
    `DELETE FROM booking_discount WHERE booking_id LIKE 'demo-%'`,
    `DELETE FROM booking WHERE id LIKE 'demo-%'`,
    `DELETE FROM listing_submission WHERE listing_id LIKE 'demo-%'`,
    `DELETE FROM listing WHERE id LIKE 'demo-%'`,
    `DELETE FROM property WHERE id LIKE 'demo-%'`,
    `DELETE FROM notification_outbox WHERE recipient_email LIKE '%@${DEMO_EMAIL_DOMAIN}'`,
    // The audit log is append-only; the demo wipe opts in for its own rows only.
    `WITH m AS (SELECT set_config('app.audit_maintenance', 'on', true) AS on_)
     DELETE FROM moderation_log WHERE target_id LIKE 'demo-%' AND (SELECT on_ FROM m) = 'on'`,
    `DELETE FROM booking_monthly_stat WHERE host_id IN (SELECT id FROM app_user WHERE email LIKE '%@${DEMO_EMAIL_DOMAIN}')`,
    `DELETE FROM app_user WHERE email LIKE '%@${DEMO_EMAIL_DOMAIN}'`,
  ];
  for (const sql of statements) {
    await query(sql, [], { label: "seed-demo.wipe" });
  }
}

/* ------------------------------------------------------------------ people */

type Person = { id: string; fullName: string; email: string };

async function insertUser(options: {
  fullName: string;
  email: string;
  passwordHash: string;
  roles: string[];
  verified: boolean;
  suspended?: boolean;
  banned?: boolean;
  joinedDaysAgo: number;
  locale?: string;
}): Promise<Person> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO app_user (full_name, email, phone, password_hash, verified, suspended, suspended_reason,
                           banned, banned_reason, banned_at, avatar_url, locale, currency, joined_on, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'EUR', $13, $14)
     RETURNING id`,
    [
      options.fullName,
      options.email,
      `+33 6 ${between(10, 99)} ${between(10, 99)} ${between(10, 99)} ${between(10, 99)}`,
      options.passwordHash,
      options.verified,
      options.suspended ?? false,
      options.suspended ? "Comportement signalé par plusieurs voyageurs" : null,
      options.banned ?? false,
      options.banned ? "Fraude au paiement confirmée" : null,
      options.banned ? daysAgo(between(5, 60)).toISOString() : null,
      null,
      options.locale ?? "fr",
      iso(daysAgo(options.joinedDaysAgo)),
      daysAgo(between(0, 20)).toISOString(),
    ],
    { label: "seed-demo.user" },
  );
  const id = row!.id;
  for (const role of options.roles) {
    await query(`INSERT INTO user_role_grant (user_id, role) VALUES ($1, $2::user_role) ON CONFLICT DO NOTHING`, [id, role], {
      label: "seed-demo.role",
    });
  }
  return { id, fullName: options.fullName, email: options.email };
}

/* ---------------------------------------------------------------- the seed */

export type DemoSeedReport = {
  hosts: number;
  guests: number;
  staff: number;
  listings: number;
  bookings: number;
  reviews: number;
  payouts: number;
  threads: number;
  tickets: number;
  revenueUsd: number;
};

export async function seedDemoData(): Promise<DemoSeedReport> {
  logger.info("removing any previous demo dataset");
  await wipeDemoData();

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const usedNames = new Set<string>();
  const nextName = (): string => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    return `Invité ${usedNames.size + 1}`;
  };
  const slug = (value: string, index: number) =>
    `${value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.|\.$/g, "")}${index}@${DEMO_EMAIL_DOMAIN}`;

  /* staff */
  const staff: Person[] = [];
  const staffSpec = [
    { name: "Admin Démo", email: `admin@${DEMO_EMAIL_DOMAIN}`, roles: ["admin", "guest"] },
    { name: "Modérateur Démo", email: `moderateur@${DEMO_EMAIL_DOMAIN}`, roles: ["moderator", "guest"] },
    { name: "Support Démo", email: `support@${DEMO_EMAIL_DOMAIN}`, roles: ["support", "guest"] },
    { name: "Comptabilité Démo", email: `comptabilite@${DEMO_EMAIL_DOMAIN}`, roles: ["accounting", "guest"] },
  ];
  for (const member of staffSpec) {
    staff.push(
      await insertUser({
        fullName: member.name,
        email: member.email,
        passwordHash,
        roles: member.roles,
        verified: true,
        joinedDaysAgo: between(500, 900),
      }),
    );
  }
  const admin = staff[0]!;
  const supportAgent = staff[2]!;

  /* hosts */
  const hosts: (Person & { superhost: boolean })[] = [];
  for (let index = 0; index < 16; index += 1) {
    const fullName = nextName();
    const person = await insertUser({
      fullName,
      email: slug(fullName, index + 1),
      passwordHash,
      roles: ["host", "guest"],
      verified: rand() > 0.15,
      joinedDaysAgo: between(200, 1500),
    });
    const superhost = rand() > 0.55;
    await query(
      `INSERT INTO host_profile (user_id, display_name, hosting_since, superhost, bio, response_rate,
                                 payouts_onboarded, payout_reference)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        person.id,
        fullName,
        between(2016, 2024),
        superhost,
        "Hôte passionné par ma région, je réponds rapidement et j'adore partager mes bonnes adresses.",
        between(85, 100),
        `FR76-DEMO-${1000 + index}`,
      ],
      { label: "seed-demo.hostProfile" },
    );
    await query(
      `INSERT INTO host_rate_rules (host_id, weekend_percent, long_stay_percent, last_minute_percent)
       VALUES ($1, $2, $3, $4) ON CONFLICT (host_id) DO NOTHING`,
      [person.id, between(8, 20), between(5, 15), between(3, 10)],
      { label: "seed-demo.rateRules" },
    );
    if (rand() > 0.7) {
      await query(
        `INSERT INTO host_commission (host_id, commission_rate, note, set_by)
         VALUES ($1, $2, 'Accord commercial partenaire', $3) ON CONFLICT (host_id) DO NOTHING`,
        [person.id, between(8, 15), admin.id],
        { label: "seed-demo.commission" },
      );
    }
    await query(
      `INSERT INTO host_team_member (id, host_id, full_name, email, scopes)
       VALUES ($1, $2, $3, $4, ARRAY['calendar','messaging']::team_scope[])
       ON CONFLICT (id) DO NOTHING`,
      [`demo-team-${index + 1}`, person.id, nextName(), `equipe${index + 1}@${DEMO_EMAIL_DOMAIN}`],
      { label: "seed-demo.team" },
    );
    hosts.push({ ...person, superhost });
  }

  /* guests */
  const guests: Person[] = [];
  for (let index = 0; index < 60; index += 1) {
    const fullName = nextName();
    const banned = index === 58;
    const suspended = index === 56 || index === 57;
    const person = await insertUser({
      fullName,
      email: slug(fullName, 100 + index),
      passwordHash,
      roles: ["guest"],
      verified: rand() > 0.25,
      suspended,
      banned,
      joinedDaysAgo: between(10, 1200),
    });
    guests.push(person);
    const statusRoll = rand();
    await query(
      `INSERT INTO identity_verification (user_id, status, document_kind, document_reference, notes, decided_by, decided_at)
       VALUES ($1, $2::verification_status, 'passport', $3, NULL, $4, $5)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        person.id,
        statusRoll > 0.45 ? "verified" : statusRoll > 0.2 ? "pending" : "rejected",
        `FR-ID-${between(100000, 999999)}`,
        statusRoll > 0.45 ? admin.id : null,
        statusRoll > 0.45 ? daysAgo(between(1, 200)).toISOString() : null,
      ],
      { label: "seed-demo.verification" },
    );
  }

  /* equipment ids available in the catalogue */
  const equipmentRows = await query<{ id: string }>(`SELECT id FROM equipment WHERE active ORDER BY id LIMIT 120`, [], {
    label: "seed-demo.equipment",
  });
  const equipmentIds = equipmentRows.map((row) => row.id);

  /* properties + listings */
  type Listing = {
    propertyId: string;
    listingId: string;
    hostId: string;
    hostName: string;
    nightly: number;
    cleaning: number;
    city: string;
    published: boolean;
    policy: string;
  };
  const listings: Listing[] = [];
  const TOTAL_LISTINGS = 54;

  for (let index = 0; index < TOTAL_LISTINGS; index += 1) {
    const host = hosts[index % hosts.length]!;
    const place = CITIES[index % CITIES.length]!;
    const category = CATEGORIES[index % CATEGORIES.length]!;
    const propertyId = `demo-prop-${index + 1}`;
    const listingId = `demo-lst-${index + 1}`;
    const name = `${pick(TITLE_PREFIX[category]!)} — ${place.city}`;
    const guestsCapacity = between(2, 8);
    const nightly = between(55, 420);
    const cleaning = between(15, 90);
    // 44 live, 5 awaiting approval, 3 drafts, 2 suspended.
    const status = index < 44 ? "published" : index < 49 ? "published" : index < 52 ? "draft" : "suspended";
    const approved = index < 44;
    const published = status === "published" && approved;
    const policy = pick(["flexible", "moderate", "strict"]);
    const rating = money(3.8 + rand() * 1.2);

    await query(
      `INSERT INTO property (id, host_id, name, category, summary, description, city, country, neighbourhood,
                             postal_code, latitude, longitude, guests, rooms, beds, baths, area_sqm,
                             base_price_usd, cleaning_fee_usd, min_nights, cancellation_policy, house_rules,
                             check_in, check_out, instant_book, rating, review_count, superhost, created_at)
       VALUES ($1,$2,$3,$4::property_category,$5,$6,$7,'France',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               $20::cancellation_policy,$21,'15:00','11:00',$22,$23,0,$24,$25)`,
      [
        propertyId,
        host.id,
        name,
        category,
        pick(SUMMARIES),
        pick(DESCRIPTIONS),
        place.city,
        `${pick(NEIGHBOURHOODS)}, ${place.region}`,
        place.postal,
        money(place.lat + (rand() - 0.5) * 0.05),
        money(place.lng + (rand() - 0.5) * 0.05),
        guestsCapacity,
        between(1, 5),
        between(1, 6),
        between(1, 3),
        between(22, 180),
        nightly,
        cleaning,
        between(1, 3),
        policy,
        pick(HOUSE_RULES),
        rand() > 0.4,
        rating,
        host.superhost,
        daysAgo(between(30, 900)).toISOString(),
      ],
      { label: "seed-demo.property" },
    );

    for (let photo = 0; photo < 5; photo += 1) {
      await query(
        `INSERT INTO property_photo (property_id, url, alt_text, position) VALUES ($1, $2, $3, $4)`,
        [
          propertyId,
          `https://picsum.photos/seed/${propertyId}-${photo}/1200/800`,
          `${name} — photo ${photo + 1}`,
          photo,
        ],
        { label: "seed-demo.photo" },
      );
    }

    for (const amenity of pickSome(AMENITIES, between(3, 6))) {
      await query(
        `INSERT INTO property_amenity (property_id, amenity) VALUES ($1, $2::amenity_id) ON CONFLICT DO NOTHING`,
        [propertyId, amenity],
        { label: "seed-demo.amenity" },
      );
    }
    for (const equipmentId of pickSome(equipmentIds, Math.min(equipmentIds.length, between(6, 14)))) {
      await query(
        `INSERT INTO property_equipment (property_id, equipment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [propertyId, equipmentId],
        { label: "seed-demo.propertyEquipment" },
      );
    }
    for (const tag of pickSome(["famille", "bord de mer", "montagne", "télétravail", "romantique", "city break"], 2)) {
      await query(`INSERT INTO property_tag (property_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [propertyId, tag], {
        label: "seed-demo.tag",
      });
    }
    for (const locale of ["fr", "en"]) {
      await query(
        `INSERT INTO property_translation (property_id, locale, location_label, name, summary, description)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [propertyId, locale, `${place.city}, France`, name, pick(SUMMARIES), pick(DESCRIPTIONS)],
        { label: "seed-demo.translation" },
      );
    }

    await query(
      `INSERT INTO listing (id, property_id, status, approved, rejected_reason, nightly_usd, long_stay_enabled,
                            long_stay_threshold, long_stay_discount, mobile_enabled, mobile_discount, published_at, created_at)
       VALUES ($1,$2,$3::listing_status,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        listingId,
        propertyId,
        status,
        approved,
        status === "suspended" ? "Photos non conformes, en attente de correction" : null,
        nightly,
        rand() > 0.5,
        between(5, 21),
        between(5, 20),
        rand() > 0.5,
        between(3, 10),
        published ? daysAgo(between(20, 600)).toISOString() : null,
        daysAgo(between(30, 900)).toISOString(),
      ],
      { label: "seed-demo.listing" },
    );

    // a handful of blocked nights so the calendar is not empty
    for (let night = 0; night < between(2, 6); night += 1) {
      await query(
        `INSERT INTO calendar_night (property_id, night, blocked, note)
         VALUES ($1, $2, true, 'Indisponible (entretien)') ON CONFLICT DO NOTHING`,
        [propertyId, iso(addDays(today, between(40, 120)))],
        { label: "seed-demo.calendar" },
      );
    }

    listings.push({
      propertyId,
      listingId,
      hostId: host.id,
      hostName: host.fullName,
      nightly,
      cleaning,
      city: place.city,
      published,
      policy,
    });
  }

  /* bookings, payments, reviews, messages */
  const settings = await queryOne<{ service_fee_rate: string; tax_rate: string; commission_rate: string }>(
    `SELECT service_fee_rate, tax_rate, commission_rate FROM platform_settings WHERE id`,
    [],
    { label: "seed-demo.settings" },
  );
  const serviceRate = Number(settings?.service_fee_rate ?? 0.08);
  const taxRate = Number(settings?.tax_rate ?? 0.05);
  const commissionRate = Number(settings?.commission_rate ?? 12) / 100;

  type CompletedBooking = { hostId: string; hostName: string; bookingId: string; total: number; date: Date };
  const completed: CompletedBooking[] = [];
  let bookingCount = 0;
  let reviewCount = 0;
  let threadCount = 0;
  let revenueTotal = 0;
  const ratingAccumulator = new Map<string, { sum: number; count: number }>();

  for (const listing of listings) {
    if (!listing.published) continue;
    // Walk a cursor backwards from ~14 months ago so stays never overlap.
    let cursor = daysAgo(430);
    const stays = between(4, 9);
    for (let stay = 0; stay < stays; stay += 1) {
      cursor = addDays(cursor, between(6, 34));
      const nights = between(2, 9);
      const checkIn = new Date(cursor);
      const checkOut = addDays(checkIn, nights);
      cursor = addDays(checkOut, 1);
      if (checkIn.getTime() > addDays(today, 90).getTime()) break;

      const guest = pick(guests);
      const past = checkOut.getTime() < today.getTime();
      const roll = rand();
      const status = past
        ? roll > 0.12
          ? "completed"
          : roll > 0.05
            ? "cancelled"
            : "declined"
        : roll > 0.25
          ? "confirmed"
          : "pending";

      const bookingCounter = bookingCount + 1;
      const bookingId = `demo-bkg-${bookingCounter}`;
      const nightly = listing.nightly;
      const baseSubtotal = money(nightly * nights);
      const discountPercent = nights >= 7 ? between(5, 15) : 0;
      const discountAmount = money((baseSubtotal * discountPercent) / 100);
      const subtotal = money(baseSubtotal - discountAmount);
      const serviceFee = money(subtotal * serviceRate);
      const taxes = money((subtotal + listing.cleaning) * taxRate);
      const total = money(subtotal + listing.cleaning + serviceFee + taxes);
      const createdAt = addDays(checkIn, -between(3, 60));

      await query(
        `INSERT INTO booking (id, reference, property_id, guest_id, guest_name, guest_email, guest_phone, message,
                              check_in, check_out, guests, status, is_mobile_booking, currency, nightly_usd,
                              base_subtotal, subtotal, cleaning_fee, service_fee, taxes, total_usd,
                              decided_at, decided_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::booking_status,$13,'EUR',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          bookingId,
          `RE-${String(100000 + bookingCounter)}`,
          listing.propertyId,
          guest.id,
          guest.fullName,
          guest.email,
          `+33 6 ${between(10, 99)} ${between(10, 99)} ${between(10, 99)} ${between(10, 99)}`,
          rand() > 0.6 ? "Bonjour, nous arriverons en fin de journée. Merci !" : null,
          iso(checkIn),
          iso(checkOut),
          between(1, 4),
          status,
          rand() > 0.5,
          nightly,
          baseSubtotal,
          subtotal,
          listing.cleaning,
          serviceFee,
          taxes,
          total,
          status === "pending" ? null : createdAt.toISOString(),
          status === "pending" ? null : listing.hostId,
          createdAt.toISOString(),
        ],
        { label: "seed-demo.booking" },
      );
      bookingCount += 1;

      if (discountPercent > 0) {
        await query(
          `INSERT INTO booking_discount (booking_id, kind, percent, amount_usd)
           VALUES ($1, 'longStay'::discount_kind, $2, $3) ON CONFLICT DO NOTHING`,
          [bookingId, discountPercent, discountAmount],
          { label: "seed-demo.discount" },
        );
      }

      const paymentStatus = status === "cancelled" ? "refunded" : status === "pending" ? "authorized" : "paid";
      await query(
        `INSERT INTO payment (booking_id, method, brand, last4, status, amount_usd, reference, refunded_usd, created_at)
         VALUES ($1, 'card', $2::card_brand, $3, $4::payment_status, $5, $6, $7, $8)`,
        [
          bookingId,
          pick(["visa", "mastercard", "amex"]),
          String(between(1000, 9999)),
          paymentStatus,
          total,
          `pi_demo_${bookingCounter}`,
          paymentStatus === "refunded" ? money(total * 0.8) : 0,
          createdAt.toISOString(),
        ],
        { label: "seed-demo.payment" },
      );

      if (status === "cancelled") {
        await query(
          `INSERT INTO booking_cancellation (booking_id, cancelled_by, cancelled_by_id, policy, refund_percent, refund_usd, reason, cancelled_at)
           VALUES ($1, 'guest'::actor_role, $2, $3::cancellation_policy, 80, $4, 'Changement de programme', $5)
           ON CONFLICT DO NOTHING`,
          [bookingId, guest.id, listing.policy, money(total * 0.8), addDays(checkIn, -between(1, 10)).toISOString()],
          { label: "seed-demo.cancellation" },
        );
        if (rand() > 0.6) {
          await query(
            `INSERT INTO booking_refund (booking_id, amount_usd, reason, issued_by, created_at)
             VALUES ($1, $2, 'Remboursement commercial accordé par le support', $3, $4)`,
            [bookingId, money(total * 0.2), admin.id, addDays(checkIn, -1).toISOString()],
            { label: "seed-demo.refund" },
          );
        }
      }

      if (status === "completed") {
        revenueTotal = money(revenueTotal + total);
        completed.push({ hostId: listing.hostId, hostName: listing.hostName, bookingId, total, date: checkOut });

        if (rand() > 0.25) {
          const rating = between(3, 5);
          const hasReply = rand() > 0.5;
          await query(
            `INSERT INTO review (id, property_id, booking_id, author_id, author_name, rating, body, reply, replied_at,
                                 replied_by, hidden, created_on, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              `demo-rev-${bookingCounter}`,
              listing.propertyId,
              bookingId,
              guest.id,
              guest.fullName,
              rating,
              pick(REVIEW_BODIES),
              hasReply ? pick(REVIEW_REPLIES) : null,
              hasReply ? addDays(checkOut, 2).toISOString() : null,
              hasReply ? listing.hostId : null,
              rand() > 0.95,
              iso(addDays(checkOut, 1)),
              addDays(checkOut, 1).toISOString(),
            ],
            { label: "seed-demo.review" },
          );
          reviewCount += 1;
          const acc = ratingAccumulator.get(listing.propertyId) ?? { sum: 0, count: 0 };
          acc.sum += rating;
          acc.count += 1;
          ratingAccumulator.set(listing.propertyId, acc);
        }
      }

      if (rand() > 0.55) {
        const threadId = `demo-thr-${bookingCounter}`;
        await query(
          `INSERT INTO message_thread (id, property_id, booking_id, guest_id, host_id, with_name, last_message_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            threadId,
            listing.propertyId,
            bookingId,
            guest.id,
            listing.hostId,
            listing.hostName,
            addDays(createdAt, 1).toISOString(),
            createdAt.toISOString(),
          ],
          { label: "seed-demo.thread" },
        );
        const exchanges = between(2, 4);
        for (let step = 0; step < exchanges; step += 1) {
          const fromGuest = step % 2 === 0;
          await query(
            `INSERT INTO message (thread_id, sender_id, sender_role, body, sent_at, read_at)
             VALUES ($1,$2,$3::actor_role,$4,$5,$6)`,
            [
              threadId,
              fromGuest ? guest.id : listing.hostId,
              fromGuest ? "guest" : "host",
              fromGuest ? pick(GUEST_MESSAGES) : pick(HOST_MESSAGES),
              addDays(createdAt, step).toISOString(),
              rand() > 0.3 ? addDays(createdAt, step + 1).toISOString() : null,
            ],
            { label: "seed-demo.message" },
          );
        }
        threadCount += 1;
      }
    }
  }

  /* refresh denormalised ratings */
  for (const [propertyId, acc] of ratingAccumulator) {
    await query(`UPDATE property SET rating = $2, review_count = $3 WHERE id = $1`, [
      propertyId,
      money(acc.sum / acc.count),
      acc.count,
    ], { label: "seed-demo.rating" });
  }

  /* favourites */
  for (const guest of guests) {
    for (const listing of pickSome(listings.filter((item) => item.published), between(1, 5))) {
      await query(`INSERT INTO favorite (user_id, property_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        guest.id,
        listing.propertyId,
      ], { label: "seed-demo.favorite" });
    }
  }

  /* payouts — one per host and per month of completed stays */
  const payoutGroups = new Map<string, { hostId: string; hostName: string; items: CompletedBooking[] }>();
  for (const item of completed) {
    const key = `${item.hostId}:${item.date.getUTCFullYear()}-${item.date.getUTCMonth() + 1}`;
    const group = payoutGroups.get(key) ?? { hostId: item.hostId, hostName: item.hostName, items: [] };
    group.items.push(item);
    payoutGroups.set(key, group);
  }

  let payoutIndex = 0;
  for (const [key, group] of payoutGroups) {
    payoutIndex += 1;
    const payoutId = `demo-pay-${payoutIndex}`;
    const gross = money(group.items.reduce((sum, item) => sum + item.total, 0));
    const commission = money(gross * commissionRate);
    const net = money(gross - commission);
    const last = group.items.reduce((latest, item) => (item.date > latest ? item.date : latest), group.items[0]!.date);
    const payoutDate = addDays(last, 3);
    await query(
      `INSERT INTO payout (id, host_id, host_name, amount_usd, commission_usd, status, payout_date, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::payout_status,$7,$8)`,
      [
        payoutId,
        group.hostId,
        group.hostName,
        net,
        commission,
        payoutDate.getTime() < today.getTime() ? "paid" : "scheduled",
        iso(payoutDate),
        payoutDate.toISOString(),
      ],
      { label: "seed-demo.payout" },
    );
    for (const item of group.items) {
      await query(
        `INSERT INTO payout_item (payout_id, booking_id, amount_usd) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [payoutId, item.bookingId, money(item.total * (1 - commissionRate))],
        { label: "seed-demo.payoutItem" },
      );
    }
    void key;
  }

  /* monthly statistics per host (dashboard charts) */
  const monthly = new Map<string, { hostId: string; year: number; month: number; bookings: number; revenue: number }>();
  for (const item of completed) {
    const year = item.date.getUTCFullYear();
    const month = item.date.getUTCMonth() + 1;
    const key = `${item.hostId}:${year}:${month}`;
    const row = monthly.get(key) ?? { hostId: item.hostId, year, month, bookings: 0, revenue: 0 };
    row.bookings += 1;
    row.revenue = money(row.revenue + item.total);
    monthly.set(key, row);
  }
  for (const row of monthly.values()) {
    await query(
      `INSERT INTO booking_monthly_stat (host_id, year, month, bookings, revenue_usd)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (host_id, year, month) DO UPDATE SET bookings = EXCLUDED.bookings, revenue_usd = EXCLUDED.revenue_usd`,
      [row.hostId, row.year, row.month, row.bookings, row.revenue],
      { label: "seed-demo.monthlyStat" },
    );
  }

  /* support tickets */
  let ticketCount = 0;
  for (let index = 0; index < 22; index += 1) {
    const guest = pick(guests);
    const listing = pick(listings);
    const status = pick(["open", "pending", "resolved", "closed"]);
    const reference = `DEMO-T${1000 + index}`;
    const createdAt = daysAgo(between(1, 180));
    const ticket = await queryOne<{ id: string }>(
      `INSERT INTO support_ticket (reference, subject, category, priority, status, opened_by, opened_by_name,
                                   opened_by_role, listing_id, assigned_to, resolution, closed_at, last_activity_at, created_at)
       VALUES ($1,$2,$3::ticket_category,$4::ticket_priority,$5::ticket_status,$6,$7,'guest'::actor_role,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        reference,
        pick(TICKET_SUBJECTS),
        pick(["booking", "payment", "listing", "account", "dispute", "other"]),
        pick(["low", "normal", "high", "urgent"]),
        status,
        guest.id,
        guest.fullName,
        listing.listingId,
        status === "open" ? null : supportAgent.id,
        status === "resolved" || status === "closed" ? "Dossier traité et voyageur informé par e-mail." : null,
        status === "closed" ? addDays(createdAt, 3).toISOString() : null,
        addDays(createdAt, between(0, 5)).toISOString(),
        createdAt.toISOString(),
      ],
      { label: "seed-demo.ticket" },
    );
    ticketCount += 1;
    await query(
      `INSERT INTO support_ticket_message (ticket_id, author_id, author_name, author_role, body, sent_at)
       VALUES ($1,$2,$3,'guest'::actor_role,$4,$5)`,
      [ticket!.id, guest.id, guest.fullName, "Bonjour, pouvez-vous m'aider sur ce dossier s'il vous plaît ?", createdAt.toISOString()],
      { label: "seed-demo.ticketMessage" },
    );
    if (status !== "open") {
      await query(
        `INSERT INTO support_ticket_message (ticket_id, author_id, author_name, author_role, body, sent_at)
         VALUES ($1,$2,$3,'admin'::actor_role,$4,$5)`,
        [
          ticket!.id,
          supportAgent.id,
          supportAgent.fullName,
          "Bonjour, nous avons pris votre demande en charge et revenons vers vous très vite.",
          addDays(createdAt, 1).toISOString(),
        ],
        { label: "seed-demo.ticketMessage" },
      );
    }
  }

  /* listing reports */
  for (let index = 0; index < 12; index += 1) {
    const listing = pick(listings);
    const reporter = pick(guests);
    const status = pick(["open", "reviewing", "resolved", "dismissed"]);
    await query(
      `INSERT INTO listing_report (listing_id, reported_by, reporter_name, reason, details, status, resolution, handled_by, handled_at, created_at)
       VALUES ($1,$2,$3,$4::report_reason,$5,$6::report_status,$7,$8,$9,$10)`,
      [
        listing.listingId,
        reporter.id,
        reporter.fullName,
        pick(["fraud", "inappropriate", "wrong_information", "unavailable", "safety", "other"]),
        pick(REPORT_DETAILS),
        status,
        status === "resolved" || status === "dismissed" ? "Signalement traité par la modération." : null,
        status === "resolved" || status === "dismissed" ? admin.id : null,
        status === "resolved" || status === "dismissed" ? daysAgo(between(1, 30)).toISOString() : null,
        daysAgo(between(2, 120)).toISOString(),
      ],
      { label: "seed-demo.report" },
    );
  }

  /* moderation trail + queued notifications */
  for (let index = 0; index < 18; index += 1) {
    const listing = pick(listings);
    await query(
      `INSERT INTO moderation_log (admin_id, action, target_kind, target_id, reason, created_at)
       VALUES ($1,$2::moderation_action,'listing',$3,$4,$5)`,
      [
        admin.id,
        pick(["listing_approved", "listing_published", "listing_suspended", "listing_rejected"]),
        listing.listingId,
        "Contrôle qualité des annonces",
        daysAgo(between(1, 200)).toISOString(),
      ],
      { label: "seed-demo.moderationLog" },
    );
  }
  for (let index = 0; index < 14; index += 1) {
    const guest = pick(guests);
    await query(
      `INSERT INTO notification_outbox (recipient_id, recipient_email, template, locale, subject, body, status, created_at)
       VALUES ($1,$2,'booking_confirmed','fr',$3,$4,$5::notification_status,$6)`,
      [
        guest.id,
        guest.email,
        "Votre réservation est confirmée",
        "Bonjour, votre réservation est confirmée. Vous retrouverez tous les détails dans l'application.",
        pick(["sent", "sent", "queued", "failed"]),
        daysAgo(between(1, 60)).toISOString(),
      ],
      { label: "seed-demo.notification" },
    );
  }

  const report: DemoSeedReport = {
    hosts: hosts.length,
    guests: guests.length,
    staff: staff.length,
    listings: listings.length,
    bookings: bookingCount,
    reviews: reviewCount,
    payouts: payoutIndex,
    threads: threadCount,
    tickets: ticketCount,
    revenueUsd: revenueTotal,
  };
  logger.info(report, "demo dataset ready");
  return report;
}
