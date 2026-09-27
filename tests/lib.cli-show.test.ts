import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-service.js", () => ({
  discoverOpenCodeService: vi.fn(),
}));

vi.mock("../src/lib/quota-rpc-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-rpc-client.js")>()),
  callQuotaRpc: vi.fn(),
}));

import { runCliShowCommand } from "../src/lib/cli-show.js";
import { discoverOpenCodeService } from "../src/lib/opencode-service.js";
import { callQuotaRpc, QuotaRpcTransportError } from "../src/lib/quota-rpc-client.js";

const ENDPOINT = { url: "http://127.0.0.1:4096", headers: { authorization: "Basic abc" } };

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

async function runShow(argv: string[]) {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  const code = await runCliShowCommand({
    argv,
    stdout: stdout.stream as any,
    stderr: stderr.stream as any,
  });
  return { code, stdout: stdout.output, stderr: stderr.output };
}

describe("runCliShowCommand", () => {
  beforeEach(() => {
    vi.mocked(discoverOpenCodeService).mockReset().mockResolvedValue(ENDPOINT);
    vi.mocked(callQuotaRpc)
      .mockReset()
      .mockResolvedValue({ exitCode: 0, stdout: "Synthetic Weekly 75%\n", stderr: "" });
  });

  it("asks the running OpenCode service for the report at the home folder and prints it", async () => {
    const result = await runShow([]);

    expect(result).toEqual({ code: 0, stdout: "Synthetic Weekly 75%\n", stderr: "" });
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "show", providerId: undefined, threshold: undefined },
      { directory: homedir(), timeoutMs: 60_000 },
    );
  });

  it("forwards --json and --threshold and returns the report's exit code", async () => {
    vi.mocked(callQuotaRpc).mockResolvedValue({
      exitCode: 2,
      stdout: '{\n  "version": 2\n}\n',
      stderr: "",
    });

    const result = await runShow(["--json", "--threshold", "5"]);

    expect(result).toEqual({ code: 2, stdout: '{\n  "version": 2\n}\n', stderr: "" });
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "show-json", providerId: undefined, threshold: 5 },
      expect.anything(),
    );
  });

  it("prints the report's stderr and exit code when the server reports an error", async () => {
    vi.mocked(callQuotaRpc).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Quota disabled in config (enabled: false).\n",
    });

    const result = await runShow([]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Quota disabled in config (enabled: false).\n",
    });
  });

  it("normalizes --provider aliases before calling OpenCode", async () => {
    const result = await runShow(["--provider=github-copilot"]);

    expect(result.code).toBe(0);
    expect(callQuotaRpc).toHaveBeenCalledWith(
      ENDPOINT,
      "cli",
      { command: "show", providerId: "copilot", threshold: undefined },
      expect.anything(),
    );
  });

  it("exits 3 with an empty stdout when OpenCode is not running", async () => {
    vi.mocked(discoverOpenCodeService).mockResolvedValue(undefined);

    const result = await runShow(["--json"]);

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
        "OpenCode Quota's server plugin is not loaded. Check the plugin entry in opencode.json and restart OpenCode.",
      ),
    );

    const result = await runShow(["--json"]);

    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr:
        "OpenCode Quota's server plugin is not loaded. Check the plugin entry in opencode.json and restart OpenCode.\n",
    });
  });

  it("exits 3 when OpenCode returns an output that is not a report", async () => {
    vi.mocked(callQuotaRpc).mockResolvedValue({ exitCode: 0, stdout: 5 });

    const result = await runShow([]);

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("returned an unexpected result");
  });

  it("rejects an unknown provider before contacting OpenCode", async () => {
    const result = await runShow(["--provider", "not-a-provider"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown provider: not-a-provider");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
    expect(callQuotaRpc).not.toHaveBeenCalled();
  });

  it("rejects missing provider values", async () => {
    const result = await runShow(["--provider"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing value for --provider");
    expect(result.stderr).toContain("opencode-quota show");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });

  it("reports unknown flag with --json as error on stderr with exit code 1", async () => {
    const result = await runShow(["--json", "--bogus-flag"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --bogus-flag");
    expect(result.stderr).toContain("opencode-quota show");
  });

  it("--threshold validates input and requires --json", async () => {
    let result = await runShow(["--json", "--threshold", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    result = await runShow(["--json", "--threshold", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    result = await runShow(["--json", "--threshold"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --threshold");

    result = await runShow(["--threshold", "5"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold requires --json");

    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });

  it("prints help that names the OpenCode requirement and exit code 3", async () => {
    const result = await runShow(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("opencode-quota show");
    expect(result.stdout).toContain("Needs OpenCode running");
    expect(result.stdout).toContain("Exit code 3");
    expect(discoverOpenCodeService).not.toHaveBeenCalled();
  });
});
