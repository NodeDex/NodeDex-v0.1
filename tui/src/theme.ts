// theme.ts — colors, type-colors, glyphs, and small formatting helpers.
// One place to retune the look.
//
// DESIGN (TUI v3, 2026-07-02): cool + casual. A Nord-derived palette — slate
// chrome, one soft frost-blue accent, and MUTED aurora colors reserved for the
// block types. The chrome stays quiet on purpose: the memory (typed blocks)
// carries almost all of the color, so the type system itself is the visual
// language (decision=green, dead_end=red, …) without anything reading neon.

export const theme = {
  accent: "#88C0D0", // frost blue — selection, keys, wordmark, active view
  title: "#81A1C1", // section headers (calm blue, one step dimmer than accent)
  label: "#7B88A1", // field labels
  value: "#E5E9F0", // field values (soft snow-white)
  border: "#4C566A", // panel borders (idle)
  borderHot: "#88C0D0", // panel borders (attention)
  ok: "#A3BE8C",
  warn: "#EBCB8B",
  danger: "#BF616A",
  dim: "#616E88",
} as const;

// Block type → color, keyed to the stance/role the type carries (muted aurora).
export const typeColor: Record<string, string> = {
  decision: "#A3BE8C",
  dead_end: "#BF616A",
  constraint: "#EBCB8B",
  insight: "#B48EAD",
  hypothesis: "#88C0D0",
  fact: "#81A1C1",
  blueprint: "#5E81AC",
  preference: "#D08770",
  artifact: "#D8DEE9",
  task: "#8FBCBB",
  project: "#ECEFF4",
  process: "#616E88",
  chain: "#D08770",
  question: "#EBCB8B",
  event: "#7B88A1",
};

export const glyph = {
  up: "●",
  paused: "‖",
  down: "●",
  read: "▸",
  chain: "⛓",
  tree: "⌂",
  save: "+",
  block: "▰",
  flag: "⚑",
  warn: "⚠",
  okMark: "✓",
  arrow: "›",
  tick: "⟳",
} as const;

export function typeColorOf(type?: string): string {
  return (type && typeColor[type]) || theme.value;
}

// One symbol per type so block lists scan without reading words.
export const typeGlyph: Record<string, string> = {
  constraint: "▣",
  decision: "◆",
  dead_end: "✕",
  preference: "★",
  blueprint: "◇",
  question: "?",
  hypothesis: "≈",
  task: "▸",
  fact: "▰",
  insight: "◐",
  event: "•",
  chain: "⛓",
  project: "⌂",
};

export function typeGlyphOf(type?: string): string {
  return (type && typeGlyph[type]) || "▪";
}

export function relTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtNum(n?: number | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function fmtMoney(n?: number | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function trunc(s: string | undefined | null, n: number): string {
  const str = (s ?? "").replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}
