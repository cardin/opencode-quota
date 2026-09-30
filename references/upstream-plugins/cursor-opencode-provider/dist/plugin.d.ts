import type { Hooks, PluginInput } from "@opencode-ai/plugin";
export { modelInfoToConfig, modelsToConfig, thinkingSuffixBaseNames } from "./model-config.js";
export declare function loadClassicTools(options?: {
    importModule?: (specifier: string) => Promise<{
        tool?: any;
    }>;
    configDirs?: string[];
}): Promise<{
    webSearch: any;
    imageSave: any;
}>;
export declare function CursorPlugin(input: PluginInput): Promise<Hooks>;
