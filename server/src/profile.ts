// Game profiles (docs/09-game-profiles.md section 3): how the rollups and the dashboard read a project's events.

/** A log10 track buckets by powers of ten; its milestones default to LOG_MILESTONES. */
export interface Track { key: string; label?: string; milestones: number[]; scale?: "log10" }
export interface Dim { key: string; label?: string; multi?: boolean }
export interface Profile {
  preset: string; play_label: string; play_kinds: string[]; tracks: Track[]; dimensions: Dim[]; flows: string[];
  /** A numeric play_end props key with the in-game play time in seconds, such as match_sec, without waiting screens. */
  play_time_prop?: string;
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
    flows: [], play_time_prop: "match_sec",
  },
  run_roguelike: {
    preset: "run_roguelike", play_label: "Run", play_kinds: ["run"],
    tracks: [{ key: "best_score", label: "Best score", milestones: [1000, 5000, 10000] }, { key: "account_level", label: "Account level", milestones: [5, 10, 20] }],
    dimensions: [{ key: "character" }, { key: "biome" }], flows: [],
  },
  // A run is one prestige cycle (docs/10-v0.3.1.md section 2).
  idle_tycoon: {
    preset: "idle_tycoon", play_label: "Run", play_kinds: ["run"],
    tracks: [{ key: "stage", label: "Stage", milestones: [10, 50, 100, 500] }, { key: "prestige_count", label: "Prestiges", milestones: [1, 5, 10, 25] },
      { key: "income_per_sec", label: "Income per second", milestones: [1e3, 1e6, 1e9, 1e12, 1e15, 1e18], scale: "log10" },
      { key: "account_level", label: "Account level", milestones: [5, 10, 20] }],
    dimensions: [{ key: "building" }, { key: "upgrade" }, { key: "boost" }, { key: "offer" }], flows: ["ftue"],
  },
};
export const LOG_MILESTONES = [1e3, 1e6, 1e9, 1e12, 1e15, 1e18, 1e21, 1e24, 1e27, 1e30];
const KIND_PRESET: Record<string, string> = { level: "puzzle_levels", match: "match_battle", round: "match_battle", run: "run_roguelike", session: "idle_tycoon" };
const kindPreset = (kind: string, idle: boolean) =>
  kind === "run" && idle ? "idle_tycoon" : Object.hasOwn(KIND_PRESET, kind) ? KIND_PRESET[kind] : null;
const isIdle = (r: { name: string; props: Record<string, unknown> }) =>
  r.name === "offline_reward" || (r.name === "play_end" && r.props.result === "prestige") || (r.name === "progress" && (r.props.track === "stage" || r.props.track === "prestige_count"));

/** The preset a chunk of events suggests, from its first play kind and any idle event; null when it says nothing. */
export function detect(rows: { name: string; props: Record<string, unknown> }[]): string | null {
  const idle = rows.some(isIdle);
  const play = rows.find((r) => r.name.startsWith("level_") || r.name === "play_start" || r.name === "play_end");
  if (!play) return idle ? "idle_tycoon" : null;
  return kindPreset(play.name.startsWith("level_") ? "level" : String(play.props.kind), idle);
}

/**
 * The preset the last days of rollups suggest: the play kind with the most plays; idle when a run prestiges or offline rewards
 * come in. To avoid rebuilding back and forth, the old preset stays while its play kinds still have plays, except that a run
 * game turns idle; an idle game never turns back into run_roguelike.
 */
export function detectFrom(kinds: { kind: string; n: number; prestiges: number }[], offline: number, old: string | null = null): string | null {
  const top = kinds.filter((k) => k.n > 0).sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind))[0];
  const idle = offline > 0 || kinds.some((k) => k.prestiges > 0);
  const next = top ? kindPreset(top.kind, idle) : idle ? "idle_tycoon" : null;
  if (!old || !next || next === old || !Object.hasOwn(PRESETS, old)) return next;
  if (old === "run_roguelike" && next === "idle_tycoon") return next;
  if (old === "idle_tycoon" && next === "run_roguelike") return old;
  return kinds.some((k) => k.n > 0 && PRESETS[old].play_kinds.includes(k.kind)) ? old : next;
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
  // "" or null unsets the preset's play_time_prop.
  const timeProp = !has("play_time_prop") ? base.play_time_prop : o.play_time_prop === "" || o.play_time_prop === null ? undefined : str(o.play_time_prop, 40);
  return {
    preset: base.preset,
    play_label: has("play_label") ? str(o.play_label, 20) : base.play_label,
    play_kinds: has("play_kinds") ? list(o.play_kinds, 5, (x) => str(x, 20)) : base.play_kinds,
    tracks: has("tracks") ? list(o.tracks, 5, (t) => {
      const r = t as Record<string, unknown>;
      const milestones = list(r?.milestones, 20, (m) => { if (typeof m !== "number" || !Number.isFinite(m)) throw new Error("milestones must be numbers"); return m; });
      if (r?.scale !== undefined && r.scale !== "linear" && r.scale !== "log10") throw new Error("scale must be linear or log10");
      const log = r?.scale === "log10";
      return { key: str(r?.key, 40), ...(r?.label ? { label: str(r.label, 40) } : {}),
        milestones: milestones.length || !log ? [...new Set(milestones)].sort((a, b) => a - b) : LOG_MILESTONES, ...(log ? { scale: "log10" as const } : {}) };
    }) : base.tracks,
    dimensions: has("dimensions") ? list(o.dimensions, 12, (d) => {
      const r = d as Record<string, unknown>;
      return { key: str(r?.key, 40), ...(r?.label ? { label: str(r.label, 40) } : {}), ...(r?.multi === true ? { multi: true } : {}) };
    }).filter((d, i, all) => { if (all.findIndex((x) => x.key === d.key) !== i) throw new Error(`dimension ${d.key} is declared twice`); return true; }) : base.dimensions,
    flows: has("flows") ? list(o.flows, 10, (x) => str(x, 40)) : base.flows,
    ...(timeProp ? { play_time_prop: timeProp } : {}),
  };
}

/** "Match" to "Matches", "Level" to "Levels". */
export const plural = (label: string) => /(s|x|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`;
