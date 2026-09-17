import { Router } from "express";
import { z } from "zod";

import { asyncHandler, ok } from "@/core/http.js";
import { validateQuery } from "@/core/validate.js";
import { requireRole } from "@/middleware/auth.js";
import { SUPPORTED_CURRENCIES, convertFromUsd, getRates } from "@/modules/currency/currency.repository.js";

export const currencyRouter = Router();

/** Public: the rates the price switcher needs. */
currencyRouter.get(
  "/rates",
  asyncHandler(async (_req, res) => {
    const payload = await getRates();
    return ok(res, payload, { supported: SUPPORTED_CURRENCIES });
  }),
);

/** Public helper so a client never has to do the arithmetic itself. */
currencyRouter.get(
  "/convert",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        amountUsd: z.coerce.number().min(0, "The amount cannot be negative.").max(10_000_000),
        to: z
          .string()
          .trim()
          .toUpperCase()
          .refine(
            (value) => (SUPPORTED_CURRENCIES as readonly string[]).includes(value),
            `Supported currencies: ${SUPPORTED_CURRENCIES.join(", ")}.`,
          ),
      }),
      req,
    );
    const { amount, rate } = await convertFromUsd(input.amountUsd, input.to);
    return ok(res, { amountUsd: input.amountUsd, currency: input.to, amount, rate });
  }),
);

/** Admin: force a refresh from the upstream provider. */
currencyRouter.post(
  "/rates/refresh",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const payload = await getRates({ force: true });
    req.log.info({ source: payload.source }, "exchange rates refresh requested");
    return ok(res, payload);
  }),
);
