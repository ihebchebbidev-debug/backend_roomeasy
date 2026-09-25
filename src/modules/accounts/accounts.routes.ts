import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, created, noContent, ok } from "@/core/http.js";
import { email as emailField, password as passwordField, validateBody } from "@/core/validate.js";
import { env, isProduction } from "@/config/env.js";
import { queueNotification } from "@/modules/admin/notifications.repository.js";
import { dispatchQueuedEmails } from "@/modules/notifications/dispatcher.js";
import { currentUser, requireAuth, signAccessToken } from "@/middleware/auth.js";
import { rateLimit } from "@/middleware/rateLimit.js";
import {
  changePassword,
  createAccount,
  createPasswordResetCode,
  deleteOwnAccount,
  exchangeResetCodeForTicket,
  findAvatar,
  findAccountById,
  grantRole,
  recordCookieConsent,
  findAccountByEmail,
  submitIdentityDocument,
  resetPasswordForDev,
  resetPasswordWithToken,
  createEmailVerificationToken,
  createEmailVerificationTokenForEmail,
  verifyEmailWithToken,
  removeAvatar,
  saveAvatar,
  trustBadgesFor,
  updateProfile,
  verifyCredentials,
} from "@/modules/accounts/accounts.repository.js";
import type { AccountDto } from "@/modules/accounts/accounts.repository.js";
import {
  assertSecondFactor,
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
} from "@/modules/accounts/twoFactor.repository.js";
import { otpauthUrl } from "@/core/totp.js";

export const accountsRouter = Router();

const signupSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(120),
  email: emailField,
  password: passwordField,
  phone: z.string().trim().max(40).optional(),
  locale: z.enum(["en", "fr", "es", "de", "pt"]).optional(),
  currency: z.string().trim().length(3).optional(),
  /** A host signs up straight from "List your place". */
  asHost: z.boolean().optional(),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Enter your password."),
  otp: z.string().trim().max(12).optional(),
});

const profileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    locale: z.enum(["en", "fr", "es", "de", "pt"]).optional(),
    currency: z.string().trim().length(3).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Send at least one field to change.");

const avatarSchema = z.object({
  dataUrl: z.string().max(2_800_000, "The profile photo is too large."),
});

function decodeAvatar(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw apiError("UNSUPPORTED_MEDIA_TYPE", { message: "Choose a JPEG, PNG, or WebP image." });
  const contentType = match[1] as "image/jpeg" | "image/png" | "image/webp";
  const content = Buffer.from(match[2] ?? "", "base64");
  if (!content.length || content.length > 2 * 1024 * 1024) {
    throw apiError("PAYLOAD_TOO_LARGE", { message: "Keep the profile photo under 2 MB." });
  }
  const valid = contentType === "image/jpeg"
    ? content[0] === 0xff && content[1] === 0xd8
    : contentType === "image/png"
      ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw apiError("UNSUPPORTED_MEDIA_TYPE", { message: "The selected file is not a valid image." });
  return { content, contentType };
}

function session(account: AccountDto) {
  return {
    account,
    token: signAccessToken({
      sub: account.id,
      email: account.email,
      roles: account.roles,
      verified: account.verified,
    }),
  };
}

const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, name: "auth" });

accountsRouter.post(
  "/signup",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = validateBody(signupSchema, req);
    const account = await createAccount({
      fullName: body.fullName,
      email: body.email,
      password: body.password,
      phone: body.phone ?? null,
      locale: body.locale,
      currency: body.currency,
      roles: body.asHost ? ["guest", "host"] : ["guest"],
    });
    req.log.info({ userId: account.id, roles: account.roles }, "account created");

    const issued = await createEmailVerificationToken(account.id);
    if (issued) {
      const link = `${env.PUBLIC_APP_URL ?? ""}/verify-email?token=${encodeURIComponent(issued.token)}`;
      await queueNotification({
        recipientId: account.id,
        recipientEmail: account.email,
        template: "email_verification",
        subject: `Confirm your ${env.APP_NAME} email address`,
        body: [
          `Welcome to ${env.APP_NAME}, ${account.fullName}!`,
          "",
          `Please confirm your email address: ${link}`,
          "",
          "The link works once and expires in 48 hours. You can still use your account while it is unverified.",
        ].join("\n"),
        payload: { expiresAt: issued.expiresAt },
      });
      void dispatchQueuedEmails(5).catch((error) =>
        req.log.error({ err: error }, "verification email could not be sent immediately"),
      );
    }

    return created(res, session(account));
  }),
);

accountsRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = validateBody(loginSchema, req);
    const account = await verifyCredentials(body.email, body.password);
    // assertSecondFactor is a no-op for accounts that never enabled two-step
    // sign-in, and required (with a valid code) for everyone who has — admins
    // included, since they hold the most sensitive privileges on the platform.
    await assertSecondFactor(account.id, body.otp);
    req.log.info({ userId: account.id }, "sign-in succeeded");
    return ok(res, session(account));
  }),
);

/** Issues a fresh token for the current session (silent refresh). */
accountsRouter.post(
  "/refresh",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await findAccountById(currentUser(req).userId);
    if (!account) throw apiError("TOKEN_INVALID", { message: "The account on this session no longer exists." });
    return ok(res, session(account));
  }),
);

accountsRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await findAccountById(currentUser(req).userId);
    if (!account) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
    return ok(res, account);
  }),
);

accountsRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const patch = validateBody(profileSchema, req);
    const account = await updateProfile(currentUser(req).userId, patch);
    return ok(res, account);
  }),
);

accountsRouter.put(
  "/me/avatar",
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10, name: "avatar-upload" }),
  asyncHandler(async (req, res) => {
    const { dataUrl } = validateBody(avatarSchema, req);
    return ok(res, await saveAvatar(currentUser(req).userId, decodeAvatar(dataUrl)));
  }),
);

accountsRouter.delete(
  "/me/avatar",
  requireAuth,
  asyncHandler(async (req, res) => ok(res, await removeAvatar(currentUser(req).userId))),
);

accountsRouter.get(
  "/:userId/avatar",
  asyncHandler(async (req, res) => {
    const userId = z.string().uuid().parse(req.params["userId"]);
    const avatar = await findAvatar(userId);
    if (!avatar) throw apiError("NOT_FOUND", { message: "This account has no profile photo." });
    res.setHeader("Content-Type", avatar.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.setHeader("ETag", `W/\"${avatar.updatedAt.getTime()}-${avatar.content.length}\"`);
    return res.status(200).send(avatar.content);
  }),
);

accountsRouter.post(
  "/me/password",
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({ currentPassword: z.string().min(1, "Enter your current password."), newPassword: passwordField }),
      req,
    );
    await changePassword(currentUser(req).userId, body.currentPassword, body.newPassword);
    req.log.info({ userId: currentUser(req).userId }, "password changed");
    return noContent(res);
  }),
);

/**
 * "Become a host" — adds the host role and the public host profile. An identity
 * document is mandatory at this point (spec): it is filed as a pending check
 * for the back office to verify.
 */
accountsRouter.post(
  "/me/become-host",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({
        displayName: z.string().trim().min(2).max(120).optional(),
        documentKind: z.enum(["passport", "id_card", "driving_licence", "residence_permit"], {
          message: "Choose the kind of identity document you are providing.",
        }),
        documentReference: z
          .string()
          .trim()
          .min(4, "Enter the number shown on your identity document.")
          .max(80),
        documentFiles: z.array(z.string()).optional(),
      }),
      req,
    );
    const userId = currentUser(req).userId;
    const account = await grantRole(userId, "host", body.displayName);
    await submitIdentityDocument({
      userId,
      documentKind: body.documentKind,
      documentReference: body.documentReference,
      documentFiles: body.documentFiles,
    });
    req.log.info({ userId, documentKind: body.documentKind }, "host identity document filed");
    return ok(res, account);
  }),
);

/**
 * GDPR erasure. The password is required, the member is told why it is refused
 * when a stay or a payout is still live, and the token dies with the account.
 */
accountsRouter.delete(
  "/me",
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({
        password: z.string().min(1, "Enter your password to confirm."),
        reason: z.string().trim().max(500).optional(),
      }),
      req,
    );
    const userId = currentUser(req).userId;
    const result = await deleteOwnAccount({ userId, password: body.password, reason: body.reason ?? null });
    req.log.info({ userId }, "account erased at the member's request");
    return ok(res, result);
  }),
);


accountsRouter.get(
  "/me/trust-badges",
  requireAuth,
  asyncHandler(async (req, res) => ok(res, await trustBadgesFor(currentUser(req).userId))),
);

accountsRouter.post(
  "/forgot-password",
  rateLimit({ windowMs: 15 * 60_000, max: 10, name: "forgot-password" }),
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ email: emailField }), req);
    const issued = await createPasswordResetCode(body.email, req.ip ?? null);

    // A real address gets the code by email; the reply below stays identical
    // either way so the endpoint cannot be used to enumerate accounts.
    if (issued) {
      await queueNotification({
        recipientEmail: body.email,
        template: "password_reset",
        subject: `${issued.code} is your ${env.APP_NAME} verification code`,
        body: [
          `We received a request to choose a new password for your ${env.APP_NAME} account.`,
          "",
          `Your verification code is: ${issued.code}`,
          "",
          "Enter it on the password reset screen. The code works once and expires in 15 minutes.",
          "If you did not ask for this, you can ignore this message — your password stays unchanged.",
        ].join("\n"),
        payload: { expiresAt: issued.expiresAt, code: issued.code, name: issued.fullName },
      });
      // Password resets are time-sensitive: flush the queue now instead of
      // waiting for the background worker's next tick.
      void dispatchQueuedEmails(5).catch((error) =>
        req.log.error({ err: error }, "password reset email could not be sent immediately"),
      );
    }

    req.log.info({ email: body.email, issued: Boolean(issued) }, "password reset requested");

    return ok(res, {
      message: "If an account uses that address, a 4-digit code is on its way.",
      // Outside production the code is returned so the flow is testable
      // before an email provider is connected.
      ...(isProduction || !issued ? {} : { devCode: issued.code, expiresAt: issued.expiresAt }),
    });
  }),
);

/** Step two: the 4-digit code is traded for a single-use ticket. */
accountsRouter.post(
  "/verify-reset-code",
  rateLimit({ windowMs: 15 * 60_000, max: 10, name: "verify-reset-code" }),
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({
        email: emailField,
        code: z.string().trim().regex(/^\d{4}$/, "Enter the 4-digit code from your email."),
      }),
      req,
    );
    const ticket = await exchangeResetCodeForTicket(body.email, body.code);
    return ok(res, { message: "Code confirmed. Choose a new password.", ...ticket });
  }),
);

accountsRouter.post(
  "/reset-password",
  rateLimit({ windowMs: 15 * 60_000, max: 20, name: "reset-password" }),
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ token: z.string().min(10, "This reset request is not valid."), password: passwordField }), req);
    await resetPasswordWithToken(body.token, body.password);
    return ok(res, { message: "Your password has been changed. Sign in with the new password." });
  }),
);

accountsRouter.post(
  "/verify-email",
  rateLimit({ windowMs: 15 * 60_000, max: 20, name: "verify-email" }),
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ token: z.string().min(10, "This verification link is not valid.") }), req);
    await verifyEmailWithToken(body.token);
    return ok(res, { message: "Your email address has been confirmed." });
  }),
);

accountsRouter.post(
  "/resend-verification",
  rateLimit({ windowMs: 15 * 60_000, max: 5, name: "resend-verification" }),
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ email: emailField }), req);
    const issued = await createEmailVerificationTokenForEmail(body.email);
    if (issued) {
      const link = `${env.PUBLIC_APP_URL ?? ""}/verify-email?token=${encodeURIComponent(issued.token)}`;
      await queueNotification({
        recipientId: issued.userId,
        recipientEmail: body.email,
        template: "email_verification",
        subject: `Confirm your ${env.APP_NAME} email address`,
        body: [
          `Please confirm your email address: ${link}`,
          "",
          "The link works once and expires in 48 hours.",
        ].join("\n"),
        payload: { expiresAt: issued.expiresAt },
      });
      void dispatchQueuedEmails(5).catch((error) =>
        req.log.error({ err: error }, "verification email could not be sent immediately"),
      );
    }
    return ok(res, { message: "If that address needs confirming, a new link is on its way." });
  }),
);

/**
 * Development-only helper behind the hidden /dev-admin screen: creates an
 * administrator (or promotes an existing account) so every back-office feature
 * can be tried without touching the database by hand. Disabled in production.
 */
accountsRouter.post(
  "/dev/admin",
  authLimiter,
  asyncHandler(async (req, res) => {
    if (isProduction) throw apiError("FORBIDDEN", { message: "This helper is disabled in production." });
    // Defence in depth: even outside production, a shared secret is required.
    const secret = req.get("x-dev-admin-secret") ?? "";
    if (!env.DEV_ADMIN_SECRET || secret !== env.DEV_ADMIN_SECRET) {
      throw apiError("FORBIDDEN", { message: "The dev admin secret is missing or wrong." });
    }

    const body = validateBody(
      z.object({
        fullName: z.string().trim().min(2).max(120).optional(),
        email: emailField,
        password: passwordField,
      }),
      req,
    );

    const existing = await findAccountByEmail(body.email);
    if (existing) {
      await resetPasswordForDev(existing.id, body.password);
      const account = await grantRole(existing.id, "admin");
      req.log.warn({ userId: account.id }, "existing account promoted to admin (dev helper)");
      return ok(res, { ...session(account), created: false });
    }

    const account = await createAccount({
      fullName: body.fullName ?? "Platform administrator",
      email: body.email,
      password: body.password,
      roles: ["admin", "guest"],
    });
    req.log.warn({ userId: account.id }, "admin account created (dev helper)");
    return created(res, { ...session(account), created: true });
  }),
);

accountsRouter.post(
  "/cookie-consent",
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({ choice: z.enum(["accepted", "essential"]), deviceId: z.string().trim().max(120).optional() }),
      req,
    );
    await recordCookieConsent({
      userId: req.auth?.userId ?? null,
      deviceId: body.deviceId ?? null,
      choice: body.choice,
    });
    return noContent(res);
  }),
);

/** Two-step sign-in (authenticator app). Available to every member, recommended for admins. */
accountsRouter.post(
  "/2fa/setup",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const secret = await beginTwoFactorSetup(user.userId);
    return ok(res, { secret, otpauthUrl: otpauthUrl({ issuer: env.TOTP_ISSUER, account: user.email, secret }) });
  }),
);

accountsRouter.post(
  "/2fa/enable",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ code: z.string().trim().min(6).max(12) }), req);
    await confirmTwoFactorSetup(currentUser(req).userId, body.code);
    return ok(res, { enabled: true });
  }),
);

accountsRouter.post(
  "/2fa/disable",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ code: z.string().trim().max(12).default("") }), req);
    await disableTwoFactor(currentUser(req).userId, body.code);
    return ok(res, { enabled: false });
  }),
);
