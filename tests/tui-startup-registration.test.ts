import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createTuiQuotaClient, disposeQuotaTelemetryOwner, resolveTuiSurfaceRegistration } =
  vi.hoisted(() => ({
    createTuiQuotaClient: vi.fn(() => ({ config: {} })),
    disposeQuotaTelemetryOwner: vi.fn(),
    resolveTuiSurfaceRegistration: vi.fn(),
  }));

vi.mock("../src/lib/tui-runtime.js", () => ({
  createTuiQuotaClient,
  getTuiRuntimeRootHints: vi.fn(() => ({})),
  getTuiSessionModelMeta: vi.fn(),
  loadTuiHomeBottomStatus: vi.fn(),
  loadTuiSessionQuotaSurfaces: vi.fn(),
  normalizeTuiSessionID: vi.fn(),
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled: vi.fn(),
}));

vi.mock("../src/lib/quota-telemetry.js", () => ({
  disposeQuotaTelemetryOwner,
}));

vi.mock("solid-js", () => ({
  Show: vi.fn(),
  createEffect: vi.fn(),
  createSignal: <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T | ((previous: T) => T)) => {
        value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
        return value;
      },
    ];
  },
  onCleanup: vi.fn(),
}));

vi.mock("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: vi.fn(),
  jsxs: vi.fn(),
}));

const OBSERVATION_HORIZON_MS = 60_000;
const WARMUP_SAMPLES = 3;
const RECORDED_SAMPLES = 30;

const FULL_REGISTRATION = {
  commandDisplay: "inline",
  sidebar: { enabled: true },
  compact: {
    enabled: true,
    homeBottom: true,
    sessionPrompt: true,
    hasNativeProviderQuota: false,
    suppressedByNativeProviderQuota: false,
  },
  announcements: { homeBottom: false },
  homeBottom: true,
} as const;

type StartupMetric =
  | "T_return"
  | "T_plan_resolved"
  | "T_command"
  | "T_sidebar"
  | "T_session_prompt"
  | "T_home_bottom"
  | "T_registration_complete";

type RecordedEvent = Exclude<StartupMetric, "T_registration_complete">;

type StartupSample = {
  events: Partial<Record<RecordedEvent, number>>;
  duplicateRegistrations: string[];
  keymapAttempts: number;
};

type Scenario = {
  name: string;
  config: "resolve" | "reject" | "never";
  delayMs?: number;
  disposeAtMs?: number;
  registerLayerThrows?: boolean;
  completionEvents: RecordedEvent[];
  reportedMetrics: StartupMetric[];
  expected: Partial<Record<StartupMetric, number | null>>;
};

type Aggregate = {
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  censored: number;
};

type ScenarioResult = {
  scenario: Scenario;
  samples: StartupSample[];
  aggregates: Map<StartupMetric, Aggregate>;
};

const fullCompletionEvents: RecordedEvent[] = [
  "T_command",
  "T_sidebar",
  "T_session_prompt",
  "T_home_bottom",
];
const fullReportedMetrics: StartupMetric[] = [
  "T_return",
  "T_plan_resolved",
  ...fullCompletionEvents,
  "T_registration_complete",
];

const scenarios: Scenario[] = [
  {
    name: "immediate",
    config: "resolve",
    delayMs: 0,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: Object.fromEntries(fullReportedMetrics.map((metric) => [metric, 0])),
  },
  {
    name: "delay-25",
    config: "resolve",
    delayMs: 25,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: 25,
      T_command: 0,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      T_registration_complete: 0,
    },
  },
  {
    name: "delay-2000",
    config: "resolve",
    delayMs: 2_000,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: 2_000,
      T_command: 0,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      T_registration_complete: 0,
    },
  },
  {
    name: "never",
    config: "never",
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: null,
      T_command: 0,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      T_registration_complete: 0,
    },
  },
  {
    name: "reject-2000",
    config: "reject",
    delayMs: 2_000,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: 2_000,
      T_command: 0,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      T_registration_complete: 0,
    },
  },
  {
    name: "dispose-before-resolution",
    config: "resolve",
    delayMs: 2_000,
    disposeAtMs: 100,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: 2_000,
      T_command: 0,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      T_registration_complete: 0,
    },
  },
  {
    name: "register-layer-throws",
    config: "resolve",
    delayMs: 0,
    registerLayerThrows: true,
    completionEvents: fullCompletionEvents,
    reportedMetrics: fullReportedMetrics,
    expected: {
      T_return: 0,
      T_plan_resolved: 0,
      // Slots register synchronously during setup; only the command layer can
      // be censored, because its `keymap.layer` call is what throws.
      T_command: null,
      T_sidebar: 0,
      T_session_prompt: 0,
      T_home_bottom: 0,
      // Completion is the max of every completion event; a missing command
      // event keeps it censored.
      T_registration_complete: null,
    },
  },
];

let plugin: typeof import("../src/tui.tsx")["default"];
const results: ScenarioResult[] = [];

function flushPromises(): Promise<void> {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

function metricValue(
  sample: StartupSample,
  scenario: Scenario,
  metric: StartupMetric,
): number | null {
  if (metric !== "T_registration_complete") return sample.events[metric] ?? null;

  const values = scenario.completionEvents.map((event) => sample.events[event]);
  if (values.some((value) => value === undefined)) return null;
  return Math.max(...(values as number[]));
}

function aggregate(samples: StartupSample[], scenario: Scenario, metric: StartupMetric): Aggregate {
  const values = samples
    .map((sample) => metricValue(sample, scenario, metric))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return { min: null, median: null, p95: null, max: null, censored: samples.length };
  }

  const valueAt = (index: number): number => {
    const value = values[index];
    if (value === undefined) throw new Error(`Missing aggregate value at index ${index}`);
    return value;
  };
  const medianIndex = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0
      ? (valueAt(medianIndex - 1) + valueAt(medianIndex)) / 2
      : valueAt(medianIndex);
  const p95Index = Math.ceil(values.length * 0.95) - 1;

  return {
    min: valueAt(0),
    median,
    p95: valueAt(p95Index),
    max: valueAt(values.length - 1),
    censored: samples.length - values.length,
  };
}

async function runSample(scenario: Scenario): Promise<StartupSample> {
  vi.clearAllTimers();
  vi.setSystemTime(0);

  const events: StartupSample["events"] = {};
  const duplicateRegistrations: string[] = [];
  let keymapAttempts = 0;
  let dispose: (() => void) | undefined;

  const record = (event: RecordedEvent) => {
    if (events[event] !== undefined) {
      duplicateRegistrations.push(event);
      return;
    }
    events[event] = Date.now();
  };

  // OpenCode 2 CLI plugins receive a single `Context` and use slots/layers
  // instead of the V1 `TuiPluginApi` registration methods.
  const context = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "2.0.7", channel: "dev" },
    theme: { text: { base: "text", muted: "muted" } },
    client: {
      provider: { list: vi.fn().mockResolvedValue({ data: [] }) },
      session: { get: vi.fn(), synthetic: vi.fn() },
    },
    data: {
      on: vi.fn(() => () => {}),
      listen: vi.fn(() => () => {}),
      session: {
        get: vi.fn(),
        status: vi.fn(() => "idle"),
        message: { list: vi.fn(() => []) },
      },
      location: { provider: { list: vi.fn(() => []) } },
    },
    ui: {
      slot: vi.fn((claim: { append: string; render: (input: unknown) => unknown }) => {
        if (claim.append === "app") {
          // OpenCode mounts app slots inside the Solid owner that provides the
          // keymap context; render immediately so `keymap.layer` runs there.
          claim.render({});
        }
        if (claim.append === "sidebar.content") record("T_sidebar");
        if (claim.append === "session.composer.top") record("T_session_prompt");
        if (claim.append === "home.footer") record("T_home_bottom");
        return () => {};
      }),
      toast: { show: vi.fn() },
      dialog: {
        show: vi.fn(),
        set: vi.fn(),
        clear: vi.fn(),
        prompt: vi.fn(),
        alert: vi.fn(),
        confirm: vi.fn(),
        select: vi.fn(),
      },
      router: { current: vi.fn(() => ({ type: "home" })) },
    },
    keymap: {
      layer: vi.fn((resolveLayer: () => unknown) => {
        keymapAttempts += 1;
        if (scenario.registerLayerThrows) throw new Error("registration unavailable");
        record("T_command");
        resolveLayer();
        return () => {};
      }),
    },
    storage: {
      memory: vi.fn(() => [{}, vi.fn()]),
      store: vi.fn(() => [{}, vi.fn()]),
    },
  };

  resolveTuiSurfaceRegistration.mockImplementationOnce(async () => {
    if (scenario.config === "never") {
      await new Promise<never>(() => {});
    }
    if (scenario.delayMs && scenario.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, scenario.delayMs);
      });
    }
    record("T_plan_resolved");
    if (scenario.config === "reject") throw new Error("config unavailable");
    return FULL_REGISTRATION;
  });

  const returned = Promise.resolve(plugin.setup(context as never));
  void returned.then((cleanup) => {
    dispose = (cleanup as (() => void) | undefined) ?? undefined;
    record("T_return");
  });

  if (scenario.disposeAtMs !== undefined) {
    setTimeout(() => {
      dispose?.();
    }, scenario.disposeAtMs);
  }

  await flushPromises();
  await vi.advanceTimersByTimeAsync(OBSERVATION_HORIZON_MS);
  await flushPromises();

  return { events, duplicateRegistrations, keymapAttempts };
}

function formatValue(value: number | null): string {
  return value === null ? `>${OBSERVATION_HORIZON_MS}` : String(value);
}

beforeAll(async () => {
  vi.useFakeTimers();
  (globalThis as { React?: unknown }).React = {
    createElement: (type: unknown, props: unknown) =>
      typeof type === "function" ? (type as (p: unknown) => unknown)(props) : { type, props },
  };
  plugin = (await import("../src/tui.tsx")).default;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  if (process.env.OPENCODE_QUOTA_TUI_STARTUP_REPORT === "1") {
    console.log(`\nTUI startup registration candidate (virtual ms)`);
    console.log(
      `Warmups: ${WARMUP_SAMPLES}; recorded: ${RECORDED_SAMPLES}; horizon: ${OBSERVATION_HORIZON_MS} ms`,
    );
    console.log("| Scenario | Metric | Min | Median | p95 | Max | Censored |");
    console.log("|---|---|---:|---:|---:|---:|---:|");
    for (const result of results) {
      for (const metric of result.scenario.reportedMetrics) {
        const value = result.aggregates.get(metric);
        if (!value) throw new Error(`Missing aggregate for ${result.scenario.name} ${metric}`);
        console.log(
          `| ${result.scenario.name} | ${metric} | ${formatValue(value.min)} | ${formatValue(value.median)} | ${formatValue(value.p95)} | ${formatValue(value.max)} | ${value.censored} |`,
        );
      }
      if (result.scenario.name === "dispose-before-resolution") {
        console.log("| dispose-before-resolution | late registrations | 0 | 0 | 0 | 0 | 0 |");
      }
    }
  }

  vi.useRealTimers();
  delete (globalThis as { React?: unknown }).React;
});

describe("TUI startup registration timing", () => {
  for (const scenario of scenarios) {
    it(`${scenario.name}: records deterministic entry-to-registration milestones`, async () => {
      for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
        await runSample(scenario);
      }

      const samples: StartupSample[] = [];
      for (let index = 0; index < RECORDED_SAMPLES; index += 1) {
        samples.push(await runSample(scenario));
      }

      const aggregates = new Map<StartupMetric, Aggregate>();
      for (const metric of scenario.reportedMetrics) {
        const value = aggregate(samples, scenario, metric);
        aggregates.set(metric, value);

        const expected = scenario.expected[metric];
        if (expected === null) {
          expect(value).toEqual({
            min: null,
            median: null,
            p95: null,
            max: null,
            censored: RECORDED_SAMPLES,
          });
        } else {
          expect(value).toEqual({
            min: expected,
            median: expected,
            p95: expected,
            max: expected,
            censored: 0,
          });
        }
      }

      expect(samples.every((sample) => sample.duplicateRegistrations.length === 0)).toBe(true);
      if (scenario.name === "dispose-before-resolution") {
        expect(samples.every((sample) => sample.keymapAttempts === 1)).toBe(true);
      }
      if (scenario.name === "register-layer-throws") {
        expect(samples.every((sample) => sample.keymapAttempts === 1)).toBe(true);
      }

      results.push({ scenario, samples, aggregates });
    });
  }
});
