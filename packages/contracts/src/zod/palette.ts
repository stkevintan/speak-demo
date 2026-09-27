/**
 * The six brand colours, mirrored from `docs/design/UI.md` §Colour.
 *
 * A course picks an accent **by name**, never by hex. That is deliberate: the
 * design system owns contrast, and `UI.md` §6 records the verified ratio for
 * every fill/ink pair below. If a course file could choose `#FFFF00`, a content
 * edit could silently break an accessibility guarantee that was checked once
 * and is now nobody's job.
 *
 * `fill` is for shapes and icon glyphs. `ink` is the tone to use when the colour
 * has to carry *text* — see `UI.md` §6 for why they differ.
 */
export const ACCENTS = {
  coral: { fill: "#FF6B4A", ink: "#B23A1A", soft: "#FFE9E2" },
  violet: { fill: "#7C5CFF", ink: "#5B3FD6", soft: "#EFEAFF" },
  teal: { fill: "#12C8A0", ink: "#08735A", soft: "#DEF7F0" },
  sun: { fill: "#FFC93C", ink: "#8A6013", soft: "#FFF4D8" },
  sky: { fill: "#3DBDFF", ink: "#1A6A99", soft: "#E1F2FF" },
  pink: { fill: "#FF7AC6", ink: "#A8347F", soft: "#FFE6F5" },
} as const;

export type AccentName = keyof typeof ACCENTS;
export type AccentTokens = (typeof ACCENTS)[AccentName];

/** `satisfies` keeps the literal union above and the runtime list in lockstep. */
export const ACCENT_NAMES = Object.keys(ACCENTS) as [AccentName, ...AccentName[]];
