/**
 * Template catalogue for every transactional email the outbox can send.
 *
 * A caller queues a `template` key plus a flat `data` bag of placeholders;
 * `renderTemplate` looks up the recipient's locale copy and interpolates
 * `{{placeholder}}` tokens. Anything not covered by a placeholder is dropped
 * silently, so a template never crashes on missing optional data.
 */

export type Locale = "en" | "fr" | "es" | "de" | "pt";

export const SUPPORTED_LOCALES: Locale[] = ["en", "fr", "es", "de", "pt"];

export function normalizeLocale(locale: string | null | undefined): Locale {
  const short = (locale ?? "").slice(0, 2).toLowerCase();
  return (SUPPORTED_LOCALES as string[]).includes(short) ? (short as Locale) : "fr";
}

/** Every template the outbox knows how to render. */
export type TemplateKey =
  | "listing_approved"
  | "listing_rejected"
  | "listing_suspended"
  | "account_suspended"
  | "account_restored"
  | "account_banned"
  | "identity_verified"
  | "identity_rejected"
  | "booking_cancelled_by_admin"
  | "booking_refunded"
  | "commission_updated"
  | "support_reply"
  | "payouts_ready"
  | "booking_confirmed"
  | "payment_failed"
  | "password_reset"
  | "email_verification"
  | "booking_requested_guest"
  | "booking_requested_host"
  | "booking_confirmed_guest"
  | "booking_confirmed_host"
  | "booking_declined_guest"
  | "booking_cancelled_by_guest"
  | "booking_cancelled_by_host"
  | "booking_cancelled_by_system"
  | "new_message";

export type TemplateData = Record<string, string | number | null | undefined>;

type TemplateCopy = { subject: string; body: string };
type TemplateEntry = Record<Locale, TemplateCopy>;

function interpolate(text: string, data: TemplateData): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = data[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

/**
 * Every template, every locale. Placeholders in scope across bookings:
 * {{reference}} {{stayName}} {{checkIn}} {{checkOut}} {{total}} {{link}}
 * {{guestName}} {{hostName}} {{reason}} {{refundUsd}} {{amountUsd}}
 * {{commissionRate}} {{message}}
 */
const CATALOGUE: Record<TemplateKey, TemplateEntry> = {
  listing_approved: {
    en: { subject: "Your listing is now live", body: "Good news — your listing has been approved and is now visible to guests." },
    fr: { subject: "Votre annonce est en ligne", body: "Bonne nouvelle : votre annonce a été approuvée et est désormais visible par les voyageurs." },
    es: { subject: "Tu anuncio ya está publicado", body: "Buenas noticias: tu anuncio ha sido aprobado y ya es visible para los huéspedes." },
    de: { subject: "Ihr Inserat ist jetzt online", body: "Gute Neuigkeiten — Ihr Inserat wurde genehmigt und ist jetzt für Gäste sichtbar." },
    pt: { subject: "O seu anúncio já está publicado", body: "Boas notícias — o seu anúncio foi aprovado e já está visível para os hóspedes." },
  },
  listing_rejected: {
    en: { subject: "Your listing needs changes", body: "An administrator reviewed your listing and it could not be approved yet. Reason: {{reason}}" },
    fr: { subject: "Votre annonce nécessite des modifications", body: "Un administrateur a examiné votre annonce et elle n'a pas pu être approuvée pour l'instant. Motif : {{reason}}" },
    es: { subject: "Tu anuncio necesita cambios", body: "Un administrador revisó tu anuncio y todavía no pudo aprobarse. Motivo: {{reason}}" },
    de: { subject: "Ihr Inserat benötigt Änderungen", body: "Ein Administrator hat Ihr Inserat geprüft; es konnte noch nicht genehmigt werden. Grund: {{reason}}" },
    pt: { subject: "O seu anúncio precisa de alterações", body: "Um administrador analisou o seu anúncio e ainda não pôde ser aprovado. Motivo: {{reason}}" },
  },
  listing_suspended: {
    en: { subject: "Your listing has been taken offline", body: "An administrator has taken your listing offline. Reason: {{reason}}" },
    fr: { subject: "Votre annonce a été mise hors ligne", body: "Un administrateur a mis votre annonce hors ligne. Motif : {{reason}}" },
    es: { subject: "Tu anuncio ha sido retirado", body: "Un administrador ha retirado tu anuncio. Motivo: {{reason}}" },
    de: { subject: "Ihr Inserat wurde offline genommen", body: "Ein Administrator hat Ihr Inserat offline genommen. Grund: {{reason}}" },
    pt: { subject: "O seu anúncio foi retirado do ar", body: "Um administrador retirou o seu anúncio do ar. Motivo: {{reason}}" },
  },
  account_suspended: {
    en: { subject: "Your account has been suspended", body: "Your account was temporarily suspended. Reason: {{reason}}" },
    fr: { subject: "Votre compte a été suspendu", body: "Votre compte a été temporairement suspendu. Motif : {{reason}}" },
    es: { subject: "Tu cuenta ha sido suspendida", body: "Tu cuenta ha sido suspendida temporalmente. Motivo: {{reason}}" },
    de: { subject: "Ihr Konto wurde gesperrt", body: "Ihr Konto wurde vorübergehend gesperrt. Grund: {{reason}}" },
    pt: { subject: "A sua conta foi suspensa", body: "A sua conta foi temporariamente suspensa. Motivo: {{reason}}" },
  },
  account_restored: {
    en: { subject: "Your account is active again", body: "Your account has been restored. You can sign in normally." },
    fr: { subject: "Votre compte est de nouveau actif", body: "Votre compte a été rétabli. Vous pouvez vous connecter normalement." },
    es: { subject: "Tu cuenta está activa de nuevo", body: "Tu cuenta ha sido restablecida. Puedes iniciar sesión con normalidad." },
    de: { subject: "Ihr Konto ist wieder aktiv", body: "Ihr Konto wurde wiederhergestellt. Sie können sich wie gewohnt anmelden." },
    pt: { subject: "A sua conta está ativa novamente", body: "A sua conta foi restaurada. Pode iniciar sessão normalmente." },
  },
  account_banned: {
    en: { subject: "Your RoomEasy account has been closed", body: "An administrator has permanently closed your account. Reason: {{reason}}" },
    fr: { subject: "Votre compte RoomEasy a été clôturé", body: "Un administrateur a définitivement clôturé votre compte. Motif : {{reason}}" },
    es: { subject: "Tu cuenta de RoomEasy ha sido cerrada", body: "Un administrador ha cerrado tu cuenta de forma permanente. Motivo: {{reason}}" },
    de: { subject: "Ihr RoomEasy-Konto wurde geschlossen", body: "Ein Administrator hat Ihr Konto dauerhaft geschlossen. Grund: {{reason}}" },
    pt: { subject: "A sua conta RoomEasy foi encerrada", body: "Um administrador encerrou permanentemente a sua conta. Motivo: {{reason}}" },
  },
  identity_verified: {
    en: { subject: "Your identity is verified", body: "Your identity has been verified. Your account is now fully active." },
    fr: { subject: "Votre identité est vérifiée", body: "Votre identité a été vérifiée. Votre compte est désormais pleinement actif." },
    es: { subject: "Tu identidad ha sido verificada", body: "Tu identidad ha sido verificada. Tu cuenta ya está totalmente activa." },
    de: { subject: "Ihre Identität ist verifiziert", body: "Ihre Identität wurde verifiziert. Ihr Konto ist jetzt vollständig aktiv." },
    pt: { subject: "A sua identidade foi verificada", body: "A sua identidade foi verificada. A sua conta está agora totalmente ativa." },
  },
  identity_rejected: {
    en: { subject: "We could not verify your identity", body: "We could not verify your identity. {{reason}}" },
    fr: { subject: "Nous n'avons pas pu vérifier votre identité", body: "Nous n'avons pas pu vérifier votre identité. {{reason}}" },
    es: { subject: "No pudimos verificar tu identidad", body: "No pudimos verificar tu identidad. {{reason}}" },
    de: { subject: "Wir konnten Ihre Identität nicht verifizieren", body: "Wir konnten Ihre Identität nicht verifizieren. {{reason}}" },
    pt: { subject: "Não conseguimos verificar a sua identidade", body: "Não conseguimos verificar a sua identidade. {{reason}}" },
  },
  booking_cancelled_by_admin: {
    en: { subject: "Booking {{reference}} has been cancelled", body: "An administrator cancelled your booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}). Reason: {{reason}}. Refund: {{refundUsd}} USD.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} a été annulée", body: "Un administrateur a annulé votre réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}). Motif : {{reason}}. Remboursement : {{refundUsd}} USD.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} ha sido cancelada", body: "Un administrador canceló tu reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Motivo: {{reason}}. Reembolso: {{refundUsd}} USD.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} wurde storniert", body: "Ein Administrator hat Ihre Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) storniert. Grund: {{reason}}. Erstattung: {{refundUsd}} USD.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} foi cancelada", body: "Um administrador cancelou a sua reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Motivo: {{reason}}. Reembolso: {{refundUsd}} USD.\n\nVer a reserva: {{link}}" },
  },
  booking_refunded: {
    en: { subject: "A refund of {{amountUsd}} USD has been issued", body: "We refunded {{amountUsd}} USD on booking {{reference}}. Reason: {{reason}}\n\nView the booking: {{link}}" },
    fr: { subject: "Un remboursement de {{amountUsd}} USD a été émis", body: "Nous avons remboursé {{amountUsd}} USD sur la réservation {{reference}}. Motif : {{reason}}\n\nVoir la réservation : {{link}}" },
    es: { subject: "Se emitió un reembolso de {{amountUsd}} USD", body: "Reembolsamos {{amountUsd}} USD en la reserva {{reference}}. Motivo: {{reason}}\n\nVer la reserva: {{link}}" },
    de: { subject: "Eine Erstattung von {{amountUsd}} USD wurde ausgestellt", body: "Wir haben {{amountUsd}} USD für die Buchung {{reference}} erstattet. Grund: {{reason}}\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "Foi emitido um reembolso de {{amountUsd}} USD", body: "Reembolsámos {{amountUsd}} USD na reserva {{reference}}. Motivo: {{reason}}\n\nVer a reserva: {{link}}" },
  },
  commission_updated: {
    en: { subject: "Your commission rate has changed", body: "{{commissionRate}}" },
    fr: { subject: "Votre taux de commission a changé", body: "{{commissionRate}}" },
    es: { subject: "Tu tasa de comisión ha cambiado", body: "{{commissionRate}}" },
    de: { subject: "Ihr Provisionssatz hat sich geändert", body: "{{commissionRate}}" },
    pt: { subject: "A sua taxa de comissão foi alterada", body: "{{commissionRate}}" },
  },
  support_reply: {
    en: { subject: "Reply to your request {{reference}}", body: "You have a new reply to your support request {{reference}}:\n\n{{message}}" },
    fr: { subject: "Réponse à votre demande {{reference}}", body: "Vous avez une nouvelle réponse à votre demande d'assistance {{reference}} :\n\n{{message}}" },
    es: { subject: "Respuesta a tu solicitud {{reference}}", body: "Tienes una nueva respuesta a tu solicitud de soporte {{reference}}:\n\n{{message}}" },
    de: { subject: "Antwort auf Ihre Anfrage {{reference}}", body: "Sie haben eine neue Antwort auf Ihre Support-Anfrage {{reference}} erhalten:\n\n{{message}}" },
    pt: { subject: "Resposta ao seu pedido {{reference}}", body: "Tem uma nova resposta ao seu pedido de suporte {{reference}}:\n\n{{message}}" },
  },
  payouts_ready: {
    en: { subject: "Your payout account is ready", body: "Your bank details are verified. Payouts for your completed stays will now be sent automatically." },
    fr: { subject: "Votre compte de versement est prêt", body: "Vos coordonnées bancaires sont vérifiées. Les versements pour vos séjours terminés seront désormais envoyés automatiquement." },
    es: { subject: "Tu cuenta de pagos está lista", body: "Tus datos bancarios están verificados. Los pagos de tus estancias completadas se enviarán automáticamente." },
    de: { subject: "Ihr Auszahlungskonto ist bereit", body: "Ihre Bankdaten sind verifiziert. Auszahlungen für abgeschlossene Aufenthalte werden nun automatisch gesendet." },
    pt: { subject: "A sua conta de pagamentos está pronta", body: "Os seus dados bancários foram verificados. Os pagamentos das suas estadias concluídas serão agora enviados automaticamente." },
  },
  booking_confirmed: {
    en: { subject: "Booking {{reference}} is confirmed", body: "Your booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}) is confirmed. Total: {{total}}.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} est confirmée", body: "Votre réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}) est confirmée. Total : {{total}}.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} está confirmada", body: "Tu reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) está confirmada. Total: {{total}}.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} ist bestätigt", body: "Ihre Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) ist bestätigt. Gesamt: {{total}}.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} está confirmada", body: "A sua reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) está confirmada. Total: {{total}}.\n\nVer a reserva: {{link}}" },
  },
  payment_failed: {
    en: { subject: "We could not process your payment", body: "The payment for booking {{reference}} could not be processed. Please update your payment details." },
    fr: { subject: "Nous n'avons pas pu traiter votre paiement", body: "Le paiement de la réservation {{reference}} n'a pas pu être traité. Veuillez mettre à jour vos informations de paiement." },
    es: { subject: "No pudimos procesar tu pago", body: "El pago de la reserva {{reference}} no pudo procesarse. Actualiza tus datos de pago." },
    de: { subject: "Wir konnten Ihre Zahlung nicht verarbeiten", body: "Die Zahlung für die Buchung {{reference}} konnte nicht verarbeitet werden. Bitte aktualisieren Sie Ihre Zahlungsdaten." },
    pt: { subject: "Não conseguimos processar o seu pagamento", body: "O pagamento da reserva {{reference}} não pôde ser processado. Atualize os seus dados de pagamento." },
  },
  password_reset: {
    en: { subject: "Your verification code", body: "Your verification code is: {{code}}" },
    fr: { subject: "Votre code de vérification", body: "Votre code de vérification est : {{code}}" },
    es: { subject: "Tu código de verificación", body: "Tu código de verificación es: {{code}}" },
    de: { subject: "Ihr Verifizierungscode", body: "Ihr Verifizierungscode lautet: {{code}}" },
    pt: { subject: "O seu código de verificação", body: "O seu código de verificação é: {{code}}" },
  },
  email_verification: {
    en: { subject: "Confirm your email address", body: "Please confirm your email address: {{link}}" },
    fr: { subject: "Confirmez votre adresse e-mail", body: "Veuillez confirmer votre adresse e-mail : {{link}}" },
    es: { subject: "Confirma tu correo electrónico", body: "Confirma tu dirección de correo: {{link}}" },
    de: { subject: "Bestätigen Sie Ihre E-Mail-Adresse", body: "Bitte bestätigen Sie Ihre E-Mail-Adresse: {{link}}" },
    pt: { subject: "Confirme o seu e-mail", body: "Confirme o seu endereço de e-mail: {{link}}" },
  },
  booking_requested_guest: {
    en: { subject: "Your request for {{stayName}} was sent", body: "Your booking request {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}) was sent to the host. Total: {{total}}. You will be notified as soon as it is answered.\n\nView the booking: {{link}}" },
    fr: { subject: "Votre demande pour {{stayName}} a été envoyée", body: "Votre demande de réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}) a été envoyée à l'hôte. Total : {{total}}. Vous serez averti dès qu'elle sera traitée.\n\nVoir la réservation : {{link}}" },
    es: { subject: "Tu solicitud para {{stayName}} fue enviada", body: "Tu solicitud de reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) fue enviada al anfitrión. Total: {{total}}. Te avisaremos en cuanto responda.\n\nVer la reserva: {{link}}" },
    de: { subject: "Ihre Anfrage für {{stayName}} wurde gesendet", body: "Ihre Buchungsanfrage {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) wurde an den Gastgeber gesendet. Gesamt: {{total}}. Sie werden benachrichtigt, sobald geantwortet wurde.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "O seu pedido para {{stayName}} foi enviado", body: "O seu pedido de reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) foi enviado ao anfitrião. Total: {{total}}. Será avisado assim que houver resposta.\n\nVer a reserva: {{link}}" },
  },
  booking_requested_host: {
    en: { subject: "New booking request: {{stayName}}", body: "{{guestName}} requested to book {{stayName}} ({{checkIn}} → {{checkOut}}). Reference: {{reference}}. Total: {{total}}.\n\nAnswer the request: {{link}}" },
    fr: { subject: "Nouvelle demande de réservation : {{stayName}}", body: "{{guestName}} a demandé à réserver {{stayName}} ({{checkIn}} → {{checkOut}}). Référence : {{reference}}. Total : {{total}}.\n\nRépondre à la demande : {{link}}" },
    es: { subject: "Nueva solicitud de reserva: {{stayName}}", body: "{{guestName}} solicitó reservar {{stayName}} ({{checkIn}} → {{checkOut}}). Referencia: {{reference}}. Total: {{total}}.\n\nResponder a la solicitud: {{link}}" },
    de: { subject: "Neue Buchungsanfrage: {{stayName}}", body: "{{guestName}} hat angefragt, {{stayName}} ({{checkIn}} → {{checkOut}}) zu buchen. Referenz: {{reference}}. Gesamt: {{total}}.\n\nAuf die Anfrage antworten: {{link}}" },
    pt: { subject: "Novo pedido de reserva: {{stayName}}", body: "{{guestName}} pediu para reservar {{stayName}} ({{checkIn}} → {{checkOut}}). Referência: {{reference}}. Total: {{total}}.\n\nResponder ao pedido: {{link}}" },
  },
  booking_confirmed_guest: {
    en: { subject: "Booking {{reference}} is confirmed", body: "Great news! Your booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}) is confirmed. Total: {{total}}.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} est confirmée", body: "Bonne nouvelle ! Votre réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}) est confirmée. Total : {{total}}.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} está confirmada", body: "¡Buenas noticias! Tu reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) está confirmada. Total: {{total}}.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} ist bestätigt", body: "Gute Nachrichten! Ihre Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) ist bestätigt. Gesamt: {{total}}.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} está confirmada", body: "Ótimas notícias! A sua reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) está confirmada. Total: {{total}}.\n\nVer a reserva: {{link}}" },
  },
  booking_confirmed_host: {
    en: { subject: "Booking {{reference}} is confirmed", body: "The booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}) with {{guestName}} is confirmed. Total: {{total}}.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} est confirmée", body: "La réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}) avec {{guestName}} est confirmée. Total : {{total}}.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} está confirmada", body: "La reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) con {{guestName}} está confirmada. Total: {{total}}.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} ist bestätigt", body: "Die Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) mit {{guestName}} ist bestätigt. Gesamt: {{total}}.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} está confirmada", body: "A reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) com {{guestName}} está confirmada. Total: {{total}}.\n\nVer a reserva: {{link}}" },
  },
  booking_declined_guest: {
    en: { subject: "Booking {{reference}} was declined", body: "The host declined your booking request {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}). Any amount held has been refunded in full.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} a été refusée", body: "L'hôte a refusé votre demande de réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}). Toute somme retenue a été intégralement remboursée.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} fue rechazada", body: "El anfitrión rechazó tu solicitud de reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Cualquier importe retenido ha sido reembolsado íntegramente.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} wurde abgelehnt", body: "Der Gastgeber hat Ihre Buchungsanfrage {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) abgelehnt. Ein gehaltener Betrag wurde vollständig erstattet.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} foi recusada", body: "O anfitrião recusou o seu pedido de reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Qualquer valor retido foi totalmente reembolsado.\n\nVer a reserva: {{link}}" },
  },
  booking_cancelled_by_guest: {
    en: { subject: "Booking {{reference}} was cancelled by the guest", body: "The guest cancelled the booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}). Refund issued to the guest: {{refundUsd}} USD.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} a été annulée par le voyageur", body: "Le voyageur a annulé la réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}). Remboursement émis au voyageur : {{refundUsd}} USD.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} fue cancelada por el huésped", body: "El huésped canceló la reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Reembolso emitido al huésped: {{refundUsd}} USD.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} wurde vom Gast storniert", body: "Der Gast hat die Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) storniert. Erstattung an den Gast: {{refundUsd}} USD.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} foi cancelada pelo hóspede", body: "O hóspede cancelou a reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Reembolso emitido ao hóspede: {{refundUsd}} USD.\n\nVer a reserva: {{link}}" },
  },
  booking_cancelled_by_host: {
    en: { subject: "Booking {{reference}} was cancelled by the host", body: "The host cancelled the booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}). Refund: {{refundUsd}} USD.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} a été annulée par l'hôte", body: "L'hôte a annulé la réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}). Remboursement : {{refundUsd}} USD.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} fue cancelada por el anfitrión", body: "El anfitrión canceló la reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Reembolso: {{refundUsd}} USD.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} wurde vom Gastgeber storniert", body: "Der Gastgeber hat die Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) storniert. Erstattung: {{refundUsd}} USD.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} foi cancelada pelo anfitrião", body: "O anfitrião cancelou a reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}). Reembolso: {{refundUsd}} USD.\n\nVer a reserva: {{link}}" },
  },
  booking_cancelled_by_system: {
    en: { subject: "Booking {{reference}} was cancelled", body: "The booking {{reference}} for {{stayName}} ({{checkIn}} → {{checkOut}}) was cancelled automatically. Refund: {{refundUsd}} USD.\n\nView the booking: {{link}}" },
    fr: { subject: "La réservation {{reference}} a été annulée", body: "La réservation {{reference}} pour {{stayName}} ({{checkIn}} → {{checkOut}}) a été annulée automatiquement. Remboursement : {{refundUsd}} USD.\n\nVoir la réservation : {{link}}" },
    es: { subject: "La reserva {{reference}} fue cancelada", body: "La reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) fue cancelada automáticamente. Reembolso: {{refundUsd}} USD.\n\nVer la reserva: {{link}}" },
    de: { subject: "Buchung {{reference}} wurde storniert", body: "Die Buchung {{reference}} für {{stayName}} ({{checkIn}} → {{checkOut}}) wurde automatisch storniert. Erstattung: {{refundUsd}} USD.\n\nBuchung ansehen: {{link}}" },
    pt: { subject: "A reserva {{reference}} foi cancelada", body: "A reserva {{reference}} para {{stayName}} ({{checkIn}} → {{checkOut}}) foi cancelada automaticamente. Reembolso: {{refundUsd}} USD.\n\nVer a reserva: {{link}}" },
  },
  new_message: {
    en: { subject: "New message from {{senderName}}", body: "{{senderName}} sent you a message about {{stayName}}:\n\n\"{{excerpt}}\"\n\nReply here: {{link}}" },
    fr: { subject: "Nouveau message de {{senderName}}", body: "{{senderName}} vous a envoyé un message à propos de {{stayName}} :\n\n« {{excerpt}} »\n\nRépondez ici : {{link}}" },
    es: { subject: "Nuevo mensaje de {{senderName}}", body: "{{senderName}} te envió un mensaje sobre {{stayName}}:\n\n«{{excerpt}}»\n\nResponde aquí: {{link}}" },
    de: { subject: "Neue Nachricht von {{senderName}}", body: "{{senderName}} hat Ihnen eine Nachricht zu {{stayName}} gesendet:\n\n„{{excerpt}}“\n\nHier antworten: {{link}}" },
    pt: { subject: "Nova mensagem de {{senderName}}", body: "{{senderName}} enviou-lhe uma mensagem sobre {{stayName}}:\n\n\"{{excerpt}}\"\n\nResponda aqui: {{link}}" },
  },
};

export function renderTemplate(template: TemplateKey, locale: string | null | undefined, data: TemplateData = {}): TemplateCopy {
  const entry = CATALOGUE[template];
  const copy = entry[normalizeLocale(locale)];
  return { subject: interpolate(copy.subject, data), body: interpolate(copy.body, data) };
}

export function bookingLink(bookingId: string): string {
  const base = process.env["PUBLIC_APP_URL"] || process.env["APP_URL"] || "https://roomeasy.fr";
  return `${base.replace(/\/+$/, "")}/bookings/${bookingId}`;
}
