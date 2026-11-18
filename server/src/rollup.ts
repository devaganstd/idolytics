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
const LEVEL_EVENTS = new Set(["level_start", "level_complete", "level_fail", "level_quit"]);

/** Local calendar day of an epoch ms time, for a fixed offset in minutes east of UTC. */
export const dayOf = (ts: number, tzMin: number) => new Date(ts + tzMin * 60_000).toISOString().slice(0, 10);

export interface Project {
  id: string; tz_min: number; rollup_tz: number; wm_at: number; wm_id: string;
  rebuild_from: number | null; rebuild_until: number | null;
}
interface Raw {
  event_id: string; name: string; device_id: string; session_id: string; client_ts: number; received_at: number;
  app_version: string | null; platform: string | null; country: string | null; level: string | null;
  attempt: number | null; duration_ms: number | null; value: number | null; props: string | null;
}
/** An unclosed level start: received at, day, version, platform, level, counted as a quit. */
interface Open { r: number; d: string; v: string; p: string; l: string; q?: 1 }
interface Dev { first_day: string; version: string; platform: string; country: string; open: Record<string, Open>; dirty: boolean; isNew: boolean }
interface Seen { s: Record<string, [number, number]>; n: string[]; l: string[] }
interface DevDay { version: string; platform: string; country: string; is_new: number; events: number; seen: Seen; dirty: boolean }

export async function runCron(db: D1Database, now: number) {
  const { results } = await db.prepare(
    "SELECT id, tz_min, rollup_tz, wm_at, wm_id, rebuild_from, rebuild_until FROM projects ORDER BY created_at",
  ).all<Project>();
  // shortcut: every project in one invocation; the free plan allows 50 D1 queries per invocation (about 4 projects), rotate projects if more are needed
  for (const p of results) await rollupProject(db, p, now);
}

/** Rolls up one chunk of new raw rows and ages out quits. Returns the number of raw rows read. */
export async function rollupProject(db: D1Database, project: Project, now: number, chunk = CHUNK): Promise<number> {
  const p = project.tz_min === project.rollup_tz ? project : await startRebuild(db, project, now);
  const tz = p.tz_min;
  const hi = now - LAG_MS;
  const rows = (await db.prepare(
    `SELECT event_id, name, device_id, session_id, client_ts, received_at, app_version, platform, country, level,
       attempt, duration_ms, value, CASE WHEN level IS NOT NULL AND name <> 'level_start' THEN props END AS props
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
    db.prepare("SELECT device_id, first_day, version, platform, country, open FROM devices WHERE project_id = ?1 AND device_id IN (SELECT value FROM json_each(?2))")
      .bind(p.id, JSON.stringify(ids)),
    db.prepare("SELECT device_id, first_day, version, platform, country, open FROM devices WHERE project_id = ?1 AND open_min < ?2")
      .bind(p.id, aged),
    db.prepare(`SELECT day, device_id, version, platform, country, is_new, events, seen FROM device_days
      WHERE project_id = ?1 AND day BETWEEN ?2 AND ?3 AND device_id IN (SELECT value FROM json_each(?4))`)
      .bind(p.id, days[0] ?? "", days.at(-1) ?? "", JSON.stringify(ids)),
  ]);

  const devs = new Map<string, Dev>();
  for (const d of [...known.results, ...agedDevs.results]) {
    devs.set(d.device_id as string, {
      first_day: d.first_day as string, version: d.version as string, platform: d.platform as string, country: d.country as string,
      open: d.open ? JSON.parse(d.open as string) : {}, dirty: false, isNew: false,
    });
  }
  // A new install's first values are those of its earliest event in this chunk.
  for (const r of [...live].sort((a, b) => a.client_ts - b.client_ts)) {
    if (!devs.has(r.device_id)) {
      devs.set(r.device_id, {
        first_day: dayOf(r.client_ts, tz), version: r.app_version ?? "", platform: r.platform ?? "", country: r.country ?? "",
        open: {}, dirty: true, isNew: true,
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

  const levels = new Map<string, Record<string, number>>();
  const events = new Map<string, Record<string, number>>();
  const cohorts = new Map<string, Record<string, number>>();
  const levelEvents = new Map<string, Record<string, number>>();
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

    if (r.level === null) continue;
    const props = r.props ? JSON.parse(r.props) as Record<string, unknown> : {};
    if (r.name !== "level_start" && r.name !== "level_complete") {
      const d = props.reason ?? props.via ?? props.booster;
      const detail = typeof d === "string" || typeof d === "number" || typeof d === "boolean" ? String(d).slice(0, 40) : "";
      add(levelEvents, [day, r.level, r.name, String(detail), v, pl], "count", 1);
    }
    if (!LEVEL_EVENTS.has(r.name)) continue;
    const lk = [day, r.level, v, pl];
    // By attempt, not session, so a level resumed after a restart still closes; session only when attempt is missing.
    const ok = JSON.stringify([r.level, r.attempt ?? "s:" + r.session_id]);
    if (r.name === "level_start") {
      add(levels, lk, "starts", 1);
      if (r.attempt === 1) add(levels, lk, "first_starts", 1);
      if (!dd.seen.l.includes(r.level)) { dd.seen.l.push(r.level); add(levels, lk, "players", 1); }
      dev.open[ok] = { r: r.received_at, d: day, v, p: pl, l: r.level };
      dev.dirty = true;
      continue;
    }
    const field = r.name === "level_complete" ? "wins" : r.name === "level_fail" ? "fails" : "quits";
    add(levels, lk, field, 1);
    if (field === "wins" && r.attempt === 1) add(levels, lk, "first_try_wins", 1);
    if (r.duration_ms !== null) { add(levels, lk, "duration_sum", r.duration_ms); add(levels, lk, "duration_n", 1); }
    if (field === "wins" && typeof props.stars === "number") { add(levels, lk, "stars_sum", props.stars); add(levels, lk, "stars_n", 1); }
    if (field === "wins" && typeof props.moves_left === "number") { add(levels, lk, "moves_left_sum", props.moves_left); add(levels, lk, "moves_left_n", 1); }
    const o = dev.open[ok];
    if (o) {
      // The start was already counted as a quit; the late result takes it back.
      if (o.q) add(levels, [o.d, o.l, o.v, o.p], "quits", -1);
      delete dev.open[ok];
      dev.dirty = true;
    }
  }

  for (const dev of devs.values()) {
    for (const [k, o] of Object.entries(dev.open)) {
      if (!o.q && o.r < aged) { o.q = 1; add(levels, [o.d, o.l, o.v, o.p], "quits", 1); dev.dirty = true; }
      else if (o.q && o.r < aged - KEEP_AGED_MS) { delete dev.open[k]; dev.dirty = true; }
    }
  }

  const devRows = [...devs].filter(([, d]) => d.dirty).map(([id, d]) => {
    const pending = Object.values(d.open).filter((o) => !o.q).map((o) => o.r);
    const open = Object.keys(d.open).length ? JSON.stringify(d.open) : null;
    return [id, d.first_day, d.version, d.platform, d.country, open, pending.length ? Math.min(...pending) : null];
  });
  const dayRows = [...dds].filter(([, d]) => d.dirty).map(([k, d]) => {
    const spans = Object.values(d.seen.s);
    return [...JSON.parse(k), d.version, d.platform, d.country, d.is_new, spans.length,
      spans.reduce((t, [a, b]) => t + b - a, 0), d.events, JSON.stringify(d.seen)];
  });
  const flat = (m: Map<string, Record<string, number>>, fields: string[]) =>
    [...m].map(([k, o]) => [...JSON.parse(k), ...fields.map((f) => o[f] ?? 0)]);
  const LEVEL_FIELDS = ["starts", "players", "wins", "fails", "quits", "first_try_wins", "duration_sum", "duration_n", "stars_sum", "stars_n", "moves_left_sum", "moves_left_n", "first_starts"];
  const EVENT_FIELDS = ["count", "devices", "value_sum"];

  const col = (n: number) => Array.from({ length: n }, (_, i) => `json_extract(value, '$[${i}]')`).join(", ");
  const sum = (t: string, fields: string[]) => fields.map((f) => `${f} = ${t}.${f} + excluded.${f}`).join(", ");
  const upsert = (sql: string, rows: unknown[][]) => rows.length ? [db.prepare(sql).bind(p.id, JSON.stringify(rows))] : [];
  const endRebuild = p.rebuild_until !== null && (caughtUp || last!.received_at > p.rebuild_until);
  const retentionCutoff = Math.min(now - RAW_KEEP_DAYS * DAY, last?.received_at ?? p.wm_at);

  await db.batch([
    ...upsert(`INSERT INTO devices (project_id, device_id, first_day, version, platform, country, open, open_min)
      SELECT ?1, ${col(7)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, device_id) DO UPDATE SET open = excluded.open, open_min = excluded.open_min`, devRows),
    ...upsert(`INSERT INTO device_days (project_id, day, device_id, version, platform, country, is_new, sessions, playtime_ms, events, seen)
      SELECT ?1, ${col(10)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, device_id) DO UPDATE SET sessions = excluded.sessions, playtime_ms = excluded.playtime_ms,
        events = excluded.events, seen = excluded.seen`, dayRows),
    ...upsert(`INSERT INTO cohort_days (project_id, first_day, day, version, platform, country, devices)
      SELECT ?1, ${col(6)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, first_day, day, version, platform, country) DO UPDATE SET ${sum("cohort_days", ["devices"])}`,
      flat(cohorts, ["devices"])),
    ...upsert(`INSERT INTO level_days (project_id, day, level, version, platform, ${LEVEL_FIELDS.join(", ")})
      SELECT ?1, ${col(4 + LEVEL_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, level, version, platform) DO UPDATE SET ${sum("level_days", LEVEL_FIELDS)}`,
      flat(levels, LEVEL_FIELDS)),
    ...upsert(`INSERT INTO event_days (project_id, day, name, version, platform, ${EVENT_FIELDS.join(", ")})
      SELECT ?1, ${col(4 + EVENT_FIELDS.length)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, name, version, platform) DO UPDATE SET ${sum("event_days", EVENT_FIELDS)}`,
      flat(events, EVENT_FIELDS)),
    ...upsert(`INSERT INTO level_events (project_id, day, level, name, detail, version, platform, count)
      SELECT ?1, ${col(7)} FROM json_each(?2) WHERE true
      ON CONFLICT (project_id, day, level, name, detail, version, platform) DO UPDATE SET ${sum("level_events", ["count"])}`,
      flat(levelEvents, ["count"])),
    db.prepare(`UPDATE projects SET wm_at = ?2, wm_id = ?3,
        rebuild_from = CASE WHEN ?4 THEN NULL ELSE rebuild_from END, rebuild_until = CASE WHEN ?4 THEN NULL ELSE rebuild_until END
      WHERE id = ?1`).bind(p.id, last?.received_at ?? p.wm_at, last?.event_id ?? p.wm_id, endRebuild ? 1 : 0),
    // Raw retention: only rows already rolled up, at most DELETE_CHUNK per run.
    db.prepare(`DELETE FROM events WHERE project_id = ?1 AND event_id IN
      (SELECT event_id FROM events WHERE project_id = ?1 AND received_at < ?2 LIMIT ${DELETE_CHUNK})`).bind(p.id, retentionCutoff),
  ]);
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
    ...["device_days", "level_days", "event_days", "cohort_days", "level_events"].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE project_id = ? AND day >= ?`).bind(p.id, day)),
    db.prepare("DELETE FROM devices WHERE project_id = ? AND first_day >= ?").bind(p.id, day),
    db.prepare("UPDATE devices SET open = NULL, open_min = NULL WHERE project_id = ? AND open IS NOT NULL").bind(p.id),
    db.prepare("UPDATE projects SET rollup_tz = ?2, rebuild_from = ?3, rebuild_until = ?4, wm_at = ?5, wm_id = ?6 WHERE id = ?1")
      .bind(p.id, next.rollup_tz, next.rebuild_from, next.rebuild_until, next.wm_at, next.wm_id),
  ]);
  return next;
}
