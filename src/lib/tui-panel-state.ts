import type { AccountingMetadata, QuotaRunwayProjection } from "./entries.js";

export type PromptBarEntry = {
  /** Preformatted primary semantic label/value segment for rich accounting rows. */
  semanticSegment?: string;
  /** Provider plus window label for percentage rows, for example `OpenAI 5h`. */
  identityLabel?: string;
  label?: string;
  name?: string;
  group?: string;
  percentRemaining?: number;
  resetTimeIso?: string;
  runway?: QuotaRunwayProjection;
  accounting?: AccountingMetadata;
};
