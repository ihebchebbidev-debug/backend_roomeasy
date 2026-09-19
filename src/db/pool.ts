import { Pool, type PoolClient, type PoolConfig } from "pg";

import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";

const logger = log("db");

function poolConfig(): PoolConfig {
  const ssl = env.PGSSL ? { rejectUnauthorized: false } : undefined;
  if (env.DATABASE_URL.trim()) {
    return { connectionString: env.DATABASE_URL, max: env.PG_POOL_MAX, ssl };
  }
  return {
    host: env.PGHOST,
    port: env.PGPORT,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
    max: env.PG_POOL_MAX,
    ssl,
  };
}

export const pool = new Pool({
  ...poolConfig(),
  application_name: "nestara-backend",
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Keeps pooled sockets alive through NAT/idle timeouts instead of paying a
  // fresh TLS handshake on the next request.
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
  // A runaway query can never pin a connection for more than 15s.
  statement_timeout: 15_000,
  query_timeout: 20_000,
  // Recycles connections so a long-lived process cannot accumulate bloat.
  maxLifetimeSeconds: 1_800,
});

pool.on("error", (error) => {
  logger.error({ err: error }, "Idle PostgreSQL client errored");
});

// Every session speaks UTC so `CURRENT_DATE` in SQL and `today()` in Node can
// never disagree about which day it is.
pool.on("connect", (client) => {
  void client.query("SET TIME ZONE 'UTC'").catch((error: unknown) => {
    logger.error({ err: error }, "Could not pin the session timezone to UTC");
  });
});


/** Human readable target, used in the boot banner (never logs the password). */
export function databaseTarget(): string {
  if (env.DATABASE_URL.trim()) {
    try {
      const url = new URL(env.DATABASE_URL);
      return `${url.hostname}:${url.port || 5432}${url.pathname}`;
    } catch {
      return "DATABASE_URL";
    }
  }
  return `${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}`;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info("PostgreSQL pool closed");
}
