import { describe, expect, it } from "vitest";

import {
  containsQuotaReport,
  formatQuotaReportMessage,
  readQuotaReportMetadata,
  removeQuotaReports,
} from "../src/lib/quota-report-message.js";
import { messageDocument } from "../src/lib/report-document.js";

describe("quota report messages", () => {
  it("wraps the report in a fixed first and last line", () => {
    const message = formatQuotaReportMessage("# Quota\nopenai  ███░░ 42%");

    expect(message).toBe(
      "[OpenCode Quota report]\n# Quota\nopenai  ███░░ 42%\n[End of OpenCode Quota report]",
    );
    expect(containsQuotaReport(message)).toBe(true);
  });

  it("cuts every complete report out of text and leaves everything else", () => {
    const first = formatQuotaReportMessage("openai 42%");
    const second = formatQuotaReportMessage("anthropic 7%");
    const text = `[User]: hi\n\n[User]: ${first}\n\n[Assistant]: ok\n\n[User]: ${second}`;

    expect(removeQuotaReports(text)).toBe("[User]: hi\n\n[User]: \n\n[Assistant]: ok\n\n[User]: ");
    expect(removeQuotaReports("[OpenCode Quota report] without an end line")).toBe(
      "[OpenCode Quota report] without an end line",
    );
    expect(removeQuotaReports("no report")).toBe("no report");
  });

  it("reads only well-formed report metadata", () => {
    const metadata = {
      command: "quota",
      title: "OpenCode Quota",
      at: 1,
      document: messageDocument("openai 42%"),
    };

    expect(readQuotaReportMetadata({ opencodeQuota: metadata })).toEqual(metadata);
    // No report document, or a malformed one: the TUI has nothing to draw.
    expect(
      readQuotaReportMetadata({ opencodeQuota: { ...metadata, document: undefined } }),
    ).toBeUndefined();
    expect(
      readQuotaReportMetadata({ opencodeQuota: { ...metadata, document: "openai 42%" } }),
    ).toBeUndefined();
    expect(readQuotaReportMetadata(undefined)).toBeUndefined();
    expect(readQuotaReportMetadata({ displayText: "hi" })).toBeUndefined();
    expect(readQuotaReportMetadata({ opencodeQuota: "quota" })).toBeUndefined();
    expect(readQuotaReportMetadata({ opencodeQuota: { command: "quota" } })).toBeUndefined();
  });
});
