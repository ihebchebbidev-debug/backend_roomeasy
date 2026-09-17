import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import type { NextFunction, Request, Response } from "express";

/**
 * Compresses JSON/text responses on the way out.
 *
 * Listing search results and admin dashboards send fairly large JSON payloads;
 * gzip/brotli typically cuts them by 80-90%, which is the single biggest win
 * for perceived speed on mobile networks. Written with `node:zlib` so the
 * backend keeps zero extra dependencies.
 */

/** Below this size the compression overhead costs more than it saves. */
const MIN_BYTES = 1024;

const COMPRESSIBLE = /^(application\/(json|javascript|xml)|text\/|application\/.*\+json)/i;

export function compression() {
  return function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
    const accept = String(req.headers["accept-encoding"] ?? "");
    const useBrotli = /\bbr\b/.test(accept);
    const useGzip = /\bgzip\b/.test(accept);
    if (!useBrotli && !useGzip) {
      next();
      return;
    }

    const originalSend = res.send.bind(res);

    res.send = function send(body?: unknown): Response {
      try {
        if (res.headersSent || res.getHeader("Content-Encoding")) return originalSend(body as never);

        const raw =
          typeof body === "string"
            ? Buffer.from(body, "utf8")
            : Buffer.isBuffer(body)
              ? body
              : undefined;
        if (!raw || raw.byteLength < MIN_BYTES) return originalSend(body as never);

        const type = String(res.getHeader("Content-Type") ?? "");
        if (!COMPRESSIBLE.test(type)) return originalSend(body as never);

        const encoded = useBrotli
          ? brotliCompressSync(raw, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
              },
            })
          : gzipSync(raw, { level: 6 });

        // Never ship a "compressed" body that is larger than the original.
        if (encoded.byteLength >= raw.byteLength) return originalSend(body as never);

        res.setHeader("Content-Encoding", useBrotli ? "br" : "gzip");
        res.setHeader("Content-Length", String(encoded.byteLength));
        res.vary("Accept-Encoding");
        return originalSend(encoded as never);
      } catch {
        // Compression must never break a response.
        return originalSend(body as never);
      }
    } as Response["send"];

    next();
  };
}
