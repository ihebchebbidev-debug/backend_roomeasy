import { env } from "@/config/env.js";

/** Locale-aware wording around the queued subject/body. */
const COPY = {
  en: { hello: "Hello", footer: "You are receiving this message because you have an account on", team: "The team" },
  fr: { hello: "Bonjour", footer: "Vous recevez ce message car vous avez un compte sur", team: "L'équipe" },
  es: { hello: "Hola", footer: "Recibes este mensaje porque tienes una cuenta en", team: "El equipo" },
  de: { hello: "Hallo", footer: "Sie erhalten diese Nachricht, weil Sie ein Konto bei", team: "Das Team" },
  pt: { hello: "Olá", footer: "Você recebe esta mensagem porque tem uma conta em", team: "A equipe" },
} as const;

type Locale = keyof typeof COPY;

function copyFor(locale: string) {
  return COPY[(locale as Locale) in COPY ? (locale as Locale) : "en"];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turns a queued plain-text notification into a branded HTML email. Inline
 * styles only — mail clients ignore stylesheets.
 */
export function renderNotificationHtml(input: { subject: string; body: string; locale: string }): string {
  const copy = copyFor(input.locale);
  const site = env.APP_NAME;
  const url = env.APP_PUBLIC_URL;
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;line-height:1.6;color:#334155">${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:24px;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td style="padding:0 0 18px">
      <span style="font-size:18px;font-weight:700;color:#0f172a">${escapeHtml(site)}</span>
    </td></tr>
    <tr><td style="border:1px solid #e2e8f0;border-radius:16px;padding:26px">
      <h1 style="margin:0 0 16px;font-size:19px;color:#0f172a">${escapeHtml(input.subject)}</h1>
      ${paragraphs}
      <p style="margin:22px 0 0;color:#64748b;font-size:13px">${escapeHtml(copy.team)} ${escapeHtml(site)}</p>
    </td></tr>
    <tr><td style="padding:16px 4px;color:#94a3b8;font-size:12px;line-height:1.5">
      ${escapeHtml(copy.footer)} <a href="${escapeHtml(url)}" style="color:#64748b">${escapeHtml(site)}</a>.
    </td></tr>
  </table>
</body></html>`;
}

export function greeting(locale: string, name?: string | null): string {
  const copy = copyFor(locale);
  return name ? `${copy.hello} ${name},` : `${copy.hello},`;
}
