// One alarm hue for "uphill" in every view: full strength (and an outline in
// the matrix) for what this change added, a paler tint for uphill links that
// were already there. Everything else stays grey. Agent-assisted and human
// commits get violet and light grey (different lightness, so they stay
// apart for colour-blind readers too). style.css repeats these values.
export const COLOUR = {
  uphill: "#e5484d",
  uphillOld: "rgba(229, 72, 77, 0.5)",
  other: "#8a8f98",
  ink: "#e0e0e0",
  muted: "#8a8a8a",
  grid: "#383838",
  agent: "#8f7cf7",
  human: "#cfcfcf",
  surface: "#202020",
};
