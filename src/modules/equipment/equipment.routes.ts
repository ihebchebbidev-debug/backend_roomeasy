import { Router } from "express";
import { z } from "zod";

import { asyncHandler, ok } from "@/core/http.js";
import { validateQuery } from "@/core/validate.js";
import { countEquipmentByGroup, listEquipment } from "@/modules/equipment/equipment.repository.js";

export const equipmentRouter = Router();

equipmentRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        group: z.string().trim().max(40).optional(),
        search: z.string().trim().max(80).optional(),
        includeInactive: z
          .string()
          .optional()
          .transform((value) => (value ? ["1", "true", "yes"].includes(value.toLowerCase()) : false)),
      }),
      req,
    );
    const items = await listEquipment(input);
    return ok(res, items, { total: items.length });
  }),
);

equipmentRouter.get(
  "/groups",
  asyncHandler(async (_req, res) => ok(res, await countEquipmentByGroup())),
);
