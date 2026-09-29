/**
 * The TUI dialog's column layout for /quota rows. The chat text keeps its own layout
 * (see buildQuotaCommandDocument); this one only draws the same rows in the dialog.
 */

import { bar, wrapDisplayText } from "./format-utils.js";
import { QUOTA_COMMAND_BAR_WIDTH } from "./quota-command-format.js";
import type { ReportQuotaRow } from "./report-document.js";

/**
 * The widest the rows get: about the width of OpenCode's large dialog (88), an easy line
 * to read. A typical full row (a 15-column label, a 24-cell bar, "100% left", "30.4/200",
 * "reset 23d 23h 59m") fits it, and the xlarge dialog keeps the rest as even margins.
 */
export const QUOTA_COLUMNS_MAX_WIDTH = 84;
/** The longest bar; a longer one only stretches the eye between a label and its percent. */
export const QUOTA_COLUMNS_BAR_MAX = 24;
/** The rows sit this far in from their provider title, as in the chat text. */
const ROW_INDENT = 2;
const GAP = 2;

/** A run of a laid-out line. Labels, reset times, and notes are muted; the rest is base. */
export type QuotaLineSegment = { text: string; muted: boolean };

type Column = { id: "label" | "bar" | "value" | "usage" | "reset"; start: number; width: number };

export type QuotaColumns = {
  /** Blank columns left of the rows, which center them in the dialog. */
  indent: number;
  /** The rows' width; each row ends at this column. */
  width: number;
  columns: Column[];
};

/**
 * Fits the columns of every /quota row in a report into `availableWidth`: label, bar,
 * percent, used/limit, and reset. The rows take at most QUOTA_COLUMNS_MAX_WIDTH columns,
 * centered. The bar grows up to QUOTA_COLUMNS_BAR_MAX cells and the spare width is spread
 * over the gaps between columns (at least two spaces each, the leftmost gaps taking any
 * remainder). A report without percent rows has no bar or percent columns; its value
 * column takes the free width instead. Returns undefined when the bar (or that value
 * column) would be shorter than the chat's bar, so the dialog keeps the chat layout.
 */
export function fitQuotaColumns(
  rows: ReportQuotaRow[],
  availableWidth: number,
): QuotaColumns | undefined {
  const width = Math.min(QUOTA_COLUMNS_MAX_WIDTH, availableWidth);
  const widest = (texts: Array<string | undefined>) =>
    Math.max(0, ...texts.map((text) => text?.length ?? 0));
  const percentRows = rows.filter((row) => row.barPercent !== undefined);
  // The column that takes the free width: the bar, or the value when no row has a bar.
  const flexId: Column["id"] = percentRows.length > 0 ? "bar" : "value";
  const candidates: Array<Omit<Column, "start">> = [
    { id: "label", width: widest(rows.map((row) => row.label)) },
    { id: flexId, width: 0 },
    ...(flexId === "bar"
      ? [{ id: "value" as const, width: widest(percentRows.map((row) => row.value)) }]
      : []),
    { id: "usage", width: widest(rows.map((row) => row.usage)) },
    { id: "reset", width: widest(rows.map((row) => row.reset)) },
  ];
  const sized = candidates.filter((column) => column.id === flexId || column.width > 0);

  const gapCount = sized.length - 1;
  const used = ROW_INDENT + sized.reduce((sum, column) => sum + column.width, 0) + GAP * gapCount;
  const flexWidth = flexId === "bar" ? Math.min(QUOTA_COLUMNS_BAR_MAX, width - used) : width - used;
  if (flexWidth < QUOTA_COMMAND_BAR_WIDTH) return undefined;

  const spare = width - used - flexWidth;
  let start = ROW_INDENT;
  const columns = sized.map((column, i) => {
    const placed = { ...column, start, width: column.id === flexId ? flexWidth : column.width };
    start += placed.width + GAP + Math.floor(spare / gapCount) + (i < spare % gapCount ? 1 : 0);
    return placed;
  });
  return { indent: Math.floor((availableWidth - width) / 2), width, columns };
}

/**
 * Lays out one row in the columns: the label, then the bar, the percent, used/limit, and
 * reset, each left-aligned at its column's start. A value row's text starts in the percent
 * column (the value column), runs up to the next part the row shows (to the rows' right
 * edge when there is none), and wraps there when it is too long. The notes follow, muted,
 * from the bar's column, wrapped at the rows' right edge.
 */
export function layoutQuotaRow(row: ReportQuotaRow, fit: QuotaColumns): QuotaLineSegment[][] {
  const flexStart = fit.columns[1].start;
  // Every fit has a value column: the percent rows' labels, or the flex column without them.
  const valueStart = fit.columns.find((column) => column.id === "value")!.start;
  const cellText = (column: Column): string | undefined => {
    switch (column.id) {
      case "label":
        return row.label;
      case "bar":
        return row.barPercent === undefined ? undefined : bar(row.barPercent, column.width);
      case "value":
        return row.barPercent === undefined ? undefined : row.value;
      case "usage":
      case "reset":
        return row[column.id];
    }
  };
  const parts: Array<{ start: number; text: string; muted: boolean }> = [];
  let valueEnd = fit.width;
  for (const [index, column] of fit.columns.entries()) {
    const text = cellText(column);
    if (!text) continue;
    if (index > 0 && parts.length === 1) {
      valueEnd = fit.columns[index - 1].start + fit.columns[index - 1].width;
    }
    parts.push({
      start: column.start,
      text,
      muted: column.id === "label" || column.id === "reset",
    });
  }

  const valueLines =
    row.barPercent !== undefined
      ? []
      : row.value.length <= valueEnd - valueStart
        ? [row.value]
        : wrapDisplayText(row.value, valueEnd - valueStart);
  if (valueLines.length > 0) {
    parts.push({ start: valueStart, text: valueLines[0], muted: false });
  }
  const lines: QuotaLineSegment[][] = [toSegments(parts)];
  for (const line of valueLines.slice(1)) {
    lines.push([{ text: " ".repeat(valueStart) + line, muted: false }]);
  }
  for (const note of row.notes) {
    for (const line of wrapDisplayText(note, fit.width - flexStart)) {
      lines.push([{ text: " ".repeat(flexStart) + line, muted: true }]);
    }
  }
  return lines;
}

/** Joins placed parts into one line, filling the columns between them with spaces. */
function toSegments(
  parts: Array<{ start: number; text: string; muted: boolean }>,
): QuotaLineSegment[] {
  const segments: QuotaLineSegment[] = [];
  let at = 0;
  for (const part of [...parts].sort((a, b) => a.start - b.start)) {
    segments.push({ text: " ".repeat(part.start - at) + part.text, muted: part.muted });
    at = part.start + part.text.length;
  }
  return segments;
}
