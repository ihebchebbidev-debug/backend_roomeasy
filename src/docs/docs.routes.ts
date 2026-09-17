import { Router } from "express";

import { buildOpenApiDocument, documentedOperationCount } from "@/docs/openapi.js";

export const docsRouter = Router();

/** Rebuilds the document per request so the server URL matches how it was reached. */
function documentFor(req: { protocol: string; get(name: string): string | undefined }) {
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost:4000";
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0];
  return buildOpenApiDocument(`${proto}://${host}/api`);
}

/** The machine-readable contract (importable in Postman, Insomnia, codegen). */
docsRouter.get("/openapi.json", (req, res) => {
  res.json(documentFor(req));
});

/** Small summary used by the test suite and monitoring. */
docsRouter.get("/summary", (req, res) => {
  const doc = documentFor(req);
  res.json({
    data: {
      title: doc.info.title,
      version: doc.info.version,
      server: doc.servers[0]?.url,
      paths: Object.keys(doc.paths).length,
      operations: documentedOperationCount(),
      tags: doc.tags.map((tag) => tag.name),
    },
  });
});

/**
 * Swagger UI, loaded from a CDN so the API keeps zero extra dependencies and the
 * production bundle stays unchanged.
 */
docsRouter.get("/", (_req, res) => {
  // Helmet's default policy blocks the CDN assets and the inline bootstrap
  // script, which renders the page blank. Relax it for this page only.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://unpkg.com",
      "script-src 'self' 'unsafe-inline' https://unpkg.com",
      "connect-src 'self'",
    ].join("; "),
  );
  res.removeHeader("Cross-Origin-Embedder-Policy");
  res.type("html").send(`<!doctype html>

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RoomEasy API reference</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
      .banner {
        font: 600 14px/1.5 system-ui, sans-serif;
        padding: 14px 20px;
        background: #111827;
        color: #f9fafb;
      }
      .banner span { color: #fb923c; }
    </style>
  </head>
  <body>
    <div class="banner">RoomEasy API reference &mdash; <span>documentation complète, accès libre</span></div>
    <div id="swagger"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: "#swagger",
        deepLinking: true,
        persistAuthorization: true,
        docExpansion: "none",
        filter: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>`);
});
