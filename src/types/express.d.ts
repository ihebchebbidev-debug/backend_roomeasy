import type { Logger } from "pino";

import type { AuthContext } from "@/middleware/auth.js";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id echoed back as the `x-request-id` header. */
      id: string;
      /** Request-scoped logger, already tagged with the request id. */
      log: Logger;
      /** Present once `authenticate` or `requireAuth` has run. */
      auth?: AuthContext;
    }
  }
}

export {};
