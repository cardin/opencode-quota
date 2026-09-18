import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";

/** Minimal theme shape shared by the V1 TUI API and the V2 host adapter. */
export type SidebarTheme = {
  readonly text: unknown;
  readonly textMuted: unknown;
};

export function getSidebarBodyLineColor<Theme extends SidebarTheme>(
  line: string,
  theme: Theme,
): Theme["text"] | Theme["textMuted"] {
  return line.length > 0 && SESSION_TOKEN_SECTION_HEADING.startsWith(line)
    ? theme.text
    : theme.textMuted;
}
