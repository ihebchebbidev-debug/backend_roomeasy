import { query, queryOne } from "@/db/query.js";

/**
 * Finance block of the back office: one ledger row per booking (with its
 * payment state), the commission owed per host per period, accounting totals
 * grouped by month/quarter/year and the data behind a single invoice.
 *
 * Everything reads from `booking`, `payment` and the commission tables, so it
 * works with or without Stripe: the payment status simply stays "pending" while
 * cards are collected by the built-in flow.
 */

export type FinanceRow = {
  bookingId: string;
  reference: string;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  status: string;
  guestName: string;
  hostId: string;
  hostName: string;
  propertyName: string;
  totalUsd: number;
  commissionRate: number;
  commissionUsd: number;
  hostNetUsd: number;
  paymentStatus: "none" | "pending" | "authorized" | "paid" | "failed" | "refunded";
  paymentMethod: string | null;
  paymentReference: string | null;
  refundedUsd: number;
};

const BOOKING_BASE = `
  FROM booking b
  JOIN property p ON p.id = b.property_id
  JOIN app_user hu ON hu.id = p.host_id
  LEFT JOIN host_commission hc ON hc.host_id = p.host_id
  CROSS JOIN platform_settings ps
  LEFT JOIN LATERAL (
    SELECT pay.status::text AS status, pay.method::text AS method, pay.reference, pay.refunded_usd
      FROM payment pay
     WHERE pay.booking_id = b.id
     ORDER BY pay.created_at DESC
     LIMIT 1
  ) pay ON true
`;

type LedgerFilters = {
  from?: string;
  to?: string;
  hostId?: string;
  paymentStatus?: string;
  limit: number;
  offset: number;
};

function ledgerWhere(filters: LedgerFilters, params: unknown[]): string {
  const clauses: string[] = ["b.status <> 'declined'"];
  if (filters.from) {
    params.push(filters.from);
    clauses.push(`b.created_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`b.created_at < ($${params.length}::date + 1)`);
  }
  if (filters.hostId) {
    params.push(filters.hostId);
    clauses.push(`p.host_id = $${params.length}`);
  }
  if (filters.paymentStatus === "none") {
    clauses.push("pay.status IS NULL");
  } else if (filters.paymentStatus && filters.paymentStatus !== "all") {
    params.push(filters.paymentStatus);
    clauses.push(`pay.status = $${params.length}::text`);
  }
  return `WHERE ${clauses.join(" AND ")}`;
}

type LedgerDbRow = {
  id: string;
  reference: string;
  created_at: Date | string;
  check_in: Date | string;
  check_out: Date | string;
  status: string;
  guest_name: string;
  host_id: string;
  host_name: string;
  property_name: string;
  total_usd: string;
  commission_rate: string;
  payment_status: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  refunded_usd: string | null;
};

const asDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : String(value);

function toRow(row: LedgerDbRow): FinanceRow {
  const total = Number(row.total_usd);
  const rate = Number(row.commission_rate);
  const commission = Math.round(total * rate) / 100;
  return {
    bookingId: row.id,
    reference: row.reference,
    createdAt: asDate(row.created_at),
    checkIn: asDate(row.check_in).slice(0, 10),
    checkOut: asDate(row.check_out).slice(0, 10),
    status: row.status,
    guestName: row.guest_name,
    hostId: row.host_id,
    hostName: row.host_name,
    propertyName: row.property_name,
    totalUsd: total,
    commissionRate: rate,
    commissionUsd: commission,
    hostNetUsd: Math.round((total - commission) * 100) / 100,
    paymentStatus: (row.payment_status ?? "none") as FinanceRow["paymentStatus"],
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    refundedUsd: Number(row.refunded_usd ?? 0),
  };
}

/** Per-booking ledger with the payment state, newest first. */
export async function financeLedger(filters: LedgerFilters): Promise<{ rows: FinanceRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ledgerWhere(filters, params);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count ${BOOKING_BASE} ${where}`,
    params,
    { label: "finance.ledger.count" },
  );

  const listParams = [...params, filters.limit, filters.offset];
  const rows = await query<LedgerDbRow>(
    `SELECT b.id, b.reference, b.created_at, b.check_in, b.check_out, b.status::text AS status,
            b.guest_name, p.host_id, hu.full_name AS host_name, p.name AS property_name, b.total_usd,
            COALESCE(hc.commission_rate, ps.commission_rate) AS commission_rate,
            pay.status AS payment_status, pay.method AS payment_method,
            pay.reference AS payment_reference, pay.refunded_usd
       ${BOOKING_BASE}
       ${where}
      ORDER BY b.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
    { label: "finance.ledger" },
  );

  return { rows: rows.map(toRow), total: Number(countRow?.count ?? 0) };
}

export type CommissionReportRow = {
  hostId: string;
  hostName: string;
  hostEmail: string | null;
  bookings: number;
  revenueUsd: number;
  commissionUsd: number;
  hostNetUsd: number;
  paidUsd: number;
  unpaidUsd: number;
  commissionRate: number;
};

/** Commission owed per host over one period. */
export async function commissionReport(range: { from?: string; to?: string }): Promise<CommissionReportRow[]> {
  const params: unknown[] = [];
  const where = ledgerWhere({ ...range, limit: 0, offset: 0 }, params);

  const rows = await query<{
    host_id: string;
    host_name: string;
    host_email: string | null;
    commission_rate: string;
    bookings: string;
    revenue_usd: string;
    paid_usd: string;
  }>(
    `SELECT p.host_id, hu.full_name AS host_name, hu.email AS host_email,
            COALESCE(hc.commission_rate, ps.commission_rate) AS commission_rate,
            COUNT(*)::text AS bookings,
            COALESCE(SUM(b.total_usd), 0) AS revenue_usd,
            COALESCE(SUM(CASE WHEN pay.status = 'paid' THEN b.total_usd ELSE 0 END), 0) AS paid_usd
       ${BOOKING_BASE}
       ${where}
      GROUP BY p.host_id, hu.full_name, hu.email, COALESCE(hc.commission_rate, ps.commission_rate)
      ORDER BY revenue_usd DESC`,
    params,
    { label: "finance.commission-report" },
  );

  return rows.map((row) => {
    const revenue = Number(row.revenue_usd);
    const rate = Number(row.commission_rate);
    const commission = Math.round(revenue * rate) / 100;
    const paid = Number(row.paid_usd);
    return {
      hostId: row.host_id,
      hostName: row.host_name,
      hostEmail: row.host_email,
      bookings: Number(row.bookings),
      revenueUsd: revenue,
      commissionUsd: commission,
      hostNetUsd: Math.round((revenue - commission) * 100) / 100,
      paidUsd: paid,
      unpaidUsd: Math.round((revenue - paid) * 100) / 100,
      commissionRate: rate,
    };
  });
}

export type AccountingPeriod = "month" | "quarter" | "year";

export type AccountingRow = {
  period: string;
  bookings: number;
  revenueUsd: number;
  commissionUsd: number;
  hostNetUsd: number;
  serviceFeeUsd: number;
  taxesUsd: number;
  cleaningUsd: number;
  refundedUsd: number;
  paidUsd: number;
};

/** Accounting totals grouped by calendar month, quarter or year. */
export async function accountingExport(input: {
  period: AccountingPeriod;
  from?: string;
  to?: string;
}): Promise<AccountingRow[]> {
  const params: unknown[] = [];
  const where = ledgerWhere({ from: input.from, to: input.to, limit: 0, offset: 0 }, params);
  const bucket =
    input.period === "year"
      ? "to_char(date_trunc('year', b.created_at), 'YYYY')"
      : input.period === "quarter"
        ? "to_char(date_trunc('quarter', b.created_at), 'YYYY\"-Q\"Q')"
        : "to_char(date_trunc('month', b.created_at), 'YYYY-MM')";

  const rows = await query<{
    period: string;
    bookings: string;
    revenue_usd: string;
    commission_usd: string;
    service_fee_usd: string;
    taxes_usd: string;
    cleaning_usd: string;
    refunded_usd: string;
    paid_usd: string;
  }>(
    `SELECT ${bucket} AS period,
            COUNT(*)::text AS bookings,
            COALESCE(SUM(b.total_usd), 0) AS revenue_usd,
            COALESCE(SUM(b.total_usd * COALESCE(hc.commission_rate, ps.commission_rate) / 100), 0) AS commission_usd,
            COALESCE(SUM(b.service_fee), 0) AS service_fee_usd,
            COALESCE(SUM(b.taxes), 0) AS taxes_usd,
            COALESCE(SUM(b.cleaning_fee), 0) AS cleaning_usd,
            COALESCE(SUM(COALESCE(pay.refunded_usd, 0)), 0) AS refunded_usd,
            COALESCE(SUM(CASE WHEN pay.status = 'paid' THEN b.total_usd ELSE 0 END), 0) AS paid_usd
       ${BOOKING_BASE}
       ${where}
      GROUP BY period
      ORDER BY period`,
    params,
    { label: "finance.accounting" },
  );

  return rows.map((row) => {
    const revenue = Number(row.revenue_usd);
    const commission = Math.round(Number(row.commission_usd) * 100) / 100;
    return {
      period: row.period,
      bookings: Number(row.bookings),
      revenueUsd: revenue,
      commissionUsd: commission,
      hostNetUsd: Math.round((revenue - commission) * 100) / 100,
      serviceFeeUsd: Number(row.service_fee_usd),
      taxesUsd: Number(row.taxes_usd),
      cleaningUsd: Number(row.cleaning_usd),
      refundedUsd: Number(row.refunded_usd),
      paidUsd: Number(row.paid_usd),
    };
  });
}

export type InvoiceData = {
  booking: FinanceRow;
  guestEmail: string | null;
  guestPhone: string | null;
  hostEmail: string | null;
  nights: number;
  guests: number;
  nightlyUsd: number;
  baseSubtotalUsd: number;
  subtotalUsd: number;
  cleaningFeeUsd: number;
  serviceFeeUsd: number;
  taxesUsd: number;
  discounts: { kind: string; percent: number; amountUsd: number }[];
};

/** Everything an invoice for one booking has to print. */
export async function bookingInvoice(bookingId: string): Promise<InvoiceData | null> {
  const params: unknown[] = [bookingId];
  const row = await queryOne<
    LedgerDbRow & {
      guest_email: string | null;
      guest_phone: string | null;
      host_email: string | null;
      nights: number;
      guests: number;
      nightly_usd: string;
      base_subtotal: string;
      subtotal: string;
      cleaning_fee: string;
      service_fee: string;
      taxes: string;
    }
  >(
    `SELECT b.id, b.reference, b.created_at, b.check_in, b.check_out, b.status::text AS status,
            b.guest_name, b.guest_email, b.guest_phone, b.nights, b.guests,
            b.nightly_usd, b.base_subtotal, b.subtotal, b.cleaning_fee, b.service_fee, b.taxes,
            p.host_id, hu.full_name AS host_name, hu.email AS host_email, p.name AS property_name, b.total_usd,
            COALESCE(hc.commission_rate, ps.commission_rate) AS commission_rate,
            pay.status AS payment_status, pay.method AS payment_method,
            pay.reference AS payment_reference, pay.refunded_usd
       ${BOOKING_BASE}
      WHERE b.id = $1 OR b.reference = $1
      LIMIT 1`,
    params,
    { label: "finance.invoice" },
  );
  if (!row) return null;

  const discounts = await query<{ kind: string; percent: string; amount_usd: string }>(
    "SELECT kind::text AS kind, percent, amount_usd FROM booking_discount WHERE booking_id = $1",
    [row.id],
    { label: "finance.invoice.discounts" },
  );

  return {
    booking: toRow(row),
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    hostEmail: row.host_email,
    nights: Number(row.nights),
    guests: Number(row.guests),
    nightlyUsd: Number(row.nightly_usd),
    baseSubtotalUsd: Number(row.base_subtotal),
    subtotalUsd: Number(row.subtotal),
    cleaningFeeUsd: Number(row.cleaning_fee),
    serviceFeeUsd: Number(row.service_fee),
    taxesUsd: Number(row.taxes),
    discounts: discounts.map((d) => ({ kind: d.kind, percent: Number(d.percent), amountUsd: Number(d.amount_usd) })),
  };
}
