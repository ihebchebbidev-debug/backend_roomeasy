import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import {
  completeFinishedStays,
  declineUnansweredRequests,
  expireUnpaidBookings,
} from "@/modules/bookings/bookings.repository.js";

const logger = log("booking-maintenance");

let timer: NodeJS.Timeout | null = null;

/**
 * Background sweep: releases the nights of bookings that were never paid,
 * declines (and refunds) paid requests the host never answered, and moves
 * finished stays to `completed`. A no-op when BOOKING_MAINTENANCE is off.
 */
export function startBookingMaintenanceWorker(): void {
  if (timer || !env.BOOKING_MAINTENANCE) return;

  const tick = () => {
    void (async () => {
      const expired = await expireUnpaidBookings();
      const declined = await declineUnansweredRequests();
      const completed = await completeFinishedStays();
      if (expired || declined || completed) logger.info({ expired, declined, completed }, "booking maintenance run");
    })().catch((error) => logger.error({ err: error }, "booking maintenance run failed"));
  };

  timer = setInterval(tick, env.BOOKING_MAINTENANCE_SECONDS * 1000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  logger.info(
    {
      everySeconds: env.BOOKING_MAINTENANCE_SECONDS,
      holdMinutes: env.BOOKING_HOLD_MINUTES,
      hostResponseHours: env.BOOKING_HOST_RESPONSE_HOURS,
    },
    "booking maintenance worker started",
  );
}

export function stopBookingMaintenanceWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
