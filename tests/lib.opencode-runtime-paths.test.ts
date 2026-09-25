import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "../src/lib/opencode-runtime-paths.js";

describe("opencode-runtime-paths", () => {
  it("builds deterministic dirs from XDG env fallbacks", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "/x/data",
      XDG_CONFIG_HOME: "/x/config",
      XDG_CACHE_HOME: "/x/cache",
      XDG_STATE_HOME: "/x/state",
    };

    const dirs = getOpencodeRuntimeDirs({ env, homeDir: "/home/test" });
    expect(dirs).toEqual({
      dataDir: join(env.XDG_DATA_HOME!, "opencode"),
      configDir: join(env.XDG_CONFIG_HOME!, "opencode"),
      cacheDir: join(env.XDG_CACHE_HOME!, "opencode"),
      stateDir: join(env.XDG_STATE_HOME!, "opencode"),
    });
  });

  it("uses OPENCODE_CONFIG_DIR as the primary global config directory", () => {
    const absoluteConfigDir = resolve("custom", "opencode");
    const absolute = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: absoluteConfigDir,
      },
      homeDir: "/home/test",
    });
    expect(absolute.configDir).toBe(absoluteConfigDir);

    const relative = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: "work-profile",
      },
      homeDir: "/home/test",
    });
    expect(relative.configDir).toBe(resolve(join("/x/config", "opencode"), "work-profile"));

    const candidates = getOpencodeRuntimeDirCandidates({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: absoluteConfigDir,
      },
      homeDir: "/home/test",
    });
    expect(candidates.configDirs[0]).toBe(absoluteConfigDir);
  });

  it("includes Windows APPDATA/LOCALAPPDATA fallbacks after primary", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "C:/Users/u.local/share",
      XDG_CONFIG_HOME: "C:/Users/u.local/config",
      XDG_CACHE_HOME: "C:/Users/u.local/cache",
      XDG_STATE_HOME: "C:/Users/u.local/state",
      APPDATA: "C:/Users/u/AppData/Roaming",
      LOCALAPPDATA: "C:/Users/u/AppData/Local",
    };

    const primary = getOpencodeRuntimeDirs({ env, homeDir: "C:/Users/u" });
    const c = getOpencodeRuntimeDirCandidates({
      platform: "win32",
      env,
      homeDir: "C:/Users/u",
      primary,
    });

    expect(c.configDirs[0]).toBe(primary.configDir);
    expect(c.cacheDirs[0]).toBe(primary.cacheDir);
    expect(c.stateDirs[0]).toBe(primary.stateDir);

    expect(c.configDirs).toContain(join(env.APPDATA!, "opencode"));
    expect(c.configDirs).toContain(join(env.LOCALAPPDATA!, "opencode"));
  });
});
