import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") return fallback;
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z.string().default("*"),

  DATABASE_URL: z.string().optional().default(""),
  PGHOST: z.string().default("localhost"),
  PGPORT: z.coerce.number().int().default(5432),
  PGUSER: z.string().default("postgres"),
  PGPASSWORD: z.string().default("postgres"),
  PGDATABASE: z.string().default("nestara"),
  PGSSL: boolish(false),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  AUTO_MIGRATE: boolish(true),
  AUTO_HEAL: boolish(true),
  AUTO_SEED: boolish(false),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  // --- Branding used in emails and Stripe metadata -------------------------
  APP_NAME: z.string().default("RoomEasy"),
  APP_PUBLIC_URL: z.string().default("http://localhost:8080"),
  // Used to build links inside transactional emails (booking pages, etc.).
  PUBLIC_APP_URL: z.string().optional(),

  // --- SMTP (OVH by default) -----------------------------------------------
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_SECURE: boolish(true),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM_NAME: z.string().default("RoomEasy"),
  MAIL_FROM_ADDRESS: z.string().default(""),
  MAIL_REPLY_TO: z.string().optional(),
  MAIL_DRY_RUN: boolish(false),
  MAIL_WORKER: boolish(true),
  MAIL_POLL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  MAIL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // --- Unpaid booking holds -------------------------------------------------
  /** How long a pending, unpaid booking keeps its nights before it expires. */
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** Background sweep that releases expired holds. */
  BOOKING_MAINTENANCE: boolish(true),
  BOOKING_MAINTENANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),

  // --- Stripe ---------------------------------------------------------------
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_PUBLISHABLE_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_CONNECT_COUNTRY: z.string().default("FR"),
  // Every amount in the system is stored in EUR (booking.currency = 'EUR').
  PAYMENT_CURRENCY: z.string().length(3).default("EUR"),


  // --- Back office -----------------------------------------------------------
  /** Shared secret the /dev-admin helper must send; empty disables the helper. */
  DEV_ADMIN_SECRET: z.string().default(""),
  /** Issuer name shown in authenticator apps for admin two-step sign-in. */
  TOTP_ISSUER: z.string().default("RoomEasy Admin"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_PRETTY: boolish(false),
  LOG_DIR: z.string().default("logs"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  // Logger is not available yet at this point, so write straight to stderr.
  process.stderr.write(`Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

export const corsOrigins =
  env.CORS_ORIGINS.trim() === "*"
    ? "*"
    : env.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
