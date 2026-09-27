import { homedir } from "node:os";
import type { QuotaRpcCliInput, QuotaRpcCliOutput } from "../rpc.js";
import { discoverOpenCodeService } from "./opencode-service.js";
import { getQuotaProviderShape } from "./provider-metadata.js";
import { callQuotaRpc } from "./quota-rpc-client.js";

export interface RunCliShowCommandOptions {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedShowArgs =
  | { ok: true; providerId?: string; help: boolean; json: boolean; threshold?: number }
  | { ok: false; error: string };

const SHOW_USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota show [--provider <provider-id>] [--json] [--threshold <pct>]",
  "",
  "Needs OpenCode running: the quota comes from its background service.",
  "",
  "Options:",
  "  --provider <provider-id>  Show quota for one provider",
  "  --json                    Machine-readable JSON output (reads from cache)",
  "  --threshold <pct>         With --json, exit 1 if any complete cached percentage is below",
  "                            <pct>% remaining (exit 2 if data is incomplete or not comparable)",
  "  --help, -h                Show help",
  "",
  "Exit code 3: OpenCode is not running or the plugin could not be reached.",
].join("\n");

function parseShowArgs(argv: string[]): ParsedShowArgs {
  let providerId: string | undefined;
  let json = false;
  let threshold: number | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true, json: false };
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--threshold" || arg.startsWith("--threshold=")) {
      let value: string | undefined;
      if (arg === "--threshold") {
        value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          return { ok: false, error: "Missing value for --threshold." };
        }
        index += 1;
      } else {
        value = arg.slice("--threshold=".length).trim();
        if (!value) {
          return { ok: false, error: "Missing value for --threshold." };
        }
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "--threshold must be a positive finite number." };
      }
      threshold = num;
      continue;
    }

    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length).trim();
      if (!value) {
        return { ok: false, error: "Missing value for --provider." };
      }
      if (providerId) {
        return { ok: false, error: "Specify --provider only once." };
      }
      providerId = value;
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  if (threshold !== undefined && !json) {
    return { ok: false, error: "--threshold requires --json." };
  }

  return { ok: true, providerId, help: false, json, threshold };
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function isCliOutput(value: unknown): value is QuotaRpcCliOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    Number.isInteger(output.exitCode) &&
    typeof output.stdout === "string" &&
    typeof output.stderr === "string"
  );
}

/**
 * Runs a `show` or `status` report inside the running OpenCode service, which computes it
 * for the home folder, and prints what it returns. Exit code 3 means OpenCode or the plugin
 * could not be reached; stdout then stays empty so JSON readers never parse an error.
 */
export async function runCliReportInOpenCode(params: {
  input: QuotaRpcCliInput;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<number> {
  const endpoint = await discoverOpenCodeService();
  if (!endpoint) {
    writeLine(params.stderr, "OpenCode is not running. Start OpenCode and try again.");
    return 3;
  }

  let output: unknown;
  try {
    output = await callQuotaRpc(endpoint, "cli", params.input, {
      directory: homedir(),
      timeoutMs: 60_000,
    });
  } catch (error) {
    writeLine(params.stderr, error instanceof Error ? error.message : String(error));
    return 3;
  }
  if (!isCliOutput(output)) {
    writeLine(
      params.stderr,
      "OpenCode Quota's server plugin returned an unexpected result. Update the plugin and restart OpenCode.",
    );
    return 3;
  }

  params.stdout.write(output.stdout);
  params.stderr.write(output.stderr);
  return output.exitCode;
}

export async function runCliShowCommand(options: RunCliShowCommandOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseShowArgs(argv);
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, SHOW_USAGE);
    return 1;
  }

  if (parsed.help) {
    writeLine(stdout, SHOW_USAGE);
    return 0;
  }

  const providerId = parsed.providerId ? getQuotaProviderShape(parsed.providerId)?.id : undefined;
  if (parsed.providerId && !providerId) {
    writeLine(stderr, `Unknown provider: ${parsed.providerId}`);
    return 1;
  }

  return runCliReportInOpenCode({
    input: {
      command: parsed.json ? "show-json" : "show",
      providerId,
      threshold: parsed.threshold,
    },
    stdout,
    stderr,
  });
}
