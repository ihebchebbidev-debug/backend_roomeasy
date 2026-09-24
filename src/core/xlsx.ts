import type { Response } from "express";
import ExcelJS from "exceljs";

/**
 * Small helper shared by every "Download Excel" export route. Builds a
 * workbook with one bold, frozen header row per sheet, sensible column
 * widths and number/date formats, then streams it as a proper .xlsx
 * attachment (same capability checks as the CSV sibling routes; this file
 * only renders bytes).
 */

export type XlsxColumn<T> = {
  header: string;
  key: string;
  width?: number;
  /** ExcelJS number format string, e.g. "#,##0.00" or "yyyy-mm-dd". */
  numFmt?: string;
  value: (row: T) => string | number | Date | null;
};

export type XlsxSheet<T> = {
  name: string;
  columns: XlsxColumn<T>[];
  rows: T[];
};

export async function sendXlsx(res: Response, filename: string, sheets: XlsxSheet<unknown>[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RoomEasy";
  workbook.created = new Date();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
    worksheet.columns = sheet.columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width ?? 18,
      style: column.numFmt ? { numFmt: column.numFmt } : undefined,
    }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = { vertical: "middle" };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    for (const row of sheet.rows) {
      const values: Record<string, string | number | Date | null> = {};
      for (const column of sheet.columns) values[column.key] = column.value(row);
      worksheet.addRow(values);
    }
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}
