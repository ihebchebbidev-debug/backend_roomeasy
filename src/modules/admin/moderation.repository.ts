import { query } from "@/db/query.js";

export type ModerationAction =
  | "review_hidden"
  | "review_restored"
  | "review_deleted"
  | "user_suspended"
  | "user_restored"
  | "listing_suspended"
  | "listing_published"
  | "listing_approved"
  | "listing_rejected"
  | "settings_updated"
  | "role_granted"
  | "role_revoked"
  | "payout_created"
  | "payout_paid"
  | "user_verification_updated"
  | "user_banned"
  | "user_unbanned"
  | "listing_report_resolved"
  | "listing_report_dismissed"
  | "booking_cancelled_admin"
  | "booking_refunded"
  | "booking_modified"
  | "ticket_assigned"
  | "ticket_status_changed"
  | "ticket_action_taken"
  | "commission_updated"
  | "taxonomy_updated"
  | "content_updated"
  | "translation_updated"
  | "two_factor_reset"
  | "identity_synced";

/** Append-only audit trail for every privileged action. */
export async function recordModeration(entry: {
  adminId: string | null;
  action: ModerationAction;
  targetKind: "review" | "user" | "listing" | "settings" | "payout" | "booking" | "report" | "ticket" | "commission";
  targetId: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO moderation_log (admin_id, action, target_kind, target_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.adminId,
      entry.action,
      entry.targetKind,
      entry.targetId,
      entry.reason ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
    { label: "moderation.record" },
  );
}

export async function listModerationLog(options: { limit: number; offset: number }) {
  const rows = await query<{
    id: string;
    action: ModerationAction;
    target_kind: string;
    target_id: string;
    reason: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
    admin_name: string | null;
  }>(
    `SELECT m.id, m.action, m.target_kind, m.target_id, m.reason, m.metadata, m.created_at,
            u.full_name AS admin_name
       FROM moderation_log m
       LEFT JOIN app_user u ON u.id = m.admin_id
      ORDER BY m.created_at DESC
      LIMIT $1 OFFSET $2`,
    [options.limit, options.offset],
    { label: "moderation.list" },
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    target: { kind: row.target_kind, id: row.target_id },
    reason: row.reason,
    metadata: row.metadata,
    adminName: row.admin_name,
    createdAt: row.created_at.toISOString(),
  }));
}
