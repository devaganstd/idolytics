// Dashboard reads. Pages read rollup tables, except the raw filters, the Events tail and the device timeline.
import { DAY, DH, DUR_EDGES, QUIT_AFTER_MS, TH, type SeenKeys } from "./rollup";

export interface Filters {
  range: string; from: string; to: string; prevFrom: string; prevTo: string; days: number; compare: boolean;
  v: string | null; p: string | null; c: string | null; who: "all" | "new" | "returning";
  /** Raw filters: they read the events table. */
  device: string | null; events: string[]; props: [string, string][]; by: string | null;
  /** This page reads raw events; capped when the range was cut to RAW_MAX_DAYS. */
  raw: boolean; capped: boolean;
}
export const RANGES: Record<string, string> = { today: "Today", "7": "Last 7 days", "14": "Last 14 days", "30": "Last 30 days", "90": "Last 90 days" };
const MAX_DAYS = 366;
export const RAW_MAX_DAYS = 30;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
  && new Date(Date.parse(s)).toISOString().startsWith(s);
const opt = (s: string | null) => (s && s.length <= 64 ? s : null);

/** Reads the filter bar from the query string. from = to is one day. On a raw page the raw filters cap the range. */
export function parseFilters(q: URLSearchParams, today: string, rawPage = false): Filters {
  let range = q.get("range") ?? "30";
  let from: string, to: string;
  const qf = q.get("from"), qt = q.get("to");
  // Custom when asked for, or when only from and to are given; a preset picked in the form wins over stale dates.
  if ((range === "custom" || !q.has("range")) && isDay(qf) && isDay(qt)) {
    range = "custom";
    [from, to] = qf <= qt ? [qf, qt] : [qt, qf];
    if (diffDays(from, to) >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  } else {
    if (!(range in RANGES)) range = "30";
    to = today;
    from = range === "today" ? today : addDays(today, -(Number(range) - 1));
  }
  const device = opt(q.get("device")?.trim() || null);
  const events = [...new Set(q.getAll("event").flatMap((e) => e.split(",")).map((e) => e.trim()).filter((e) => KEY.test(e)))].slice(0, 10);
  const props = q.getAll("prop").filter((s) => s.includes("=")).map((s) => {
    const i = s.indexOf("=");
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()] as [string, string];
  }).filter(([k, v]) => KEY.test(k) && v.length <= 100).slice(0, 3);
  const by = KEY.test(q.get("by") ?? "") ? q.get("by") : null;
  const raw = rawPage && !!(device || props.length || by);
  const capped = raw && diffDays(from, to) >= RAW_MAX_DAYS;
  if (capped) from = addDays(to, -(RAW_MAX_DAYS - 1));
  const days = diffDays(from, to) + 1;
  const who = q.get("who");
  return {
    range, from, to, days, prevTo: addDays(from, -1), prevFrom: addDays(from, -days), compare: q.get("cmp") !== "off",
    v: opt(q.get("v")), p: opt(q.get("p")), c: opt(q.get("c")), who: who === "new" || who === "returning" ? who : "all",
    device, events, props, by, raw, capped,
  };
}

/**
 * WHERE for raw events in the range, by arrival time from the range's first local midnight. Arrival, not device
 * time, so the events_by_received index bounds the scan. With names, filters on f.events too.
 * shortcut: a late event counts on its arrival day here; fine for a 30 day debugging window.
 */
function rawWhere(project: string, f: Filters, tz: number, names = true) {
  const start = Date.parse(f.from) - tz * 60_000, end = Date.parse(f.to) + DAY - tz * 60_000;
  const conds = ["project_id = ?", "received_at >= ?", "received_at < ?"];
  const binds: unknown[] = [project, start, end];
  const eq = (col: string, v: string | null) => { if (v !== null) { conds.push(`${col} = ?`); binds.push(v); } };
  eq("app_version", f.v); eq("country", f.c); eq("device_id", f.device);
  if (f.p?.startsWith("!")) { conds.push("COALESCE(platform, '') <> ?"); binds.push(f.p.slice(1)); } else eq("platform", f.p);
  if (names && f.events.length) { conds.push(`name IN (${f.events.map(() => "?").join(", ")})`); binds.push(...f.events); }
  for (const [k, v] of f.props) {
    conds.push("CAST(json_extract(props, ?) AS TEXT) = ?");
    binds.push(`$.${k}`, v === "true" ? "1" : v === "false" ? "0" : v);
  }
  return { sql: conds.join(" AND "), binds };
}

interface ActivityRow { day: string; version: string; platform: string; country: string; is_new: number; players: number; sessions: number; playtime: number }
interface CohortRow { first_day: string; day: string; version: string; platform: string; country: string; devices: number }
export interface Kpis { dau: number; newUsers: number; sessions: number; sessionLength: number | null; playtimePerUser: number | null; d1: number | null; d7: number | null; stickiness: number | null }
export interface LevelRow {
  level: string; starts: number; players: number; wins: number; fails: number; quits: number; draws: number; abandons: number; prestiges: number;
  first_starts: number; first_try_wins: number;
  duration_sum: number; duration_n: number; stars_sum: number; stars_n: number; moves_left_sum: number; moves_left_n: number;
  /** Completed plays by duration and by in-game time, per DUR_EDGES bucket; empty on raw filtered pages. */
  time_sum: number; time_n: number; dh: number[]; th: number[];
}

/** The platform filter on column col: p, or every platform but x when p is "!x" (such as "!editor"). */
const PLAT = (p: string, col = "platform") => `(${p} IS NULL OR ${col} = ${p} OR (substr(${p}, 1, 1) = '!' AND ${col} <> substr(${p}, 2)))`;
const platOk = (p: string | null, platform: string) => !p || platform === p || (p[0] === "!" && platform !== p.slice(1));
const SUMS = (cols: string[]) => cols.map((c) => `SUM(${c}) AS ${c}`).join(", ");

/**
 * Quantile q of a duration histogram (counts per DUR_EDGES bucket), in ms, by linear interpolation inside its bucket.
 * open is true when it falls in the last bucket, which has no upper edge: the value is then that bucket's lower edge.
 */
export function quantile(counts: number[], q: number): { ms: number; open: boolean } | null {
  const total = counts.reduce((t, n) => t + n, 0);
  if (!total) return null;
  const target = q * total;
  let before = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] && before + counts[i] >= target) {
      const lo = i ? DUR_EDGES[i - 1] : 0;
      if (i === DUR_EDGES.length) return { ms: lo * 1000, open: true };
      return { ms: (lo + ((target - before) / counts[i]) * (DUR_EDGES[i] - lo)) * 1000, open: false };
    }
    before += counts[i];
  }
  return null;
}
const hist = (r: Record<string, unknown>, cols: string[]) => cols.map((c) => (r[c] as number) ?? 0);

/** Sum of D1 rows read by a set of results, for the X-D1-Rows-Read header. */
export const rowsRead = (results: D1Result[]) => results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0);

const dims = (f: Filters, r: { version: string; platform: string; country: string }) =>
  (!f.v || r.version === f.v) && platOk(f.p, r.platform) && (!f.c || r.country === f.c);
const DISTINCT = `SELECT COUNT(DISTINCT device_id) AS n FROM device_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
  AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} AND (?6 IS NULL OR country = ?6) AND (?7 IS NULL OR is_new = ?7)`;
/** Plays of the profile's kinds (?6, a JSON list; null for every kind). */
const KINDS = "(?6 IS NULL OR kind IN (SELECT value FROM json_each(?6)))";
const LEVELS = `SELECT level, SUM(starts) AS starts, SUM(wins) AS wins, SUM(fails) AS fails, SUM(quits) AS quits,
  SUM(draws) AS draws, SUM(abandons) AS abandons, SUM(prestiges) AS prestiges, SUM(first_starts) AS first_starts,
  -- Days rolled up before 0.2.1 have first_try_wins but no first_starts; leave them out of the ratio.
  SUM(CASE WHEN first_starts > 0 THEN first_try_wins ELSE 0 END) AS first_try_wins, SUM(duration_sum) AS duration_sum, SUM(duration_n) AS duration_n,
  SUM(stars_sum) AS stars_sum, SUM(stars_n) AS stars_n, SUM(moves_left_sum) AS moves_left_sum, SUM(moves_left_n) AS moves_left_n,
  SUM(time_sum) AS time_sum, SUM(time_n) AS time_n, ${SUMS(DH)}, ${SUMS(TH)}
  FROM play_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} AND ${KINDS}
  GROUP BY level ORDER BY CAST(level AS INTEGER), level`;
const TOP_EVENTS = `SELECT name, SUM(count) AS count FROM event_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
  AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} GROUP BY name ORDER BY count DESC, name LIMIT 10`;

/** DN retention over cohorts that installed in [from, to] and whose day N has finished. */
export function retention(cohorts: CohortRow[], f: Filters, from: string, to: string, n: number, today: string): number | null {
  let base = 0, back = 0;
  for (const c of cohorts) {
    if (c.first_day < from || c.first_day > to || addDays(c.first_day, n) >= today || !dims(f, c)) continue;
    const age = diffDays(c.first_day, c.day);
    if (age === 0) base += c.devices;
    if (age === n) back += c.devices;
  }
  return base ? back / base : null;
}

export async function overview(db: D1Database, project: string, f: Filters, today: string, kinds: string | null = null) {
  const isNew = f.who === "all" ? null : f.who === "new" ? 1 : 0;
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT day, version, platform, country, is_new, COUNT(*) AS players, SUM(sessions) AS sessions, SUM(playtime_ms) AS playtime
      FROM device_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 GROUP BY day, version, platform, country, is_new`)
      .bind(project, f.compare ? f.prevFrom : f.from, f.to),
    db.prepare(DISTINCT).bind(project, f.from, f.to, f.v, f.p, f.c, isNew),
    db.prepare(DISTINCT).bind(project, f.prevFrom, f.prevTo, f.v, f.p, f.c, isNew),
    db.prepare("SELECT first_day, day, version, platform, country, devices FROM cohort_days WHERE project_id = ?1 AND first_day BETWEEN ?2 AND ?3")
      .bind(project, f.compare ? f.prevFrom : f.from, f.to),
    db.prepare(TOP_EVENTS).bind(project, f.from, f.to, f.v, f.p),
    db.prepare(LEVELS).bind(project, f.from, f.to, f.v, f.p, kinds),
    db.prepare(`SELECT bucket, SUM(sessions) AS n FROM gap_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
      AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} GROUP BY bucket`).bind(project, f.from, f.to, f.v, f.p),
  ]);
  const activity = res[0].results as unknown as ActivityRow[];
  const cohorts = res[3].results as unknown as CohortRow[];
  const keep = activity.filter((r) => dims(f, r) && (isNew === null || r.is_new === isNew));

  const kpis = (from: string, to: string, distinct: number): Kpis => {
    const rows = keep.filter((r) => r.day >= from && r.day <= to);
    const s = (k: "players" | "sessions" | "playtime", only?: (r: ActivityRow) => boolean) =>
      rows.filter(only ?? (() => true)).reduce((t, r) => t + r[k], 0);
    const players = s("players"), sessions = s("sessions"), playtime = s("playtime");
    const dau = players / f.days;
    return {
      dau, newUsers: s("players", (r) => r.is_new === 1), sessions,
      sessionLength: sessions ? playtime / sessions : null,
      playtimePerUser: distinct ? playtime / distinct : null,
      stickiness: distinct ? dau / distinct : null,
      d1: retention(cohorts, f, from, to, 1, today),
      d7: retention(cohorts, f, from, to, 7, today),
    };
  };
  const n = (i: number) => (res[i].results[0]?.n as number) ?? 0;
  const days = Array.from({ length: f.days }, (_, i) => addDays(f.from, i));
  const byDay = (k: "players" | "sessions", isNewRow?: number) => days.map((d) =>
    keep.filter((r) => r.day === d && (isNewRow === undefined || r.is_new === isNewRow)).reduce((t, r) => t + r[k], 0));

  // Filter choices come from the same rows: versions newest first, the 20 countries with most players.
  const total = (key: "version" | "country") => {
    const m = new Map<string, number>();
    for (const r of activity) if (r[key]) m.set(r[key], (m.get(r[key]) ?? 0) + r.players);
    return m;
  };
  const versions = [...total("version").keys()].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const countries = [...total("country")].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c]) => c).sort();
  const platforms = [...new Set(["android", "ios", "webgl", "editor", ...activity.map((r) => r.platform).filter(Boolean)])];
  const levels = res[5].results as unknown as LevelRow[];

  return {
    rowsRead: rowsRead(res),
    current: kpis(f.from, f.to, n(1)),
    previous: f.compare ? kpis(f.prevFrom, f.prevTo, n(2)) : null,
    days, newByDay: byDay("players", 1), returningByDay: byDay("players", 0), sessionsByDay: byDay("sessions"),
    topEvents: res[4].results as unknown as { name: string; count: number }[],
    gaps: new Map(res[6].results.map((r) => [r.bucket as string, r.n as number])),
    sessionsPerPlayerDay: (() => {
      const rows = keep.filter((r) => r.day >= f.from && r.day <= f.to);
      const players = rows.reduce((t, r) => t + r.players, 0);
      return players ? rows.reduce((t, r) => t + r.sessions, 0) / players : null;
    })(),
    levels: levels.filter((l) => l.starts > 0).map((l) => ({ ...l, quitRate: l.quits / l.starts }))
      .sort((a, b) => b.quitRate - a.quitRate || b.starts - a.starts).slice(0, 5),
    options: { versions, countries, platforms },
  };
}

export async function cohortTable(db: D1Database, project: string, f: Filters, today: string) {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT first_day, day, version, platform, country, devices FROM cohort_days WHERE project_id = ?1 AND first_day BETWEEN ?2 AND ?3")
      .bind(project, f.from, f.to),
  ]);
  const cohorts = (res[0].results as unknown as CohortRow[]).filter((c) => dims(f, c));
  const rows = new Map<string, number[]>();
  for (const c of cohorts) {
    const age = diffDays(c.first_day, c.day);
    if (age > 30) continue;
    const r = rows.get(c.first_day) ?? Array(31).fill(0);
    r[age] += c.devices;
    rows.set(c.first_day, r);
  }
  return {
    rowsRead: rowsRead(res),
    // Newest cohort first. A day that has not finished yet is null.
    rows: [...rows].sort((a, b) => b[0].localeCompare(a[0])).map(([day, counts]) => ({
      day, size: counts[0], counts, cells: counts.map((v, n) => (addDays(day, n) >= today || !counts[0] ? null : v / counts[0])),
    })),
    summary: [1, 3, 7, 14, 30].map((n) => ({ n, rate: retention(cohorts, f, f.from, f.to, n, today) })),
  };
}

// Distinct players who started each play key of the kinds (?6), from what each device day saw: "kind\u001flevel",
// or a bare level from before 0.3.1, which counts under any kind.
const SEP = "instr(j.value, char(31))";
const LEVEL_PLAYERS = `SELECT CASE WHEN ${SEP} THEN substr(j.value, ${SEP} + 1) ELSE j.value END AS level, COUNT(DISTINCT dd.device_id) AS players
  FROM device_days dd, json_each(dd.seen, '$.l') j
  WHERE dd.project_id = ?1 AND dd.day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR dd.version = ?4) AND ${PLAT("?5", "dd.platform")}
    AND (?6 IS NULL OR ${SEP} = 0 OR substr(j.value, 1, ${SEP} - 1) IN (SELECT value FROM json_each(?6)))
  GROUP BY 1`;
const END = "name IN ('level_complete', 'level_fail', 'level_quit', 'play_end')";
const isMetric = (t: string) => `json_type(props, '$.${t}') IN ('integer', 'real')`;
// One row per level, device and attempt (session when no attempt), then summed per level, as the rollup counts.
// play_end is read through props.result, and level_* events as plays of kind level, as the rollup does.
const RESULT = (r: string, level: string) => `(name = '${level}' OR (name = 'play_end' AND json_extract(props, '$.result') = '${r}'))`;
const START = "name IN ('level_start', 'play_start')";
/** A completed play: its duration counts. */
const DONE = "(name IN ('level_complete', 'level_fail') OR (name = 'play_end' AND json_extract(props, '$.result') IN ('win', 'loss', 'draw', 'prestige')))";
const RAW_LEVELS = (where: string) => `SELECT lv AS level, SUM(s) AS starts, COUNT(DISTINCT CASE WHEN s > 0 THEN device_id END) AS players,
  SUM(w) AS wins, SUM(fl) AS fails, SUM(q + (s > 0 AND w + fl + q + dr + ab + pr = 0 AND ls < ?)) AS quits, SUM(dr) AS draws, SUM(ab) AS abandons,
  SUM(pr) AS prestiges,
  SUM(CASE WHEN a = 1 THEN s ELSE 0 END) AS first_starts, SUM(CASE WHEN a = 1 THEN w ELSE 0 END) AS first_try_wins,
  TOTAL(ds) AS duration_sum, SUM(dn) AS duration_n, TOTAL(ss) AS stars_sum, SUM(sn) AS stars_n, TOTAL(ms) AS moves_left_sum, SUM(mn) AS moves_left_n
  FROM (SELECT COALESCE(level, '(none)') AS lv, device_id, MAX(attempt) AS a, SUM(${START}) AS s, SUM(${RESULT("win", "level_complete")}) AS w,
    SUM(${RESULT("loss", "level_fail")}) AS fl, SUM(${RESULT("quit", "level_quit")}) AS q,
    SUM(${RESULT("draw", "-")}) AS dr, SUM(${RESULT("abandon", "-")}) AS ab, SUM(${RESULT("prestige", "-")}) AS pr, MAX(CASE WHEN ${START} THEN received_at END) AS ls,
    SUM(CASE WHEN ${DONE} THEN duration_ms END) AS ds, COUNT(CASE WHEN ${DONE} THEN duration_ms END) AS dn,
    SUM(CASE WHEN ${RESULT("win", "level_complete")} AND ${isMetric("stars")} THEN json_extract(props, '$.stars') END) AS ss,
    COUNT(CASE WHEN ${RESULT("win", "level_complete")} AND ${isMetric("stars")} THEN 1 END) AS sn,
    SUM(CASE WHEN ${RESULT("win", "level_complete")} AND ${isMetric("moves_left")} THEN json_extract(props, '$.moves_left') END) AS ms,
    COUNT(CASE WHEN ${RESULT("win", "level_complete")} AND ${isMetric("moves_left")} THEN 1 END) AS mn
    FROM events WHERE ${where} AND (${START} OR ${END})
      AND (?${"KINDS"} IS NULL OR COALESCE(json_extract(props, '$.kind'), CASE WHEN name LIKE 'level%' THEN 'level' ELSE 'play' END)
        IN (SELECT value FROM json_each(?${"KINDS"})))
    GROUP BY lv, device_id, COALESCE(attempt, session_id))
  GROUP BY lv ORDER BY CAST(lv AS INTEGER), lv`;

export interface Results { key: string; starts: number; wins: number; fails: number; quits: number; draws: number; abandons: number; dh: number[] }
export interface DimRow { value: string; plays: number; players: number; wins: number; losses: number; draws: number; score_sum: number; score_n: number }
const BY = (col: string) => `SELECT ${col} AS key, SUM(starts) AS starts, SUM(wins) AS wins, SUM(fails) AS fails, SUM(quits) AS quits,
  SUM(draws) AS draws, SUM(abandons) AS abandons, ${SUMS(DH)} FROM play_days
  WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} AND ${KINDS} AND ${col} <> ''
  GROUP BY ${col} ORDER BY starts DESC, ${col}`;
const DIM = `SELECT value, SUM(plays) AS plays, SUM(players) AS players, SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws,
  SUM(score_sum) AS score_sum, SUM(score_n) AS score_n FROM dim_days
  WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} AND ${KINDS} AND dim = ?7
  GROUP BY value ORDER BY plays DESC, value LIMIT 200`;

/**
 * All plays of the profile's kinds by play key, with distinct players, and results by mode, difficulty and opponent.
 * Raw filters read the events table instead of play_days, without the breakdowns.
 */
export async function levelTable(db: D1Database, project: string, f: Filters, tz: number, now: number, kinds: string | null = null) {
  if (f.raw) {
    const w = rawWhere(project, f, tz, false);
    const sql = RAW_LEVELS(w.sql).replaceAll("?KINDS", `?${w.binds.length + 2}`);
    const res = await db.batch<Record<string, unknown>>([db.prepare(sql).bind(now - QUIT_AFTER_MS, ...w.binds, kinds)]);
    const levels = res[0].results.map((l) => ({ ...l, time_sum: 0, time_n: 0, dh: [], th: [] })) as unknown as LevelRow[];
    return { rowsRead: rowsRead(res), levels, modes: [], difficulties: [], opponents: [] };
  }
  const b = [project, f.from, f.to, f.v, f.p, kinds];
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(LEVELS).bind(...b),
    db.prepare(LEVEL_PLAYERS).bind(...b),
    db.prepare(BY("mode")).bind(...b),
    db.prepare(BY("difficulty")).bind(...b),
    db.prepare(DIM).bind(...b, "opponent"),
  ]);
  const players = new Map(res[1].results.map((r) => [String(r.level), r.players as number]));
  const levels = res[0].results.map((l) => ({ ...l, players: players.get(String(l.level)) ?? 0, dh: hist(l, DH), th: hist(l, TH) })) as unknown as LevelRow[];
  const results = (i: number) => res[i].results.map((r) => ({ ...r, dh: hist(r, DH) })) as unknown as Results[];
  return {
    rowsRead: rowsRead(res), levels,
    modes: results(2), difficulties: results(3), opponents: res[4].results as unknown as DimRow[],
  };
}

/** One dimension's values with pick rate: plays with the value / all plays of the kinds (dim ""). */
export async function contentPage(db: D1Database, project: string, f: Filters, kinds: string | null, dim: string) {
  const b = [project, f.from, f.to, f.v, f.p, kinds];
  const res = await db.batch<Record<string, unknown>>([db.prepare(DIM).bind(...b, dim), db.prepare(DIM).bind(...b, "")]);
  return { rowsRead: rowsRead(res), values: res[0].results as unknown as DimRow[], plays: (res[1].results[0]?.plays as number) ?? 0 };
}

export interface TrackRow { track: string; bucket: string; devices: number; reached: number; reach_days: number }
export async function progressPage(db: D1Database, project: string, f: Filters) {
  const res = await db.batch<Record<string, unknown>>([db.prepare(`SELECT track, bucket, SUM(devices) AS devices, SUM(reached) AS reached,
    SUM(reach_days) AS reach_days FROM track_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4)
    AND ${PLAT("?5")} GROUP BY track, bucket`).bind(project, f.from, f.to, f.v, f.p)]);
  return { rowsRead: rowsRead(res), rows: res[0].results as unknown as TrackRow[] };
}

export interface StepRow { flow: string; step: number; devices: number; duration_sum: number; duration_n: number; skips: number }
export async function flowsPage(db: D1Database, project: string, f: Filters) {
  const res = await db.batch<Record<string, unknown>>([db.prepare(`SELECT flow, step, SUM(devices) AS devices, SUM(duration_sum) AS duration_sum,
    SUM(duration_n) AS duration_n, SUM(skips) AS skips FROM step_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4)
    AND ${PLAT("?5")} GROUP BY flow, step ORDER BY flow, step LIMIT 500`).bind(project, f.from, f.to, f.v, f.p)]);
  return { rowsRead: rowsRead(res), rows: res[0].results as unknown as StepRow[] };
}

/** Tracks, play props keys and flows the rollup saw in the last 7 days (since day), for the Settings form. One row. */
export async function seenKeys(db: D1Database, project: string, since: string) {
  const res = await db.batch<Record<string, unknown>>([db.prepare("SELECT seen_keys FROM projects WHERE id = ?").bind(project)]);
  const s: SeenKeys = res[0].results[0]?.seen_keys ? JSON.parse(res[0].results[0].seen_keys as string) : { t: {}, k: {}, f: {} };
  const recent = (m: Record<string, string>) => Object.keys(m).filter((k) => m[k] >= since).sort();
  return {
    rowsRead: rowsRead(res), tracks: recent(s.t), flows: recent(s.f),
    keys: Object.entries(s.k).filter(([, e]) => e.d >= since).map(([key, e]) => ({ key, values: e.v.length })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** One play key by day and by version from play_days, with its fail and quit reasons, boosters and continues. */
export async function levelDetail(db: D1Database, project: string, f: Filters, level: string, kinds: string | null = null) {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT day, version, SUM(starts) AS starts, SUM(wins) AS wins, SUM(fails) AS fails, SUM(quits) AS quits FROM play_days
      WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND level = ?7 AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")} AND ${KINDS}
      GROUP BY day, version`).bind(project, f.from, f.to, f.v, f.p, kinds, level),
    db.prepare(`SELECT name, detail, SUM(count) AS count FROM level_events
      WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND level = ?4 AND (?5 IS NULL OR version = ?5) AND ${PLAT("?6")}
      GROUP BY name, detail ORDER BY count DESC, name, detail LIMIT 30`).bind(project, f.from, f.to, level, f.v, f.p),
  ]);
  type Counts = { starts: number; wins: number; fails: number; quits: number };
  const rows = res[0].results as unknown as (Counts & { day: string; version: string })[];
  const group = (key: "day" | "version") => {
    const m = new Map<string, Counts>();
    for (const r of rows) {
      const g = m.get(r[key]) ?? { starts: 0, wins: 0, fails: 0, quits: 0 };
      for (const k of ["starts", "wins", "fails", "quits"] as const) g[k] += r[k];
      m.set(r[key], g);
    }
    return [...m].map(([key, c]) => ({ key, ...c }));
  };
  return {
    rowsRead: rowsRead(res),
    byDay: group("day").sort((a, b) => b.key.localeCompare(a.key)),
    byVersion: group("version").sort((a, b) => b.key.localeCompare(a.key, "en", { numeric: true })),
    events: res[1].results as unknown as { name: string; detail: string; count: number }[],
  };
}

export interface TailRow {
  client_ts: number; name: string; level: string | null; attempt: number | null; duration_ms: number | null;
  device_id: string; app_version: string | null; platform: string | null; props: string | null;
}
const TAIL = "SELECT client_ts, name, level, attempt, duration_ms, device_id, app_version, platform, props FROM events";

/**
 * Events over time and the newest raw events. The chart reads event_days unless a raw filter or a breakdown is set.
 * The tail is the 100 newest matching rows: any date when nothing filters it, else in the range.
 */
export async function eventsPage(db: D1Database, project: string, f: Filters, tz: number) {
  const w = rawWhere(project, f, tz);
  // An event filter alone reads rollups for the chart; its raw tail still keeps to the last RAW_MAX_DAYS days.
  const tw = f.raw ? w : rawWhere(project, { ...f, from: f.days > RAW_MAX_DAYS ? addDays(f.to, -(RAW_MAX_DAYS - 1)) : f.from }, tz);
  const conds = ["project_id = ?", "day BETWEEN ? AND ?"], binds: unknown[] = [project, f.from, f.to];
  if (f.v) { conds.push("version = ?"); binds.push(f.v); }
  if (f.p) { conds.push(PLAT("?")); binds.push(f.p, f.p, f.p, f.p); }
  if (f.events.length) { conds.push(`name IN (${f.events.map(() => "?").join(", ")})`); binds.push(...f.events); }
  const filtered = f.raw || f.events.length > 0;
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(TOP_EVENTS).bind(project, f.from, f.to, f.v, f.p),
    f.raw
      ? db.prepare(`SELECT strftime('%Y-%m-%d', (received_at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM events WHERE ${w.sql} GROUP BY day`)
        .bind(tz * 60_000, ...w.binds)
      : db.prepare(`SELECT day, SUM(count) AS n FROM event_days WHERE ${conds.join(" AND ")} GROUP BY day`).bind(...binds),
    filtered
      ? db.prepare(`${TAIL} WHERE ${tw.sql} ORDER BY received_at DESC LIMIT 100`).bind(...tw.binds)
      : db.prepare(`${TAIL} WHERE project_id = ? ORDER BY received_at DESC LIMIT 100`).bind(project),
    ...(f.by ? [db.prepare(`SELECT CAST(json_extract(props, ?) AS TEXT) AS prop, COUNT(*) AS n FROM events WHERE ${w.sql}
      GROUP BY prop ORDER BY n DESC, prop LIMIT 20`).bind(`$.${f.by}`, ...w.binds)] : []),
  ]);
  const perDay = new Map(res[1].results.map((r) => [String(r.day), r.n as number]));
  const days = Array.from({ length: f.days }, (_, i) => addDays(f.from, i));
  return {
    rowsRead: rowsRead(res),
    topEvents: res[0].results as unknown as { name: string; count: number }[],
    days, counts: days.map((d) => perDay.get(d) ?? 0),
    tail: res[2].results as unknown as TailRow[], filtered,
    breakdown: f.by ? res[3].results as unknown as { prop: string | null; n: number }[] : null,
  };
}

/** One device: its install, its days in the range and its raw events newest first. */
export async function devicePage(db: D1Database, project: string, f: Filters, tz: number, device: string) {
  const days = Array.from({ length: f.days }, (_, i) => addDays(f.from, i));
  // Version, platform and country do not filter this page: device_days rows carry them per day, not per event.
  const w = rawWhere(project, { ...f, device, v: null, p: null, c: null, events: [], props: [] }, tz);
  const res = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT first_day, version, platform, country FROM devices WHERE project_id = ? AND device_id = ?").bind(project, device),
    // One primary key lookup per day; this page has at most RAW_MAX_DAYS days.
    db.prepare(`SELECT day, sessions, playtime_ms, events, seen FROM device_days WHERE project_id = ? AND device_id = ?
      AND day IN (${days.map(() => "?").join(", ")}) ORDER BY day DESC`).bind(project, device, ...days),
    // shortcut: no device index, so this scans the range's raw rows by arrival; add (project_id, device_id, received_at) if it gets slow.
    db.prepare(`${TAIL} WHERE ${w.sql} ORDER BY received_at DESC LIMIT 200`).bind(...w.binds),
  ]);
  return {
    rowsRead: rowsRead(res),
    device: (res[0].results[0] ?? null) as { first_day: string; version: string; platform: string; country: string } | null,
    days: res[1].results.map((r) => {
      const levels = (JSON.parse(r.seen as string).l as string[]).map((l) => Number(l.split("\u001f").at(-1))).filter(Number.isFinite);
      return { day: r.day as string, sessions: r.sessions as number, playtime: r.playtime_ms as number, events: r.events as number,
        level: levels.length ? Math.max(...levels) : null };
    }),
    timeline: res[2].results as unknown as TailRow[],
  };
}

const USE = new Set(["booster_used", "booster_bought", "try_taken"]);
const OFFER = new Set(["booster_offered", "try_offer_shown"]);
const AD_SHOWN = new Set(["ad_shown", "interstitial_shown", "continue_watched"]);
interface EconRow { day: string; name: string; currency: string; detail: string; n: number; v: number; ds: number }

/** Economy and ads from econ_days: currency flows, boosters, ads by format and revenue with ARPDAU. */
export async function economy(db: D1Database, project: string, f: Filters) {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT day, name, currency, detail, SUM(count) AS n, SUM(value_sum) AS v, SUM(duration_sum) AS ds FROM econ_days
      WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")}
      GROUP BY day, name, currency, detail`).bind(project, f.from, f.to, f.v, f.p),
    db.prepare(`SELECT COUNT(*) AS n FROM device_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
      AND (?4 IS NULL OR version = ?4) AND ${PLAT("?5")}`).bind(project, f.from, f.to, f.v, f.p),
  ]);
  const rows = res[0].results as unknown as EconRow[];
  const days = Array.from({ length: f.days }, (_, i) => addDays(f.from, i));
  const bump = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  const currencies = new Map<string, { earned: number; spent: number; earnedByDay: Map<string, number>; spentByDay: Map<string, number>; sources: Map<string, number>; sinks: Map<string, number> }>();
  const boosters = new Map<string, { used: number; offered: number }>();
  const ads = new Map<string, { shown: number; revenue: number; byDay: Map<string, number> }>();
  const revenue = new Map<string, { ads: number; iap: number }>();
  const offline = new Map<string, { rewards: number; value: number; ms: number; ad: number }>();
  for (const r of rows) {
    if (r.name === "offline_reward") {
      const o = offline.get(r.currency) ?? { rewards: 0, value: 0, ms: 0, ad: 0 };
      o.rewards += r.n; o.value += r.v; o.ms += r.ds;
      if (r.detail === "ad") o.ad += r.n;
      offline.set(r.currency, o);
    }
    if (r.name === "currency_earned" || r.name === "currency_spent") {
      const c = currencies.get(r.currency) ?? { earned: 0, spent: 0, earnedByDay: new Map(), spentByDay: new Map(), sources: new Map(), sinks: new Map() };
      const earned = r.name === "currency_earned";
      if (earned) { c.earned += r.v; bump(c.earnedByDay, r.day, r.v); bump(c.sources, r.detail, r.v); }
      else { c.spent += r.v; bump(c.spentByDay, r.day, r.v); bump(c.sinks, r.detail, r.v); }
      currencies.set(r.currency, c);
    } else if (USE.has(r.name) || OFFER.has(r.name)) {
      const b = boosters.get(r.detail) ?? { used: 0, offered: 0 };
      if (USE.has(r.name)) b.used += r.n; else b.offered += r.n;
      boosters.set(r.detail, b);
    } else if (AD_SHOWN.has(r.name)) {
      const a = ads.get(r.detail) ?? { shown: 0, revenue: 0, byDay: new Map() };
      a.shown += r.n; a.revenue += r.v; bump(a.byDay, r.day, r.n);
      ads.set(r.detail, a);
      if (r.v) { const m = revenue.get(r.currency) ?? { ads: 0, iap: 0 }; m.ads += r.v; revenue.set(r.currency, m); }
    } else if (r.name === "iap_purchase" && r.v) {
      const m = revenue.get(r.currency) ?? { ads: 0, iap: 0 };
      m.iap += r.v;
      revenue.set(r.currency, m);
    }
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label: label || "(not set)", value }));
  const deviceDays = (res[1].results[0]?.n as number) ?? 0;
  return {
    rowsRead: rowsRead(res), days,
    currencies: [...currencies].sort((a, b) => b[1].earned - a[1].earned).map(([currency, c]) => ({
      currency, earned: c.earned, spent: c.spent, sources: top(c.sources), sinks: top(c.sinks),
      earnedByDay: days.map((d) => c.earnedByDay.get(d) ?? 0), spentByDay: days.map((d) => c.spentByDay.get(d) ?? 0),
    })),
    boosters: [...boosters].sort((a, b) => b[1].used - a[1].used || b[1].offered - a[1].offered).map(([booster, b]) => ({ booster, ...b })),
    ads: [...ads].sort((a, b) => b[1].shown - a[1].shown).map(([format, a]) => ({
      format, shown: a.shown, revenue: a.revenue, byDay: days.map((d) => a.byDay.get(d) ?? 0),
    })),
    // Offline share: offline reward value / (offline reward value + currency_earned value), per currency.
    offline: [...offline].sort((a, b) => b[1].value - a[1].value).map(([currency, o]) => {
      const earned = currencies.get(currency)?.earned ?? 0;
      return { currency, rewards: o.rewards, value: o.value, share: o.value / (o.value + earned || 1), avgMs: o.ms / o.rewards, adShare: o.ad / o.rewards };
    }),
    revenue: [...revenue].map(([currency, m]) => ({ currency, ...m, total: m.ads + m.iap, arpdau: deviceDays ? (m.ads + m.iap) / deviceDays : null })),
    deviceDays,
  };
}

export const LIVE_MS = 30 * 60_000;
/** Raw rows that arrived in the last 30 minutes: the index on arrival time bounds the read. */
export async function live(db: D1Database, project: string, now: number) {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT COUNT(*) AS events, COUNT(DISTINCT device_id) AS devices FROM events WHERE project_id = ? AND received_at >= ?").bind(project, now - LIVE_MS),
    db.prepare(`${TAIL} WHERE project_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 50`).bind(project, now - LIVE_MS),
  ]);
  return {
    rowsRead: rowsRead(res),
    events: (res[0].results[0]?.events as number) ?? 0, devices: (res[0].results[0]?.devices as number) ?? 0,
    tail: res[1].results as unknown as TailRow[],
  };
}

/** Today's accepted events per project (UTC day, as the cap) and the database size. */
export async function usageToday(db: D1Database, day: string, projects: string[]) {
  const res = await db.batch<Record<string, unknown>>([db.prepare(
    "SELECT project_id, events FROM usage WHERE project_id IN (SELECT value FROM json_each(?1)) AND day = ?2",
  ).bind(JSON.stringify(projects.flatMap((p) => [p, `${p}~test`])), day)]);
  return {
    rowsRead: rowsRead(res),
    events: new Map(res[0].results.map((r) => [r.project_id as string, r.events as number])),
    bytes: (res[0].meta as { size_after?: number }).size_after ?? null,
  };
}
