import { apiError } from "@/core/errors.js";
import { query, queryOne } from "@/db/query.js";

export type ReportReason = "fraud" | "inappropriate" | "wrong_information" | "unavailable" | "safety" | "other";
export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";

type ReportRow = {
  id: string;
  listing_id: string;
  property_name: string | null;
  host_id: string | null;
  host_name: string | null;
  reporter_name: string | null;
  reported_by: string | null;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  handled_at: Date | null;
  created_at: Date;
};

function mapReport(row: ReportRow) {
  return {
    id: row.id,
    listingId: row.listing_id,
    propertyName: row.property_name,
    hostId: row.host_id,
    hostName: row.host_name,
    reporterId: row.reported_by,
    reporterName: row.reporter_name,
    reason: row.reason,
    details: row.details,
    status: row.status,
    resolution: row.resolution,
    handledAt: row.handled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const selectReport = `
  SELECT r.id, r.listing_id, p.name AS property_name, p.host_id, hu.full_name AS host_name,
         r.reporter_name, r.reported_by, r.reason, r.details, r.status, r.resolution,
         r.handled_at, r.created_at
    FROM listing_report r
    LEFT JOIN listing l ON l.id = r.listing_id
    LEFT JOIN property p ON p.id = l.property_id
    LEFT JOIN app_user hu ON hu.id = p.host_id`;

/**
 * Accepts a listing id or the property id shown in the address bar — the stay
 * page does not always know the listing row behind the property.
 */
async function resolveListingId(reference: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM listing WHERE id = $1
     UNION ALL
     SELECT id FROM listing WHERE property_id = $1
     LIMIT 1`,
    [reference],
    { label: "reports.resolveListing" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That listing does not exist." });
  return row.id;
}

/** A guest or host flags a listing. */
export async function createListingReport(input: {
  listingId: string;
  reportedBy: string | null;
  reporterName: string | null;
  reason: ReportReason;
  details?: string | null;
}) {
  const listingId = await resolveListingId(input.listingId);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO listing_report (listing_id, reported_by, reporter_name, reason, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [listingId, input.reportedBy, input.reporterName, input.reason, input.details ?? null],
    { label: "reports.create" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That listing does not exist." });
  return getListingReport(row.id);
}

export async function getListingReport(id: string) {
  const row = await queryOne<ReportRow>(`${selectReport} WHERE r.id = $1`, [id], { label: "reports.get" });
  if (!row) throw apiError("NOT_FOUND", { message: "That report does not exist." });
  return mapReport(row);
}

export async function listListingReports(options: {
  limit: number;
  offset: number;
  status?: ReportStatus | "all";
  listingId?: string;
}) {
  const status = !options.status || options.status === "all" ? null : options.status;
  const rows = await query<ReportRow & { total: string }>(
    `${selectReport}
      WHERE ($3::report_status IS NULL OR r.status = $3::report_status)
        AND ($4::text IS NULL OR r.listing_id = $4)
      ORDER BY r.created_at DESC
      LIMIT $1 OFFSET $2`,
    [options.limit, options.offset, status, options.listingId ?? null],
    { label: "reports.list" },
  );

  const totals = await queryOne<{ total: string; open: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status IN ('open', 'reviewing'))::text AS open
       FROM listing_report
      WHERE ($1::report_status IS NULL OR status = $1::report_status)`,
    [status],
    { label: "reports.count" },
  );

  return {
    items: rows.map(mapReport),
    total: Number(totals?.total ?? 0),
    openCount: Number(totals?.open ?? 0),
  };
}

/** Moderator decision on a report. */
export async function setReportStatus(input: {
  reportId: string;
  status: ReportStatus;
  resolution?: string | null;
  adminId: string;
}) {
  const row = await queryOne<{ id: string }>(
    `UPDATE listing_report
        SET status = $2::report_status,
            resolution = coalesce($3, resolution),
            handled_by = $4,
            handled_at = CASE WHEN $2::report_status IN ('resolved', 'dismissed') THEN now() ELSE handled_at END
      WHERE id = $1
      RETURNING id`,
    [input.reportId, input.status, input.resolution ?? null, input.adminId],
    { label: "reports.setStatus" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That report does not exist." });
  return getListingReport(input.reportId);
}
