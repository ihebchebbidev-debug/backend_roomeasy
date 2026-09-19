import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { completeFinishedStays, expireUnpaidBookings } from "@/modules/bookings/bookings.repository.js";

const logger = log("booking-maintenance");

let timer: NodeJS.Timeout | null = null;

/**
 * Background sweep: releases the nights of bookings that were never paid and
 * moves finished stays to `completed`. A no-op when BOOKING_MAINTENANCE is off.
 */
export function startBookingMaintenanceWorker(): void {
  if (timer || !env.BOOKING_MAINTENANCE) return;

  const tick = () => {
    void (async () => {
      const expired = await expireUnpaidBookings();
      const completed = await completeFinishedStays();
      if (expired || completed) logger.info({ expired, completed }, "booking maintenance run");
    })().catch((error) => logger.error({ err: error }, "booking maintenance run failed"));
  };

  timer = setInterval(tick, env.BOOKING_MAINTENANCE_SECONDS * 1000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  logger.info(
    { everySeconds: env.BOOKING_MAINTENANCE_SECONDS, holdMinutes: env.BOOKING_HOLD_MINUTES },
    "booking maintenance worker started",
  );
}

export function stopBookingMaintenanceWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
