// Game profiles (docs/09-game-profiles.md section 3): how the rollups and the dashboard read a project's events.

export interface Track { key: string; label?: string; milestones: number[] }
export interface Dim { key: string; label?: string; multi?: boolean }
export interface Profile {
  preset: string; play_label: string; play_kinds: string[]; tracks: Track[]; dimensions: Dim[]; flows: string[];
}

/** Dimension key "level" is the play key itself, such as a board. */
export const PRESETS: Record<string, Profile> = {
  puzzle_levels: {
    preset: "puzzle_levels", play_label: "Level", play_kinds: ["level"], tracks: [],
    dimensions: [{ key: "booster" }, { key: "difficulty" }], flows: [],
  },
  match_battle: {
    preset: "match_battle", play_label: "Match", play_kinds: ["match"],
    tracks: [{ key: "trophies", label: "Trophies", milestones: [300, 800, 1500] }, { key: "arena", label: "Arena", milestones: [2, 3, 4] }],
    dimensions: [{ key: "level", label: "Board" }, { key: "mode" }, { key: "difficulty" }, { key: "opponent" }, { key: "deck", multi: true, label: "Card" }],
    flows: [],
  },
  run_roguelike: {
    preset: "run_roguelike", play_label: "Run", play_kinds: ["run"],
    tracks: [{ key: "best_score", label: "Best score", milestones: [1000, 5000, 10000] }, { key: "account_level", label: "Account level", milestones: [5, 10, 20] }],
    dimensions: [{ key: "character" }, { key: "biome" }], flows: [],
  },
  idle_tycoon: {
    preset: "idle_tycoon", play_label: "Session", play_kinds: ["session"],
    tracks: [{ key: "stage", label: "Stage", milestones: [10, 50, 100] }, { key: "prestige", label: "Prestige", milestones: [1, 5, 10] }],
    dimensions: [{ key: "building" }], flows: [],
  },
};
const KIND_PRESET: Record<string, string> = { level: "puzzle_levels", match: "match_battle", round: "match_battle", run: "run_roguelike", session: "idle_tycoon" };

/** The preset a chunk of events suggests, from its play kinds and tracks; null when it says nothing. */
export function detect(rows: { name: string; props: Record<string, unknown> }[]): string | null {
  for (const r of rows) {
    if (r.name.startsWith("level_")) return "puzzle_levels";
    if (r.name === "play_start" || r.name === "play_end") return Object.hasOwn(KIND_PRESET, String(r.props.kind)) ? KIND_PRESET[String(r.props.kind)] : null;
    if (r.name === "progress" && (r.props.track === "stage" || r.props.track === "prestige")) return "idle_tycoon";
  }
  return null;
}

/** The saved profile, else the detected preset, else null. */
export function effectiveProfile(saved: string | null | undefined, detected: string | null | undefined): Profile | null {
  if (saved) { try { return parseProfile(JSON.parse(saved)); } catch { /* fall through to the detected preset */ } }
  return detected && Object.hasOwn(PRESETS, detected) ? PRESETS[detected] : null;
}

const str = (v: unknown, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`expected a string of at most ${max} characters`);
  return v.trim();
};
const list = <T>(v: unknown, max: number, item: (x: unknown) => T): T[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new Error(`expected a list of at most ${max} items`);
  return v.map(item);
};

/** Validates a profile from Settings. Missing fields come from its preset. Throws with a message on bad input. */
export function parseProfile(v: unknown): Profile {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  const o = v as Record<string, unknown>;
  const base = Object.hasOwn(PRESETS, String(o.preset)) ? PRESETS[String(o.preset)] : PRESETS.puzzle_levels;
  const has = (k: string) => o[k] !== undefined;
  return {
    preset: base.preset,
    play_label: has("play_label") ? str(o.play_label, 20) : base.play_label,
    play_kinds: has("play_kinds") ? list(o.play_kinds, 5, (x) => str(x, 20)) : base.play_kinds,
    tracks: has("tracks") ? list(o.tracks, 5, (t) => {
      const r = t as Record<string, unknown>;
      const milestones = list(r?.milestones, 20, (m) => { if (typeof m !== "number" || !Number.isFinite(m)) throw new Error("milestones must be numbers"); return m; });
      return { key: str(r?.key, 40), ...(r?.label ? { label: str(r.label, 40) } : {}), milestones: [...new Set(milestones)].sort((a, b) => a - b) };
    }) : base.tracks,
    dimensions: has("dimensions") ? list(o.dimensions, 10, (d) => {
      const r = d as Record<string, unknown>;
      return { key: str(r?.key, 40), ...(r?.label ? { label: str(r.label, 40) } : {}), ...(r?.multi === true ? { multi: true } : {}) };
    }).filter((d, i, all) => { if (all.findIndex((x) => x.key === d.key) !== i) throw new Error(`dimension ${d.key} is declared twice`); return true; }) : base.dimensions,
    flows: has("flows") ? list(o.flows, 10, (x) => str(x, 40)) : base.flows,
  };
}

/** "Match" to "Matches", "Level" to "Levels". */
export const plural = (label: string) => /(s|x|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`;
