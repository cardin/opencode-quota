import { describe, expect, it } from "vitest";

import { padTableColumns } from "../src/lib/markdown-table.js";
import {
  isReportDocument,
  messageDocument,
  type ReportDocument,
  renderableSections,
  renderMarkdownReport,
  renderPlainTextReport,
} from "../src/lib/report-document.js";

describe("report-document", () => {
  it("renders stable plain-text section spacing across lines and kv blocks", () => {
    const out = renderPlainTextReport({
      sections: [
        {
          id: "status",
          title: "status:",
          blocks: [
            {
              kind: "kv",
              rows: [
                { key: "enabled", value: "true" },
                { key: "providers", trailingColon: true },
                { key: "openai", value: "available", indent: 1 },
              ],
            },
          ],
        },
        {
          id: "notes",
          blocks: [
            {
              kind: "lines",
              lines: ["note one", "note two"],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "status:
      - enabled: true
      - providers:
        - openai: available

      note one
      note two"
    `);
  });

  it("renders stable markdown section spacing across tables and note blocks", () => {
    const out = renderMarkdownReport({
      sections: [
        {
          id: "summary",
          blocks: [
            {
              kind: "table",
              headers: ["Messages", "Cost"],
              aligns: ["right", "right"],
              rows: [["3", "$1.23"]],
            },
          ],
        },
        {
          id: "details",
          title: "Details",
          blocks: [
            {
              kind: "table",
              headers: ["Source", "Tokens"],
              aligns: ["left", "right"],
              rows: [["OpenAI", "123"]],
            },
            {
              kind: "lines",
              lines: ["Follow up note."],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "| Messages |  Cost |
      | -------: | ----: |
      |        3 | $1.23 |

      ## Details

      | Source | Tokens |
      | ------ | -----: |
      | OpenAI |    123 |

      Follow up note."
    `);
  });

  it("pads table columns to their widths without pipes or escaping", () => {
    expect(
      padTableColumns({
        headers: ["Model", "Cost"],
        rows: [["gpt|5", "$1.23"], ["claude-opus", "$10.00"], ["two\nlines"]],
        aligns: ["left", "right"],
      }),
    ).toEqual({
      header: ["Model      ", "  Cost"],
      rows: [
        ["gpt|5      ", " $1.23"],
        ["claude-opus", "$10.00"],
        ["two lines  ", "      "],
      ],
    });
  });

  it("keeps only sections with a title or a block that has content", () => {
    const document: ReportDocument = {
      sections: [
        { id: "empty", blocks: [{ kind: "lines", lines: [] }] },
        { id: "titled", title: "Title", blocks: [{ kind: "kv", rows: [] }] },
        {
          id: "mixed",
          blocks: [
            { kind: "table", headers: [], rows: [], aligns: [] },
            { kind: "lines", lines: ["kept"] },
          ],
        },
      ],
    };

    expect(renderableSections(document)).toEqual([
      { id: "titled", title: "Title", blocks: [] },
      { id: "mixed", blocks: [{ kind: "lines", lines: ["kept"] }] },
    ]);
  });

  it("renders a message document back to the same text with either renderer", () => {
    const text = "Invalid arguments for /quota\n\nThis command does not accept arguments.";

    expect(messageDocument(text)).toEqual({
      sections: [
        {
          id: "message",
          blocks: [
            {
              kind: "lines",
              lines: [
                "Invalid arguments for /quota",
                "",
                "This command does not accept arguments.",
              ],
            },
          ],
        },
      ],
    });
    expect(renderPlainTextReport(messageDocument(text))).toBe(text);
    expect(renderMarkdownReport(messageDocument(text))).toBe(text);
  });

  it("accepts well-formed documents and rejects malformed ones", () => {
    const document: ReportDocument = {
      heading: { title: "Report", generatedAtMs: 1 },
      sections: [
        {
          id: "all",
          title: "all:",
          blocks: [
            { kind: "lines", lines: ["a"] },
            { kind: "kv", rows: [{ key: "k", value: "v", indent: 1, trailingColon: false }] },
            {
              kind: "table",
              headers: ["A"],
              rows: [["1"]],
              aligns: ["right"],
              widthMode: "markdown-conceal",
            },
          ],
        },
      ],
    };

    expect(isReportDocument(document)).toBe(true);
    expect(isReportDocument(messageDocument("hi"))).toBe(true);
    expect(isReportDocument(JSON.parse(JSON.stringify(document)))).toBe(true);
    for (const value of [
      undefined,
      null,
      "report",
      [],
      {},
      { sections: {} },
      { heading: { title: 1 }, sections: [] },
      { sections: [{ blocks: [] }] },
      { sections: [{ id: "s", blocks: [{ kind: "html", lines: [] }] }] },
      { sections: [{ id: "s", blocks: [{ kind: "lines", lines: [1] }] }] },
      { sections: [{ id: "s", blocks: [{ kind: "kv", rows: [{ key: "k", indent: 2 }] }] }] },
      {
        sections: [
          {
            id: "s",
            blocks: [{ kind: "table", headers: ["A"], rows: [["1"]], aligns: ["center"] }],
          },
        ],
      },
    ]) {
      expect(isReportDocument(value)).toBe(false);
    }
  });
});
