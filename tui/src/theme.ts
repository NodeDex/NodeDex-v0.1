// theme.ts — colors, type-colors, glyphs, and small formatting helpers.
// One place to retune the look. Block types are colored by epistemic role so the
// type system itself becomes the visual language (decision=go, dead_end=stop, ...).

export const theme = {
  accent: "#ffb454", // amber wordmark / keys / active tab
  title: "cyan", // panel titles
  label: "gray", // field labels
  value: "white", // field values
  border: "gray", // panel borders (idle)
  borderHot: "#ffb454", // panel borders (attention)
  ok: "green",
  warn: "yellow",
  danger: "red",
  dim: "gray",
} as const;

// Block type → color, keyed to the stance/role the type carries.
export const typeColor: Record<string, string> = {
  decision: "green",
  dead_end: "red",
  constraint: "yellow",
  insight: "magenta",
  hypothesis: "cyan",
  fact: "blue",
  blueprint: "blueBright",
  preference: "magentaBright",
  artifact: "white",
  task: "cyanBright",
  project: "whiteBright",
  process: "gray",
  chain: "yellowBright",
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
  return (type && typeColor[type]) || "white";
}

// One symbol per type so block lists scan without reading words (TUI-V2 §2.1.1
// rule 2). Legend belongs in the [?] overlay when it lands.
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
