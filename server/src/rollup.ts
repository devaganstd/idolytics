import { detect, effectiveProfile, type Profile } from "./profile";

// Incremental daily rollups (docs/08-dashboard-v0.2.md section 5). A cron reads the raw rows
// received since the project's watermark, merges them into device and day state in memory,
// and writes each rollup table with one statement.

export const DAY = 86_400_000;
/** A start with no result is a quit only once it is this old, so a level in play is not counted. */
export const QUIT_AFTER_MS = 30 * 60_000;
export const RAW_KEEP_DAYS = 90;
/** Rows received in the last minute may still be in flight in an ingest request. */
const LAG_MS = 60_000;
// Small enough to stay well inside the free plan CPU limit; a backlog drains over several runs.
const CHUNK = 1000;
/** An aged start stays in devices.open this long, so a late result can undo its quit. */
const KEEP_AGED_MS = 2 * DAY;
const DELETE_CHUNK = 5000;
/** level_* events are plays of kind level (docs/09-game-profiles.md section 4). */
const LEVEL_RESULT: Record<string, string> = { level_complete: "win", level_fail: "loss", level_quit: "quit" };
const RESULT_FIELD: Record<string, string> = { win: "wins", loss: "fails", quit: "quits", draw: "draws", abandon: "abandons" };
/** level_events names for play_end results, so the level detail page reads both the same way. */
const RESULT_EVENT: Record<string, string> = { loss: "level_fail", quit: "level_quit" };
/** A tutorial_complete is this step of the flow "tutorial". */
export const STEP_DONE = 999;
const DIM_VALUES = 200;
/** A props value as a short key, or "" when it is missing or not a scalar. */
const text = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).slice(0, 40) : "";
/** Ninja Smash ad events, counted with this ad format. */
const AD_ALIAS: Record<string, string> = { interstitial_shown: "interstitial", continue_watched: "rewarded" };
const ECON_NAMES = ["iap_purchase", "try_taken", "try_offer_shown", ...Object.keys(AD_ALIAS)];
const isEcon = (name: string) => /^(currency|booster|ad)_/.test(name) || ECON_NAMES.includes(name);
/** First scalar props value of these keys, at most 40 characters, else "". */
const detailOf = (props: Record<string, unknown>, keys: string[]) => text(keys.map((k) => props[k]).find((v) => v !== undefined));
/** The props key that names what an economy event is about: the booster, the ad format, the source or sink. */
const econKeys = (name: string) => name.startsWith("booster_") ? ["booster"] : name.startsWith("try_") ? ["booster", "mode"] : name.startsWith("ad_") ? ["format"]
  : name === "iap_purchase" ? ["product"] : name === "currency_spent" ? ["sink"] : ["source", "sink"];
/** The free plan allows 50 D1 queries per invocation; keep a margin. */
const QUERY_BUDGET = 48;
/** The most queries one project can take in a run without a rebuild: the raw select, three reads and twelve writes. */
const WORST_PROJECT = 16;
/** Statements in startRebuild's batch. */
const REBUILD_QUERIES = 12;

/** Local calendar day of an epoch ms time, for a fixed offset in minutes east of UTC. */
export const dayOf = (ts: number, tzMin: number) => new Date(ts + tzMin * 60_000).toISOString().slice(0, 10);

export interface Project {
  id: string; tz_min: number; rollup_tz: number; wm_at: number; wm_id: string;
  rebuild_from: number | null; rebuild_until: number | null;
  profile?: string | null; profile_detected?: string | null; dim_values?: string | null;
}
interface Raw {
  event_id: string; name: string; device_id: string; session_id: string; client_ts: number; received_at: number;
  app_version: string | null; platform: string | null; country: string | null; level: string | null;
  attempt: number | null; duration_ms: number | null; value: number | null; currency: string | null; props: string | null;
}
/** An unclosed play start: received at, day, version, platform, level, kind, mode, difficulty, counted as a quit. */
interface Open { r: number; d: string; v: string; p: string; l: string; k?: string; m?: string; f?: string; q?: 1 }
interface Dev {
  first_day: string; version: string; platform: string; country: string; open: Record<string, Open>; tracks: Record<string, string>;
  dirty: boolean; isNew: boolean;
}
/** Per device day: session spans, event names, play keys, track highs, dimension values and flow steps seen. */
interface Seen { s: Record<string, [number, number]>; n: string[]; l: string[]; t?: Record<string, number>; d?: string[]; f?: string[] }
interface DevDay { version: string; platform: string; country: string; is_new: number; events: number; seen: Seen; dirty: boolean }

/**
 * Rolls up the projects that have work: new raw rows, a rebuild, or a level start old enough to become a quit.
 * Idle projects cost nothing but a shared raw retention delete. Busy projects run least recently rolled up
 * first, as many as fit in the query budget; the rest go first in the next run.
 */
export async function runCron(db: D1Database, now: number) {
  const hi = now - LAG_MS;
  const { results } = await db.prepare(
    `SELECT id, tz_min, rollup_tz, wm_at, wm_id, rebuild_from, rebuild_until, profile, profile_detected, dim_values,
       tz_min <> rollup_tz OR rebuild_until IS NOT NULL
       OR EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.id AND (e.received_at, e.event_id) > (p.wm_at, p.wm_id) AND e.received_at <= ?1)
       OR EXISTS (SELECT 1 FROM devices d WHERE d.project_id = p.id AND d.open_min < ?2) AS busy
     FROM projects p ORDER BY cron_at, created_at, id`,
  ).bind(hi, hi - QUIT_AFTER_MS).all<Project & { busy: number }>();
  const idle = results.filter((p) => !p.busy).map((p) => p.id);
  const done = [...idle];
  const cost = { queries: 3 }; // the list above, then the retention delete and cron_at update below
  for (const p of results.filter((r) => r.busy)) {
    if (cost.queries + WORST_PROJECT + (p.tz_min !== p.rollup_tz ? REBUILD_QUERIES : 0) > QUERY_BUDGET) break;
    await rollupProject(db, p, now, CHUNK, cost);
    done.push(p.id);
  }
  await db.batch([
    // Raw retention for idle projects: all their rows are rolled up. Busy projects delete their own.
    db.prepare(`DELETE FROM events WHERE project_id IN (SELECT value FROM json_each(?1)) AND event_id IN
      (SELECT event_id FROM events WHERE project_id IN (SELECT value FROM json_each(?1)) AND received_at < ?2 LIMIT ${DELETE_CHUNK})`)
      .bind(JSON.stringify(idle), now - RAW_KEEP_DAYS * DAY),
    db.prepare("UPDATE projects SET cron_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(done), now),
  ]);
  return { projects: done.length, of: results.length };
}

/** Rolls up one chunk of new raw rows and ages out quits. Returns the number of raw rows read. */
export async function rollupProject(db: D1Database, project: Project, now: number, chunk = CHUNK, cost = { queries: 0 }): Promise<number> {
  if (project.tz_min !== project.rollup_tz) cost.queries += REBUILD_QUERIES;
  const p = project.tz_min === project.rollup_tz ? project : await startRebuild(db, project, now);
  cost.queries += 4; // the raw select and three reads
  const tz = p.tz_min;
  const hi = now - LAG_MS;
  const rows = (await db.prepare(
    `SELECT event_id, name, device_id, session_id, client_ts, received_at, app_version, platform, country, level,
       attempt, duration_ms, value, currency, props
     FROM events WHERE project_id = ?1 AND (received_at, event_id) > (?2, ?3) AND received_at <= ?4
     ORDER BY received_at, event_id LIMIT ?5`,
  ).bind(p.id, p.wm_at, p.wm_id, hi, chunk).all<Raw>()).results;
  const last = rows.at(-1);
  const caughtUp = rows.length < chunk;
  // Rows up to here are rolled up; a start received 30 minutes before it with no result is a quit.
  const aged = (caughtUp ? hi : last!.received_at) - QUIT_AFTER_MS;
  const live = p.rebuild_until === null ? rows
    : rows.filter((r) => !(r.received_at <= p.rebuild_until! && r.client_ts < p.rebuild_from!));

  const ids = [...new Set(live.map((r) => r.device_id))];
  const days = live.map((r) => dayOf(r.client_ts, tz)).sort();
  const [known, agedDevs, knownDays] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT device_id, first_day, version, platform, country, open, tracks FROM devices WHERE project_id = ?1 AND device_id IN (SELECT value FROM json_each(?2))")
      .bind(p.id, JSON.stringify(ids)),
    db.prepare("SELECT device_id, first_day, version, platform, country, open, tracks FROM devices WHERE project_id = ?1 AND open_min < ?2")
      .bind(p.id, aged),
    db.prepare(`SELECT day, device_id, version, platform, country, is_new, events, seen FROM device_days
      WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND device_id IN (SELECT value FROM json_each(?4))`)
      .bind(p.id, days[0] ?? "", days.at(-1) ?? "", JSON.stringify(ids)),
  ]);

  const devs = new Map<string, Dev>();
  for (const d of [...known.results, ...agedDevs.results]) {
    devs.set(d.device_id as string, {
      first_day: d.first_day as string, version: d.version as string, platform: d.platform as string, country: d.country as string,
      open: d.open ? JSON.parse(d.open as string) : {}, tracks: d.tracks ? JSON.parse(d.tracks as string) : {}, dirty: false, isNew: false,
    });
  }
  // A new install's first values are those of its earliest event in this chunk.
  for (const r of [...live].sort((a, b) => a.client_ts - b.client_ts)) {
    if (!devs.has(r.device_id)) {
      devs.set(r.device_id, {
        first_day: dayOf(r.client_ts, tz), version: r.app_version ?? "", platform: r.platform ?? "", country: r.country ?? "",
        open: {}, tracks: {}, dirty: true, isNew: true,
      });
    }
  }
  const dds = new Map<string, DevDay>();
  for (const d of knownDays.results) {
    dds.set(JSON.stringify([d.day, d.device_id]), {
      version: d.version as string, platform: d.platform as string, country: d.country as string, is_new: d.is_new as number,
      events: d.events as number, seen: JSON.parse(d.seen as string), dirty: false,
    });
  }

  const parsed = new Map(live.map((r) => [r, r.props ? JSON.parse(r.props) as Record<string, unknown> : {}]));
  const detected = p.profile_detected ?? (p.profile ? null : detect(live.map((r) => ({ name: r.name, props: parsed.get(r)! }))));
  const profile: Profile | null = effectiveProfile(p.profile, detected);
  const dimValues: Record<string, string[]> = p.dim_values ? JSON.parse(p.dim_values) : {};
  /** A dimension value, or "other" once the dimension has DIM_VALUES values. */
  const capped = (dim: string, value: string) => {
    const known = dimValues[dim] ??= [];
    if (known.includes(value)) return value;
    if (known.length >= DIM_VALUES) return "other";
    known.push(value);
    return value;
  };
  const levels = new Map<string, Record<string, number>>();
  const dims = new Map<string, Record<string, number>>();
  const tracks = new Map<string, Record<string, number>>();
  const steps = new Map<string, Record<string, number>>();
  const events = new Map<string, Record<string, number>>();
  const cohorts = new Map<string, Record<string, number>>();
  const levelEvents = new Map<string, Record<string, number>>();
  const econ = new Map<string, Record<string, number>>();
  const add = (m: Map<string, Record<string, number>>, key: unknown[], field: string, n: number) => {
    const k = JSON.stringify(key);
    const o = m.get(k) ?? {};
    o[field] = (o[field] ?? 0) + n;
    m.set(k, o);
  };

  for (const r of live) {
    const day = dayOf(r.client_ts, tz), v = r.app_version ?? "", pl = r.platform ?? "";
    const dev = devs.get(r.device_id)!;
    const ddKey = JSON.stringify([day, r.device_id]);
    let dd = dds.get(ddKey);
    if (!dd) {
      dd = { version: v, platform: pl, country: r.country ?? "", is_new: day === dev.first_day ? 1 : 0, events: 0, seen: { s: {}, n: [], l: [] }, dirty: true };
      dds.set(ddKey, dd);
      // A device whose late events predate its first day stays out of the cohort table.
      if (day >= dev.first_day) add(cohorts, [dev.first_day, day, dev.version, dev.platform, dev.country], "devices", 1);
    }
    dd.dirty = true;
    dd.events++;
    const span = dd.seen.s[r.session_id];
    dd.seen.s[r.session_id] = span ? [Math.min(span[0], r.client_ts), Math.max(span[1], r.client_ts)] : [r.client_ts, r.client_ts];
    const ek = [day, r.name, v, pl];
    add(events, ek, "count", 1);
    if (r.value !== null) add(events, ek, "value_sum", r.value);
    if (!dd.seen.n.includes(r.name)) { dd.seen.n.push(r.name); add(events, ek, "devices", 1); }

    const props = parsed.get(r)!;
    if (isEcon(r.name)) {
      const k = [day, r.name, r.currency ?? "", AD_ALIAS[r.name] ?? detailOf(props, econKeys(r.name)), v, pl];
      add(econ, k, "count", 1);
      add(econ, k, "value_sum", r.value ?? 0);
    }
    // Flow steps; tutorial_* events are the flow "tutorial".
    const [flow, step] = r.name === "step" ? [text(props.flow), Number(props.step)] : r.name === "tutorial_begin" ? ["tutorial", 0]
      : r.name === "tutorial_step" ? ["tutorial", Number(props.step)] : r.name === "tutorial_complete" ? ["tutorial", STEP_DONE] : ["", NaN] as [string, number];
    if (flow && Number.isInteger(step) && step >= 0 && step <= STEP_DONE) {
      const sk = [day, flow, step, v, pl];
      const seenStep = JSON.stringify([flow, step]);
      if (!(dd.seen.f ??= []).includes(seenStep)) { dd.seen.f.push(seenStep); add(steps, sk, "devices", 1); }
      if (r.duration_ms !== null) { add(steps, sk, "duration_sum", r.duration_ms); add(steps, sk, "duration_n", 1); }
    }
    // Progression tracks declared with milestones.
    const track = r.name === "progress" ? profile?.tracks.find((t) => t.key === props.track && t.milestones.length) : undefined;
    const x = r.value ?? Number(props.value);
    if (track && Number.isFinite(x)) {
      const ms = track.milestones;
      const bucket = (n: number) => { const m = ms.filter((m) => m <= n).at(-1); return m === undefined ? `<${ms[0]}` : String(m); };
      const tk = (b: string) => [day, track.key, b, dd!.version, dd!.platform];
      const high = (dd.seen.t ??= {})[track.key];
      if (high === undefined) add(tracks, tk(bucket(x)), "devices", 1);
      else if (x > high && bucket(x) !== bucket(high)) { add(tracks, tk(bucket(high)), "devices", -1); add(tracks, tk(bucket(x)), "devices", 1); }
      if (high === undefined || x > high) dd.seen.t[track.key] = x;
      // dev.tracks maps "track:milestone" to the day it was reached, so a rebuild can drop the replayed days only.
      const age = Math.max(0, Math.round((Date.parse(day) - Date.parse(dev.first_day)) / DAY));
      for (const m of ms) {
        const rk = `${track.key}:${m}`;
        if (x < m || Object.hasOwn(dev.tracks, rk)) continue;
        add(tracks, tk(String(m)), "reached", 1);
        add(tracks, tk(String(m)), "reach_days", age);
        dev.tracks[rk] = day;
        dev.dirty = true;
      }
    }

    if (r.level === null) continue;
    const isStart = r.name === "level_start" || r.name === "play_start";
    const isEnd = r.name === "play_end" || Object.hasOwn(LEVEL_RESULT, r.name);
    const result = r.name === "play_end" ? text(props.result) : (Object.hasOwn(LEVEL_RESULT, r.name) ? LEVEL_RESULT[r.name] : "");
    if (!isStart && result !== "win") {
      const name = r.name === "play_end" ? (Object.hasOwn(RESULT_EVENT, result) ? RESULT_EVENT[result] : `play_${result || "end"}`) : r.name;
      add(levelEvents, [day, r.level, name, detailOf(props, ["reason", "via", "booster"]), v, pl], "count", 1);
    }
    if (!isStart && !isEnd) continue;
    const kind = text(props.kind) || (r.name.startsWith("level_") ? "level" : "play");
    const mode = text(props.mode) && capped("mode", text(props.mode)), difficulty = text(props.difficulty) && capped("difficulty", text(props.difficulty));
    const lk = [day, kind, r.level, mode, difficulty, v, pl];
    // By attempt, not session, so a play resumed after a restart still closes; session only when attempt is missing.
    const ok = JSON.stringify([r.level, r.attempt ?? "s:" + r.session_id]);
    if (isStart) {
      add(levels, lk, "starts", 1);
      if (r.attempt === 1) add(levels, lk, "first_starts", 1);
      if (!dd.seen.l.includes(r.level)) { dd.seen.l.push(r.level); add(levels, lk, "players", 1); }
      dev.open[ok] = { r: r.received_at, d: day, v, p: pl, l: r.level, k: kind, m: mode, f: difficulty };
      dev.dirty = true;
      continue;
    }
    const field = Object.hasOwn(RESULT_FIELD, result) ? RESULT_FIELD[result] : undefined;
    if (field) add(levels, lk, field, 1);
    if (field === "wins" && r.attempt === 1) add(levels, lk, "first_try_wins", 1);
    if (r.duration_ms !== null) { add(levels, lk, "duration_sum", r.duration_ms); add(levels, lk, "duration_n", 1); }
    if (field === "wins" && typeof props.stars === "number") { add(levels, lk, "stars_sum", props.stars); add(levels, lk, "stars_n", 1); }
    if (field === "wins" && typeof props.moves_left === "number") { add(levels, lk, "moves_left_sum", props.moves_left); add(levels, lk, "moves_left_n", 1); }
    const o = dev.open[ok];
    if (o) {
      // The start was already counted as a quit; the late result takes it back.
      if (o.q) add(levels, [o.d, o.k ?? "level", o.l, o.m ?? "", o.f ?? "", o.v, o.p], "quits", -1);
      delete dev.open[ok];
      dev.dirty = true;
    }
    // Dimensions: each ended play once per value, and once under dim "" for the kind's total.
    if (!profile) continue;
    const dimRow = (dim: string, value: string) => {
      const k = [day, dim, value, kind, v, pl];
      add(dims, k, "plays", 1);
      if (result === "win" || result === "draw") add(dims, k, result === "win" ? "wins" : "draws", 1);
      if (result === "loss") add(dims, k, "losses", 1);
      if (r.value !== null) { add(dims, k, "score_sum", r.value); add(dims, k, "score_n", 1); }
      const id = JSON.stringify([dim, value, kind]);
      if (!(dd!.seen.d ??= []).includes(id)) { dd!.seen.d.push(id); add(dims, k, "players", 1); }
    };
    dimRow("", "");
    for (const d of profile.dimensions) {
      const raw = d.key === "level" && props.level === undefined ? r.level : props[d.key];
      const values = d.multi && typeof raw === "string" ? [...new Set(raw.split(",").map((s) => text(s.trim())).filter(Boolean))].slice(0, 10)
        : text(raw) ? [text(raw)] : [];
      for (const val of values) dimRow(d.key, capped(d.key, val));
    }
  }

  for (const dev of devs.values()) {
    for (const [k, o] of Object.entries(dev.open)) {
      if (!o.q && o.r < aged) { o.q = 1; add(levels, [o.d, o.k ?? "level", o.l, o.m ?? "", o.f ?? "", o.v, o.p], "quits", 1); dev.dirty = true; }
      else if (o.q && o.r < aged - KEEP_AGED_MS) { delete dev.open[k]; dev.dirty = true; }
    }
  }

  const devRows = [...devs].filter(([, d]) => d.dirty).map(([id, d]) => {
    const pending = Object.values(d.open).filter((o) => !o.q).map((o) => o.r);
    const open = Object.keys(d.open).length ? JSON.stringify(d.open) : null;
    return [id, d.first_day, d.version, d.platform, d.country, open, pending.length ? Math.min(...pending) : null,
      Object.keys(d.tracks).length ? JSON.stringify(d.tracks) : null];
  });
  const dayRows = [...dds].filter(([, d]) => d.dirty).map(([k, d]) => {
    const spans = Object.values(d.seen.s);
    return [...JSON.parse(k), d.version, d.platform, d.country, d.is_new, spans.length,
      spans.reduce((t, [a, b]) => t + b - a, 0), d.events, JSON.stringify(d.seen)];
  });
  const flat = (m: Map<string, Record<string, number>>, fields: string[]) =>
    [...m].map(([k, o]) => [...JSON.parse(k), ...fields.map((f) => o[f] ?? 0)]);
  const LEVEL_FIELDS = ["starts", "players", "wins", "fails", "quits", "draws", "abandons", "first_try_wins", "duration_sum", "duration_n", "stars_sum", "stars_n", "moves_left_sum", "moves_left_n", "first_starts"];
  const DIM_FIELDS = ["plays", "players", "wins", "losses", "draws", "score_sum", "score_n"];
  const TRACK_FIELDS = ["devices", "reached", "reach_days"];
  const STEP_FIELDS = ["devices", "duration_sum", "duration_n"];
  const EVENT_FIELDS = ["count", "devices", "value_sum"];

  const col = (n: number) => Array.from({ length: n }, (_, i) => `json_extract(value, '$[${i}]')`).join(", ");
  const sum = (t: string, fields: string[]) => fields.map((f) => `${f} = ${t}.${f} + excluded.${f}`).join(", ");
  const upsert = (sql: string, rows: unknown[][]) => rows.length ? [db.prepare(sql).bind(p.id, JSON.stringify(rows))] : [];
  const endRebuild = p.rebuild_until !== null && (caughtUp || last!.received_at > p.rebuild_until);
  const retentionCutoff = Math.min(now - RAW_KEEP_DAYS * DAY, last?.received_at ?? p.wm_at);

  const writes = [
    ...upsert(`INSERT INTO devices (project_id, device_id, first_day, version, platform, country, open, open_min, tracks)
      SELECT ?1, ${col(8)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, device_id) DO UPDATE SET open = excluded.open, open_min = excluded.open_min, tracks = excluded.tracks`, devRows),
    ...upsert(`INSERT INTO device_days (project_id, day, device_id, version, platform, country, is_new, sessions, playtime_ms, events, seen)
      SELECT ?1, ${col(10)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, device_id) DO UPDATE SET sessions = excluded.sessions, playtime_ms = excluded.playtime_ms,
        events = excluded.events, seen = excluded.seen`, dayRows),
    ...upsert(`INSERT INTO cohort_days (project_id, first_day, day, version, platform, country, devices)
      SELECT ?1, ${col(6)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, first_day, day, version, platform, country) DO UPDATE SET ${sum("cohort_days", ["devices"])}`,
      flat(cohorts, ["devices"])),
    ...upsert(`INSERT INTO play_days (project_id, day, kind, level, mode, difficulty, version, platform, ${LEVEL_FIELDS.join(", ")})
      SELECT ?1, ${col(7 + LEVEL_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, kind, level, mode, difficulty, version, platform) DO UPDATE SET ${sum("play_days", LEVEL_FIELDS)}`,
      flat(levels, LEVEL_FIELDS)),
    ...upsert(`INSERT INTO dim_days (project_id, day, dim, value, kind, version, platform, ${DIM_FIELDS.join(", ")})
      SELECT ?1, ${col(6 + DIM_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, dim, value, kind, version, platform) DO UPDATE SET ${sum("dim_days", DIM_FIELDS)}`,
      flat(dims, DIM_FIELDS)),
    ...upsert(`INSERT INTO track_days (project_id, day, track, bucket, version, platform, ${TRACK_FIELDS.join(", ")})
      SELECT ?1, ${col(5 + TRACK_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, track, bucket, version, platform) DO UPDATE SET ${sum("track_days", TRACK_FIELDS)}`,
      flat(tracks, TRACK_FIELDS)),
    ...upsert(`INSERT INTO step_days (project_id, day, flow, step, version, platform, ${STEP_FIELDS.join(", ")})
      SELECT ?1, ${col(5 + STEP_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, flow, step, version, platform) DO UPDATE SET ${sum("step_days", STEP_FIELDS)}`,
      flat(steps, STEP_FIELDS)),
    ...upsert(`INSERT INTO event_days (project_id, day, name, version, platform, ${EVENT_FIELDS.join(", ")})
      SELECT ?1, ${col(4 + EVENT_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, name, version, platform) DO UPDATE SET ${sum("event_days", EVENT_FIELDS)}`,
      flat(events, EVENT_FIELDS)),
    ...upsert(`INSERT INTO level_events (project_id, day, level, name, detail, version, platform, count)
      SELECT ?1, ${col(7)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, level, name, detail, version, platform) DO UPDATE SET ${sum("level_events", ["count"])}`,
      flat(levelEvents, ["count"])),
    ...upsert(`INSERT INTO econ_days (project_id, day, name, currency, detail, version, platform, count, value_sum)
      SELECT ?1, ${col(8)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, name, currency, detail, version, platform) DO UPDATE SET ${sum("econ_days", ["count", "value_sum"])}`,
      flat(econ, ["count", "value_sum"])),
    db.prepare(`UPDATE projects SET wm_at = ?2, wm_id = ?3,
        rebuild_from = CASE WHEN ?4 THEN NULL ELSE rebuild_from END, rebuild_until = CASE WHEN ?4 THEN NULL ELSE rebuild_until END,
        profile_detected = ?5, dim_values = ?6
      WHERE id = ?1`).bind(p.id, last?.received_at ?? p.wm_at, last?.event_id ?? p.wm_id, endRebuild ? 1 : 0, detected,
        Object.keys(dimValues).length ? JSON.stringify(dimValues) : null),
    // Raw retention: only rows already rolled up, at most DELETE_CHUNK per run.
    db.prepare(`DELETE FROM events WHERE project_id = ?1 AND event_id IN
      (SELECT event_id FROM events WHERE project_id = ?1 AND received_at < ?2 LIMIT ${DELETE_CHUNK})`).bind(p.id, retentionCutoff),
  ];
  cost.queries += writes.length;
  await db.batch(writes);
  return rows.length;
}

/**
 * The reporting time zone changed: drop the last 89 days of rollups and replay them from raw rows.
 * Days before that keep the old zone. The replay starts one day earlier by arrival time, because
 * ingest keeps device times at most one day ahead of arrival.
 */
async function startRebuild(db: D1Database, p: Project, now: number): Promise<Project> {
  const off = p.tz_min * 60_000;
  const from = (Math.floor((now - 89 * DAY + off) / DAY) + 1) * DAY - off; // a local midnight
  const day = dayOf(from, p.tz_min);
  const next: Project = {
    ...p,
    rollup_tz: p.tz_min,
    rebuild_from: from,
    rebuild_until: Math.max(p.wm_at, p.rebuild_until ?? 0),
    wm_at: Math.min(p.wm_at, from - DAY),
    wm_id: p.wm_at <= from - DAY ? p.wm_id : "",
  };
  await db.batch([
    ...["device_days", "play_days", "event_days", "cohort_days", "level_events", "econ_days", "dim_days", "track_days", "step_days"].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE project_id = ? AND day >= ?`).bind(p.id, day)),
    db.prepare("DELETE FROM devices WHERE project_id = ? AND first_day >= ?").bind(p.id, day),
    // Milestones reached in the replay window are counted again; earlier ones stay reached.
    db.prepare(`UPDATE devices SET open = NULL, open_min = NULL,
      tracks = (SELECT NULLIF(json_group_object(key, value), '{}') FROM json_each(devices.tracks) WHERE value < ?2)
      WHERE project_id = ?1 AND (open IS NOT NULL OR tracks IS NOT NULL)`).bind(p.id, day),
    db.prepare("UPDATE projects SET rollup_tz = ?2, rebuild_from = ?3, rebuild_until = ?4, wm_at = ?5, wm_id = ?6 WHERE id = ?1")
      .bind(p.id, next.rollup_tz, next.rebuild_from, next.rebuild_until, next.wm_at, next.wm_id),
  ]);
  return next;
}
