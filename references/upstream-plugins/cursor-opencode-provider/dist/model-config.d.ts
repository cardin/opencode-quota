import { type ModelInfo, type ModelVariant } from "./models.js";
/**
 * Display names shared by both a thinking and a non-thinking model. A thinking
 * model with such a name needs a "Thinking" tag to disambiguate it from its
 * non-thinking twin (Cursor's Claude/Fable/Sonnet families). Models whose names
 * are already unique — including Cursor's GPT family, where the reasoning tier
 * ("None"/"Low"/"High"…) is baked into the name — are excluded, so they aren't
 * tagged redundantly.
 */
export declare function thinkingSuffixBaseNames(models: ModelInfo[]): Set<string>;
export declare function modelInfoToConfig(mi: ModelInfo, options?: {
    thinkingSuffix?: boolean;
    contextTier?: "base" | "long";
    variants?: ModelVariant[];
    fast?: boolean;
}): Record<string, any>;
export declare function modelsToConfig(models: ModelInfo[]): Record<string, any>;
