import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-service.js", () => ({
  discoverOpenCodeService: vi.fn(),
}));

vi.mock("../src/lib/quota-rpc-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-rpc-client.js")>()),
  callQuotaRpc: vi.fn(),
}));

import { runCliStatusCommand } from "../src/lib/cli-status.js";
import { discoverOpenCodeService } from "../src/lib/opencode-service.js";
import { callQuotaRpc, QuotaRpcTransportError } from "../src/lib/quota-rpc-client.js";

const ENDPOINT = { url: "http://127.0.0.1:4096", headers: {} };

function createCaptureStream() {
  let output = "";
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      },
    },
    get output() {
      return output;
    },
  };
}

async function runStatus(argv: string[]) {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const code = await runCliStatusCommand({
    argv,
    stdout: stdout.stream as any,
    stderr: stderr.stream as any,
  });
  return { code, stdout: stdout.output, stderr: stderr.output };
}

describe("runCliStatusCommand", () => {
  beforeEach(() => {
    vi.mocked(discoverOpenCodeService).mockReset().mockResolvedValue(ENDPOINT);
    vi.mocked(callQuotaRpc).mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: "Quota Status (opencode-quota v5.0.0)\n",
      stderr: "",
    });
  });

  it("asks the running OpenCode service for the report at the home folder and prints it", async () => {
    const result = await runStatus([]);

    expect(result).toEqual({
      code: 0,
      stdout: "Quota Status (opencode-quota v5.0.0)\n",
      stderr: "",
    });
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "status", providerId: undefined },
      { directory: homedir(), timeoutMs: 60_000 },
    );
  });

  it("forwards --json and returns the report's exit code", async () => {
    vi.mocked(callQuotaRpc).mockResolvedValue({
      exitCode: 2,
      stdout: '{\n  "liveProbes": []\n}\n',
      stderr: "",
    });

    const result = await runStatus(["--json"]);

    expect(result).toEqual({ code: 2, stdout: '{\n  "liveProbes": []\n}\n', stderr: "" });
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "status-json", providerId: undefined },
      expect.anything(),
    );
  });

  it("--provider --json forwards the provider filter", async () => {
    const result = await runStatus(["--json", "--provider", "synthetic"]);

    expect(result.code).toBe(0);
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "status-json", providerId: "synthetic" },
      expect.anything(),
    );
  });

  it("resolves a case-insensitive provider synonym before filtering", async () => {
    const result = await runStatus(["--provider", "  CLAUDE  "]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "status", providerId: "anthropic" },
      expect.anything(),
    );
  });

  it("exits 3 with an empty stdout when OpenCode is not running", async () => {
    vi.mocked(discoverOpenCodeService).mockResolvedValue(undefined);

    const result = await runStatus(["--json"]);

    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: "OpenCode is not running. Start OpenCode and try again.\n",
    });
    expect(callQuotaRpc).not.toHaveBeenCalled();
  });

  it("exits 3 with an empty stdout when the call to OpenCode fails", async () => {
    vi.mocked(callQuotaRpc).mockRejectedValue(
      new QuotaRpcTransportError(
        "OpenCode's service password changed. Restart OpenCode and try again.",
      ),
    );

    const result = await runStatus([]);

    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: "OpenCode's service password changed. Restart OpenCode and try again.\n",
    });
  });

  it("rejects --threshold with a redirect to show --json --threshold", async () => {
    const result = await runStatus(["--threshold", "50"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--threshold is not supported by status");
    expect(result.stderr).toContain("opencode-quota show --json --threshold");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });

  it("rejects --threshold even when combined with --json", async () => {
    const result = await runStatus(["--json", "--threshold=10"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold is not supported by status");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider before contacting OpenCode", async () => {
    const result = await runStatus(["--provider", "not-a-provider"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown provider: not-a-provider");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
    expect(callQuotaRpc).not.toHaveBeenCalled();
  });

  it("rejects a missing --provider value", async () => {
    const result = await runStatus(["--provider"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --provider");
    expect(result.stderr).toContain("opencode-quota status");
  });

  it("rejects an unknown flag", async () => {
    const result = await runStatus(["--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --bogus");
    expect(result.stderr).toContain("opencode-quota status");
  });

  it("prints help and returns zero for --help", async () => {
    const result = await runStatus(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("opencode-quota status");
    expect(result.stdout).toContain("Needs OpenCode running");
    expect(result.stdout).toContain("Exit codes:");
    expect(result.stdout).toContain(
      "3  OpenCode is not running or the plugin could not be reached",
    );
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });
});
