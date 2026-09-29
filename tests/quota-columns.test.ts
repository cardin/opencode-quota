import { describe, expect, it } from "vitest";

import {
  layoutQuotaTables,
  QUOTA_TABLE_BAR_WIDTH,
  type QuotaBlock,
  type QuotaTable,
} from "../src/lib/quota-columns.js";
import type { ReportQuotaRow } from "../src/lib/report-document.js";

const copilotQuota: ReportQuotaRow = {
  label: "Quota",
  barPercent: 85,
  value: "85%",
  usage: "30.4/200",
  reset: "1d 7h 48m",
  notes: [],
};
const fiveHour: ReportQuotaRow = {
  label: "5h",
  barPercent: 100,
  value: "100%",
  reset: "5h 0m",
  notes: [],
};
const week: ReportQuotaRow = {
  label: "Week",
  barPercent: 72,
  value: "72%",
  reset: "3d 17h 51m",
  notes: ["Runs out ≈ 2d 3h"],
};
const zenBudget: ReportQuotaRow = {
  label: "Month budget",
  barPercent: 40,
  value: "40%",
  notes: [],
};
const spend: ReportQuotaRow = { label: "Monthly spend", value: "USD 0.00", notes: [] };
const balance: ReportQuotaRow = { label: "Current balance", value: "USD 0.00", notes: [] };

function block(
  provider: string,
  rows: ReportQuotaRow[],
  percentMode: "remaining" | "used" = "remaining",
): QuotaBlock {
  return { kind: "quota", provider, percentMode, lines: [], rows };
}

const report = [
  block("Copilot (individual)", [copilotQuota]),
  block("OpenAI (Business)", [fiveHour, week]),
  block("OpenCode Zen", [zenBudget, spend, balance]),
];

/** Each table as its title and lines, one string per line. */
function draw(
  tables: QuotaTable[] | undefined,
): Array<{ title: string; lines: string[] }> | undefined {
  return tables?.map((table) => ({
    title: table.title,
    lines: table.lines.map((line) => line.segments.map((segment) => segment.text).join("")),
  }));
}

/** A line with each text starting at its column. */
function at(parts: Array<[number, string]>): string {
  return parts.reduce((line, [start, text]) => line.padEnd(start) + text, "");
}

/** The bar in a drawn line. */
function barIn(line: string): string {
  return line.match(/[█░]+/u)?.[0] ?? "";
}

describe("quota tables", () => {
  it("groups percent rows under Quota limits and value rows under Spending & balances", () => {
    const tables = layoutQuotaTables(report, 111)!;

    // A provider shows in each table it has rows in, in the report's order.
    expect(tables.map((table) => table.title)).toEqual(["Quota limits", "Spending & balances"]);
    expect(
      tables.map((table) =>
        table.lines
          .filter((line) => line.style === "provider")
          .map((line) => line.segments[0].text),
      ),
    ).toEqual([["Copilot (individual)", "OpenAI (Business)", "OpenCode Zen"], ["OpenCode Zen"]]);
    // Each table starts with one header row.
    expect(tables.map((table) => table.lines.map((line) => line.style))).toEqual([
      ["header", "provider", "row", "provider", "row", "row", "row", "provider", "row"],
      ["header", "provider", "row", "row"],
    ]);
  });

  it("spreads the spare width over the gaps, keeps the bar at 24 cells, and shares the columns", () => {
    const tables = layoutQuotaTables(report, 111)!;

    // Label 17 ("Provider · window"), bar 24, percent or amount 8, used 8, reset 10, and
    // four 2-column gaps take 75 of 111 columns; the gaps share the other 36: 9 each.
    expect(draw(tables)).toEqual([
      {
        title: "Quota limits",
        lines: [
          at([
            [0, "Provider · window"],
            [28, "Usage"],
            [63, "Left"],
            [82, "Used"],
            [101, "Resets in"],
          ]),
          "Copilot (individual)",
          at([
            [0, "  Quota"],
            [28, `${"█".repeat(20)}${"░".repeat(4)}`],
            [63, " 85%"],
            [82, "30.4/200"],
            [101, "1d 7h 48m"],
          ]),
          "OpenAI (Business)",
          at([
            [0, "  5h"],
            [28, "█".repeat(24)],
            [63, "100%"],
            [101, "5h 0m"],
          ]),
          at([
            [0, "  Week"],
            [28, `${"█".repeat(17)}${"░".repeat(7)}`],
            [63, " 72%"],
            [101, "3d 17h 51m"],
          ]),
          // A note sits under the bar.
          at([[28, "Runs out ≈ 2d 3h"]]),
          "OpenCode Zen",
          at([
            [0, "  Month budget"],
            [28, `${"█".repeat(10)}${"░".repeat(14)}`],
            [63, " 40%"],
          ]),
        ],
      },
      {
        title: "Spending & balances",
        // The amounts start where the percents do; this table has no used or reset values.
        lines: [
          at([
            [0, "Provider · item"],
            [63, "Amount"],
          ]),
          "OpenCode Zen",
          at([
            [0, "  Monthly spend"],
            [63, "USD 0.00"],
          ]),
          at([
            [0, "  Current balance"],
            [63, "USD 0.00"],
          ]),
        ],
      },
    ]);
    // The last column ends at the edge.
    expect(draw(tables)![0].lines[5]).toHaveLength(111);
    expect(QUOTA_TABLE_BAR_WIDTH).toBe(24);

    // A wider dialog widens the gaps, never the bar.
    const wide = draw(layoutQuotaTables(report, 150))!;
    expect(wide[0].lines[5]).toHaveLength(150);
    expect(barIn(wide[0].lines[2])).toHaveLength(24);
  });

  it("mutes labels, reset times, and notes; bars, percents, used, and amounts are base", () => {
    const [quota, spending] = layoutQuotaTables(report, 111)!;

    expect(quota.lines[2].segments.map((segment) => segment.muted)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(quota.lines[6].segments.map((segment) => segment.muted)).toEqual([true]);
    expect(spending.lines[2].segments.map((segment) => segment.muted)).toEqual([true, false]);
  });

  it("leaves out the Used and Resets in columns when no row has them", () => {
    const tables = draw(
      layoutQuotaTables([block("OpenAI", [{ ...fiveHour, reset: undefined }])], 60),
    );

    // Label 17, bar 24, percent 4, and two 2-column gaps: the gaps share the spare 11.
    expect(tables).toEqual([
      {
        title: "Quota limits",
        lines: [
          at([
            [0, "Provider · window"],
            [25, "Usage"],
            [56, "Left"],
          ]),
          "OpenAI",
          at([
            [0, "  5h"],
            [25, "█".repeat(24)],
            [56, "100%"],
          ]),
        ],
      },
    ]);
  });

  it("lays out a report without percent rows as the spending table alone", () => {
    const tables = draw(layoutQuotaTables([block("OpenCode Zen", [spend, balance])], 60));

    expect(tables).toEqual([
      {
        title: "Spending & balances",
        lines: [
          at([
            [0, "Provider · item"],
            [52, "Amount"],
          ]),
          "OpenCode Zen",
          at([
            [0, "  Monthly spend"],
            [52, "USD 0.00"],
          ]),
          at([
            [0, "  Current balance"],
            [52, "USD 0.00"],
          ]),
        ],
      },
    ]);
  });

  it("heads the percents Used % when they show the part used", () => {
    const used = [block("Copilot", [{ ...copilotQuota, barPercent: 15, value: "15%" }], "used")];
    const [quota] = draw(layoutQuotaTables(used, 111))!;

    // The percents stay right-aligned under their header; used/limit is named apart.
    expect(quota.lines[0]).toMatch(/Usage +Used % +Used\/limit +Resets in$/u);
    expect(quota.lines[0].indexOf("Used %") + "Used %".length).toBe(
      quota.lines[2].indexOf("15%") + "15%".length,
    );
  });

  it("turns the headers compact, then shrinks the bar, then gives up when the dialog is narrow", () => {
    const rows = [block("Copilot", [copilotQuota])];
    // Full headers: label 17, bar 24, percent 4, used 8, reset 9, and four gaps: 70.
    expect(draw(layoutQuotaTables(rows, 70))![0].lines[0]).toMatch(/^Provider · window/u);
    // Compact headers: label 8, the rest as wide as before: 61.
    const compact = draw(layoutQuotaTables(rows, 61))![0].lines;
    expect(compact[0]).toBe(
      at([
        [0, "Provider"],
        [10, "Usage"],
        [36, "Left"],
        [42, "Used"],
        [52, "Resets"],
      ]),
    );
    expect(barIn(compact[2])).toHaveLength(24);
    // Narrower still, the bar shrinks, down to the chat's 10 cells; below that, the dialog
    // shows the chat lines.
    expect(barIn(draw(layoutQuotaTables(rows, 55))![0].lines[2])).toHaveLength(18);
    expect(barIn(draw(layoutQuotaTables(rows, 47))![0].lines[2])).toHaveLength(10);
    expect(layoutQuotaTables(rows, 46)).toBeUndefined();
  });
});
