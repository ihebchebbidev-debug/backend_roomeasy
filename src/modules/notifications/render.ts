import { env } from "@/config/env.js";

/** Locale-aware wording around the queued subject/body. */
const COPY = {
  en: {
    hello: "Hello",
    footer: "You are receiving this message because you have an account on",
    team: "The team",
    codeTitle: "Your password reset code",
    codeIntro: "Use the code below to confirm it is really you and choose a new password.",
    codeExpiry: "This code expires in 15 minutes and can be used once.",
    codeIgnore: "Did not ask for this? You can safely ignore this email — your password stays unchanged.",
    secure: "For your security, never share this code with anyone.",
  },
  fr: {
    hello: "Bonjour",
    footer: "Vous recevez ce message car vous avez un compte sur",
    team: "L'équipe",
    codeTitle: "Votre code de réinitialisation",
    codeIntro: "Utilisez le code ci-dessous pour confirmer votre identité et choisir un nouveau mot de passe.",
    codeExpiry: "Ce code expire dans 15 minutes et ne peut être utilisé qu'une fois.",
    codeIgnore: "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet e-mail, votre mot de passe reste inchangé.",
    secure: "Pour votre sécurité, ne partagez jamais ce code.",
  },
  es: {
    hello: "Hola",
    footer: "Recibes este mensaje porque tienes una cuenta en",
    team: "El equipo",
    codeTitle: "Tu código para restablecer la contraseña",
    codeIntro: "Usa el código de abajo para confirmar que eres tú y elegir una nueva contraseña.",
    codeExpiry: "El código caduca en 15 minutos y solo puede usarse una vez.",
    codeIgnore: "¿No lo solicitaste? Puedes ignorar este correo: tu contraseña no cambia.",
    secure: "Por tu seguridad, nunca compartas este código.",
  },
  de: {
    hello: "Hallo",
    footer: "Sie erhalten diese Nachricht, weil Sie ein Konto bei",
    team: "Das Team",
    codeTitle: "Ihr Code zum Zurücksetzen des Passworts",
    codeIntro: "Bestätigen Sie mit dem Code unten, dass Sie es sind, und wählen Sie ein neues Passwort.",
    codeExpiry: "Der Code läuft in 15 Minuten ab und ist einmal gültig.",
    codeIgnore: "Nicht angefordert? Ignorieren Sie diese E-Mail — Ihr Passwort bleibt unverändert.",
    secure: "Geben Sie diesen Code zu Ihrer Sicherheit niemals weiter.",
  },
  pt: {
    hello: "Olá",
    footer: "Você recebe esta mensagem porque tem uma conta em",
    team: "A equipe",
    codeTitle: "O seu código de redefinição de senha",
    codeIntro: "Use o código abaixo para confirmar que é você e escolher uma nova senha.",
    codeExpiry: "Este código expira em 15 minutos e só pode ser usado uma vez.",
    codeIgnore: "Não pediu isto? Pode ignorar este e-mail — a sua senha permanece igual.",
    secure: "Para sua segurança, nunca partilhe este código.",
  },
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

function siteUrl(): string {
  return env.APP_PUBLIC_URL.replace(/\/+$/, "");
}

/** Absolute logo URL — mail clients cannot resolve bundled assets. */
function logoUrl(): string {
  return `${siteUrl()}/email-logo.png`;
}

/** Shared branded shell: logo header, white card, quiet footer. */
function layout(input: { title: string; locale: string; content: string }): string {
  const copy = copyFor(input.locale);
  const site = env.APP_NAME;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:28px 16px;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
    <tr><td align="center" style="padding:6px 0 20px">
      <a href="${escapeHtml(siteUrl())}" style="text-decoration:none">
        <img src="${escapeHtml(logoUrl())}" alt="${escapeHtml(site)}" width="150" style="display:block;width:150px;max-width:60%;height:auto;border:0"/>
      </a>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;padding:30px 28px;box-shadow:0 12px 32px -24px rgba(15,23,42,.45)">
      ${input.content}
      <p style="margin:26px 0 0;color:#64748b;font-size:13px">${escapeHtml(copy.team)} ${escapeHtml(site)}</p>
    </td></tr>
    <tr><td align="center" style="padding:18px 6px;color:#94a3b8;font-size:12px;line-height:1.6">
      ${escapeHtml(copy.footer)} <a href="${escapeHtml(siteUrl())}" style="color:#64748b">${escapeHtml(site)}</a>.
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Turns a queued plain-text notification into a branded HTML email. Inline
 * styles only — mail clients ignore stylesheets.
 */
export function renderNotificationHtml(input: { subject: string; body: string; locale: string }): string {
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;line-height:1.65;color:#334155;font-size:15px">${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`,
    )
    .join("");

  return layout({
    title: input.subject,
    locale: input.locale,
    content: `<h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${escapeHtml(input.subject)}</h1>${paragraphs}`,
  });
}

/** The password reset email: one large 4-digit code, nothing else to click. */
export function renderPasswordResetHtml(input: { code: string; name?: string | null; locale: string }): string {
  const copy = copyFor(input.locale);
  const digits = input.code
    .split("")
    .map(
      (digit) =>
        `<td style="padding:0 5px"><div style="width:52px;height:64px;line-height:64px;text-align:center;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;font-size:30px;font-weight:700;color:#0f172a;letter-spacing:2px">${escapeHtml(digit)}</div></td>`,
    )
    .join("");

  return layout({
    title: copy.codeTitle,
    locale: input.locale,
    content: `
      <h1 style="margin:0 0 10px;font-size:22px;color:#0f172a">${escapeHtml(copy.codeTitle)}</h1>
      <p style="margin:0 0 6px;color:#334155;font-size:15px;line-height:1.65">${escapeHtml(greeting(input.locale, input.name))}</p>
      <p style="margin:0 0 22px;color:#334155;font-size:15px;line-height:1.65">${escapeHtml(copy.codeIntro)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 22px"><tr>${digits}</tr></table>
      <p style="margin:0 0 10px;color:#475569;font-size:14px;line-height:1.6">${escapeHtml(copy.codeExpiry)}</p>
      <p style="margin:0 0 10px;color:#475569;font-size:14px;line-height:1.6">${escapeHtml(copy.secure)}</p>
      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6">${escapeHtml(copy.codeIgnore)}</p>`,
  });
}

export function greeting(locale: string, name?: string | null): string {
  const copy = copyFor(locale);
  return name ? `${copy.hello} ${name},` : `${copy.hello},`;
}
