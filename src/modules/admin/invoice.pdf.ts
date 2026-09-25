import type { Response } from "express";
import PDFKit from "pdfkit";

import type { InvoiceData } from "@/modules/admin/finance.repository.js";

/**
 * Renders one booking's invoice as a PDF, in the same shape the JSON
 * `bookingInvoice()` endpoint already exposes: company header, invoice
 * number, dates, guest, host, listing, nights, line items, service fee,
 * taxes, total (booking currency) and payment status. Used by the admin finance screen
 * and by the guest/host booking pages, both gated by an ownership check
 * upstream of this renderer.
 */

// Set per invoice: every amount is in the booking's (listing's) currency.
let invoiceCurrency = "EUR";
const eur = (value: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: invoiceCurrency }).format(value);

const longDate = (value: string) =>
  new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  none: "Not recorded",
  pending: "Pending",
  authorized: "Authorized",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
};

export function renderInvoicePdf(invoice: InvoiceData, res: Response): void {
  const { booking } = invoice;
  invoiceCurrency = booking.currency || "EUR";
  const invoiceNumber = `INV-${booking.reference}`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoiceNumber}.pdf"`);

  const doc = new PDFKit({ size: "A4", margin: 50 });
  doc.pipe(res);

  // Header ------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(22).text("RoomEasy", 50, 50);
  doc.font("Helvetica").fontSize(9).fillColor("#666").text("The RoomEasy booking platform", 50, 76);
  doc.fillColor("#000");

  doc.font("Helvetica-Bold").fontSize(16).text("INVOICE", 400, 50, { align: "right" });
  doc.font("Helvetica").fontSize(10);
  doc.text(`Invoice number: ${invoiceNumber}`, 300, 75, { align: "right" });
  doc.text(`Booking reference: ${booking.reference}`, 300, 90, { align: "right" });
  doc.text(`Issue date: ${longDate(new Date().toISOString())}`, 300, 105, { align: "right" });
  doc.text(`Booking date: ${longDate(booking.createdAt)}`, 300, 120, { align: "right" });

  doc.moveTo(50, 145).lineTo(545, 145).strokeColor("#ddd").stroke();

  // Parties -------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(11).text("Guest", 50, 160);
  doc.font("Helvetica").fontSize(10);
  doc.text(booking.guestName, 50, 176);
  if (invoice.guestEmail) doc.text(invoice.guestEmail, 50, 190);
  if (invoice.guestPhone) doc.text(invoice.guestPhone, 50, 204);

  doc.font("Helvetica-Bold").fontSize(11).text("Host", 300, 160);
  doc.font("Helvetica").fontSize(10);
  doc.text(booking.hostName, 300, 176);
  if (invoice.hostEmail) doc.text(invoice.hostEmail, 300, 190);

  doc.font("Helvetica-Bold").fontSize(11).text("Stay", 50, 230);
  doc.font("Helvetica").fontSize(10);
  doc.text(booking.propertyName, 50, 246);
  doc.text(
    `${longDate(booking.checkIn)} \u2192 ${longDate(booking.checkOut)} \u00b7 ${invoice.nights} night(s) \u00b7 ${invoice.guests} guest(s)`,
    50,
    260,
  );

  const paymentLabel = PAYMENT_STATUS_LABEL[booking.paymentStatus] ?? booking.paymentStatus;
  doc.font("Helvetica-Bold").fontSize(11).text("Payment status", 300, 230);
  doc.font("Helvetica").fontSize(10).text(paymentLabel, 300, 246);
  if (booking.paymentMethod) doc.text(`Method: ${booking.paymentMethod}`, 300, 260);

  // Line items table ----------------------------------------------------
  let y = 300;
  const col = { desc: 50, qty: 330, amount: 430 };

  doc.font("Helvetica-Bold").fontSize(10);
  doc.text("Description", col.desc, y);
  doc.text("Qty", col.qty, y);
  doc.text("Amount", col.amount, y, { width: 100, align: "right" });
  y += 14;
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#000").stroke();
  y += 8;

  doc.font("Helvetica").fontSize(10);
  const line = (label: string, qty: string, amount: number) => {
    doc.text(label, col.desc, y, { width: 260 });
    doc.text(qty, col.qty, y);
    doc.text(eur(amount), col.amount, y, { width: 100, align: "right" });
    y += 18;
  };

  line(`Accommodation \u2014 ${eur(invoice.nightlyUsd)} / night`, String(invoice.nights), invoice.baseSubtotalUsd);
  for (const discount of invoice.discounts) {
    line(`${discount.kind} discount (\u2212${discount.percent}%)`, "1", -discount.amountUsd);
  }
  if (invoice.cleaningFeeUsd > 0) line("Cleaning fee", "1", invoice.cleaningFeeUsd);
  line("Service fee", "1", invoice.serviceFeeUsd);
  line("Taxes", "1", invoice.taxesUsd);

  y += 4;
  doc.moveTo(300, y).lineTo(545, y).strokeColor("#ddd").stroke();
  y += 10;

  doc.font("Helvetica").fontSize(10).text("Commission (platform)", col.qty, y, { width: 130 });
  doc.text(eur(booking.commissionUsd), col.amount, y, { width: 100, align: "right" });
  y += 16;
  doc.text("Host payout", col.qty, y, { width: 130 });
  doc.text(eur(booking.hostNetUsd), col.amount, y, { width: 100, align: "right" });
  y += 20;

  doc.font("Helvetica-Bold").fontSize(12);
  doc.text("Total (EUR)", col.qty, y, { width: 130 });
  doc.text(eur(booking.totalUsd), col.amount, y, { width: 100, align: "right" });
  y += 30;

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#888")
    .text(
      "RoomEasy \u2014 This document is a summary invoice for the booking above. Amounts are shown in EUR.",
      50,
      y,
      { width: 495 },
    );

  doc.end();
}
