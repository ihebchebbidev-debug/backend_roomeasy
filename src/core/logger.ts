import fs from "node:fs";
import path from "node:path";

import pino, { type Logger } from "pino";

import { env, isProduction } from "@/config/env.js";

/**
 * One logger for the whole process.
 *
 * - pretty, colourised output in development
 * - newline-delimited JSON in production (ready for any log shipper)
 * - optional mirror to `LOG_DIR/app-YYYY-MM-DD.log` so nothing is lost when
 *   stdout is not captured
 * - every credential-looking field is redacted before it is written
 */

const redact = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.passwordHash",
  "*.password_hash",
  "*.card.number",
  "*.card.cvc",
  "*.cvc",
  "*.token",
  "*.jwt",
  "*.secret",
];

function fileDestination() {
  if (!env.LOG_DIR.trim()) return null;
  const dir = path.resolve(process.cwd(), env.LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return pino.destination({ dest: path.join(dir, `app-${day}.log`), append: true, sync: false });
}

function buildLogger(): Logger {
  const base = { service: "nestara-backend", env: env.NODE_ENV };
  const options = { level: env.LOG_LEVEL, base, redact, timestamp: pino.stdTimeFunctions.isoTime };

  const streams: pino.StreamEntry[] = [];

  if (env.LOG_PRETTY && !isProduction) {
    streams.push({
      level: env.LOG_LEVEL,
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service,env" },
      }) as pino.DestinationStream,
    });
  } else {
    streams.push({ level: env.LOG_LEVEL, stream: pino.destination({ fd: 1, sync: false }) });
  }

  const file = fileDestination();
  if (file) streams.push({ level: env.LOG_LEVEL, stream: file });

  return pino(options, pino.multistream(streams, { dedupe: false }));
}

export const logger = buildLogger();

/** Child logger tagged with the area it belongs to, e.g. `log("bookings")`. */
export function log(module: string, extra: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...extra });
}
