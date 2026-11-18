// Dashboard reads. Every page reads rollup tables only, except the raw tail on the Events page.
import { DAY } from "./rollup";

export interface Filters {
  range: string; from: string; to: string; prevFrom: string; prevTo: string; days: number; compare: boolean;
  v: string | null; p: string | null; c: string | null; who: "all" | "new" | "returning";
}
export const RANGES: Record<string, string> = { today: "Today", "7": "Last 7 days", "14": "Last 14 days", "30": "Last 30 days", "90": "Last 90 days" };
const MAX_DAYS = 366;

export const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
  && new Date(Date.parse(s)).toISOString().startsWith(s);
const opt = (s: string | null) => (s && s.length <= 64 ? s : null);

/** Reads the filter bar from the query string. from = to is one day. */
export function parseFilters(q: URLSearchParams, today: string): Filters {
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
  const days = diffDays(from, to) + 1;
  const who = q.get("who");
  return {
    range, from, to, days, prevTo: addDays(from, -1), prevFrom: addDays(from, -days), compare: q.get("cmp") !== "off",
    v: opt(q.get("v")), p: opt(q.get("p")), c: opt(q.get("c")), who: who === "new" || who === "returning" ? who : "all",
  };
}

interface ActivityRow { day: string; version: string; platform: string; country: string; is_new: number; players: number; sessions: number; playtime: number }
interface CohortRow { first_day: string; day: string; version: string; platform: string; country: string; devices: number }
export interface Kpis { dau: number; newUsers: number; sessions: number; sessionLength: number | null; playtimePerUser: number | null; d1: number | null; d7: number | null; stickiness: number | null }
export interface LevelRow { level: string; starts: number; wins: number; fails: number; quits: number; duration_sum: number; duration_n: number }

/** Sum of D1 rows read by a set of results, for the X-D1-Rows-Read header. */
export const rowsRead = (results: D1Result[]) => results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0);

const dims = (f: Filters, r: { version: string; platform: string; country: string }) =>
  (!f.v || r.version === f.v) && (!f.p || r.platform === f.p) && (!f.c || r.country === f.c);
const DISTINCT = `SELECT COUNT(DISTINCT device_id) AS n FROM device_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
  AND (?4 IS NULL OR version = ?4) AND (?5 IS NULL OR platform = ?5) AND (?6 IS NULL OR country = ?6) AND (?7 IS NULL OR is_new = ?7)`;
const LEVELS = `SELECT level, SUM(starts) AS starts, SUM(wins) AS wins, SUM(fails) AS fails, SUM(quits) AS quits,
  SUM(duration_sum) AS duration_sum, SUM(duration_n) AS duration_n
  FROM level_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR version = ?4) AND (?5 IS NULL OR platform = ?5)
  GROUP BY level ORDER BY CAST(level AS INTEGER), level`;
const TOP_EVENTS = `SELECT name, SUM(count) AS count FROM event_days WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3
  AND (?4 IS NULL OR version = ?4) AND (?5 IS NULL OR platform = ?5) GROUP BY name ORDER BY count DESC, name LIMIT 10`;

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

export async function overview(db: D1Database, project: string, f: Filters, today: string) {
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
    db.prepare(LEVELS).bind(project, f.from, f.to, f.v, f.p),
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

export async function levelTable(db: D1Database, project: string, f: Filters) {
  const res = await db.batch<Record<string, unknown>>([db.prepare(LEVELS).bind(project, f.from, f.to, f.v, f.p)]);
  return { rowsRead: rowsRead(res), levels: res[0].results as unknown as LevelRow[] };
}

export interface TailRow { client_ts: number; name: string; level: string | null; attempt: number | null; duration_ms: number | null; device_id: string; platform: string | null; props: string | null }

/** The only raw read: the newest events by arrival, on the Events page. */
export async function eventsPage(db: D1Database, project: string, f: Filters) {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(TOP_EVENTS).bind(project, f.from, f.to, f.v, f.p),
    db.prepare(`SELECT client_ts, name, level, attempt, duration_ms, device_id, platform, props
      FROM events WHERE project_id = ? ORDER BY received_at DESC LIMIT 50`).bind(project),
  ]);
  return {
    rowsRead: rowsRead(res),
    topEvents: res[0].results as unknown as { name: string; count: number }[],
    tail: res[1].results as unknown as TailRow[],
  };
}
