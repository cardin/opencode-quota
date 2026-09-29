import { describe, expect, it } from "vitest";

import {
  fitQuotaColumns,
  layoutQuotaRow,
  QUOTA_COLUMNS_BAR_MAX,
  QUOTA_COLUMNS_MAX_WIDTH,
  type QuotaColumns,
} from "../src/lib/quota-columns.js";
import type { ReportQuotaRow } from "../src/lib/report-document.js";

const copilot: ReportQuotaRow = {
  label: "Quota",
  barPercent: 85,
  value: "85% left",
  usage: "30.4/200",
  reset: "reset 1d 8h 18m",
  notes: [],
};
const fiveHour: ReportQuotaRow = {
  label: "5h quota",
  barPercent: 100,
  value: "100% left",
  reset: "reset 5h 0m",
  notes: [],
};
const week: ReportQuotaRow = {
  label: "Week quota",
  barPercent: 50,
  value: "50% left",
  reset: "reset 3d 18h 21m",
  notes: ["Runs out ≈ 2d 3h"],
};
const spend: ReportQuotaRow = { label: "Monthly spend", value: "USD 0.00", notes: [] };

/** A row's lines as plain text, each with the columns its muted runs cover. */
function draw(row: ReportQuotaRow, fit: QuotaColumns): string[] {
  return layoutQuotaRow(row, fit).map((line) => line.map((segment) => segment.text).join(""));
}

describe("quota columns", () => {
  it("caps the rows' width and centers them in a wider dialog", () => {
    const fit = fitQuotaColumns([copilot, fiveHour, week, spend], 111)!;

    expect(QUOTA_COLUMNS_MAX_WIDTH).toBe(84);
    expect(fit.width).toBe(84);
    // 111 - 84 = 27 spare columns: 13 on the left, 14 on the right.
    expect(fit.indent).toBe(13);
  });

  it("caps the bar and spreads the spare width over the gaps", () => {
    const fit = fitQuotaColumns([fiveHour, week], 111)!;

    // A 2-column row indent, label 10, percent 9, reset 16, and three 2-column gaps leave
    // 41 of the 84 columns: the bar takes its 24 and the three gaps share the other 17.
    expect(fit.columns).toEqual([
      { id: "label", start: 2, width: 10 },
      { id: "bar", start: 20, width: QUOTA_COLUMNS_BAR_MAX },
      { id: "value", start: 52, width: 9 },
      { id: "reset", start: 68, width: 16 },
    ]);
    expect(draw(fiveHour, fit)).toEqual([
      `  5h quota          ${"█".repeat(24)}        100% left       reset 5h 0m`,
    ]);
  });

  it("left-aligns every column: label, percent, used/limit, reset, notes under the bar", () => {
    const fit = fitQuotaColumns([copilot, fiveHour, week, spend], 111)!;
    const lines = [copilot, fiveHour, week].flatMap((row) => draw(row, fit));

    expect(lines).toEqual([
      `  Quota           ${"█".repeat(20)}${"░".repeat(4)}   85% left    30.4/200   reset 1d 8h 18m`,
      `  5h quota        ${"█".repeat(24)}   100% left              reset 5h 0m`,
      `  Week quota      ${"█".repeat(12)}${"░".repeat(12)}   50% left               reset 3d 18h 21m`,
      "                  Runs out ≈ 2d 3h",
    ]);
    // Every percent starts at the value column.
    const valueStart = fit.columns.find((column) => column.id === "value")!.start;
    expect(lines.slice(0, 3).map((line) => line.search(/\d+% left/))).toEqual([
      valueStart,
      valueStart,
      valueStart,
    ]);
    // Labels, reset times, and notes are muted; the bar, percent, and usage are base.
    expect(layoutQuotaRow(copilot, fit)[0].map((segment) => segment.muted)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(layoutQuotaRow(week, fit)[1]).toEqual([
      { text: "                  Runs out ≈ 2d 3h", muted: true },
    ]);
  });

  it("starts a value row's text in the percent column, before its reset", () => {
    const withReset = { ...spend, label: "Plan", reset: "reset 3d 0h" };
    const fit = fitQuotaColumns([copilot, spend, withReset], 111)!;

    expect(draw(spend, fit)).toEqual([`  Monthly spend${" ".repeat(32)}USD 0.00`]);
    expect(draw(withReset, fit)).toEqual([
      `  Plan${" ".repeat(41)}USD 0.00${" ".repeat(14)}reset 3d 0h`,
    ]);
    // The value starts where the percent starts, and the reset where the percent row's does.
    const percentStart = draw(copilot, fit)[0].indexOf("85% left");
    expect(draw(spend, fit)[0].indexOf("USD 0.00")).toBe(percentStart);
    expect(draw(withReset, fit)[0].indexOf("USD 0.00")).toBe(percentStart);
    expect(draw(withReset, fit)[0].indexOf("reset")).toBe(draw(copilot, fit)[0].indexOf("reset"));
    expect(layoutQuotaRow(spend, fit)[0]).toEqual([
      { text: "  Monthly spend", muted: true },
      { text: `${" ".repeat(32)}USD 0.00`, muted: false },
    ]);
  });

  it("wraps a long value row's text inside its columns, from the percent column", () => {
    const plan: ReportQuotaRow = {
      label: "Plan",
      value: "Pro | quota details unavailable for this organization right now",
      notes: [],
    };
    const fit = fitQuotaColumns([fiveHour, plan], 60)!;

    expect(draw(fiveHour, fit)[0].indexOf("100% left")).toBe(38);
    expect(draw(plan, fit)).toEqual([
      `  Plan${" ".repeat(32)}Pro | quota details`,
      `${" ".repeat(38)}unavailable for this`,
      `${" ".repeat(38)}organization right now`,
    ]);
  });

  it("gives a report without percent rows a value column that takes the free width", () => {
    const balance = { ...spend, label: "Current balance" };
    const fit = fitQuotaColumns([spend, balance], 111)!;

    expect(fit.columns).toEqual([
      { id: "label", start: 2, width: 15 },
      { id: "value", start: 19, width: 65 },
    ]);
    expect(draw(spend, fit)).toEqual(["  Monthly spend    USD 0.00"]);
    expect(draw(balance, fit)).toEqual(["  Current balance  USD 0.00"]);
  });

  it("shrinks the bar on a narrower dialog and gives up below the chat's bar width", () => {
    // Everything but the bar takes 2 + 5 + 8 + 8 + 15 + 4 gaps of 2 = 46 columns.
    expect(fitQuotaColumns([copilot], 60)?.columns[1]).toEqual({
      id: "bar",
      start: 9,
      width: 14,
    });
    expect(fitQuotaColumns([copilot], 56)?.columns[1].width).toBe(10);
    expect(fitQuotaColumns([copilot], 55)).toBeUndefined();
    expect(fitQuotaColumns([spend], 24)).toBeUndefined();
  });
});
