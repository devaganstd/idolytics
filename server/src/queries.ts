export const DAY = 86_400_000;
export const RANGE_DAYS = 30;
/** A start with no result is a quit only once it is this old, so a level in play is not counted. */
export const QUIT_AFTER_MS = 30 * 60_000;
export const BOOSTER_EVENTS = ["booster_used", "booster_bought", "try_taken"];

export interface LevelStat { level: string; starts: number; wins: number; losses: number; quits: number; winRate: number | null; attemptsPerWin: number | null }

export async function projects(db: D1Database) {
  return (await db.prepare("SELECT id, name FROM projects ORDER BY created_at").all<{ id: string; name: string }>()).results;
}

export async function daily(db: D1Database, project: string, now: number) {
  return (await db.prepare(
    `SELECT date(client_ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT device_id) AS players, COUNT(DISTINCT session_id) AS sessions
     FROM events WHERE project_id = ? AND client_ts >= ? GROUP BY day ORDER BY day`,
  ).bind(project, now - RANGE_DAYS * DAY).all<{ day: string; players: number; sessions: number }>()).results;
}

export async function levelStats(db: D1Database, project: string, now: number): Promise<LevelStat[]> {
  const { results } = await db.prepare(
    `WITH g AS (
       SELECT level,
         SUM(name = 'level_start') AS s, SUM(name = 'level_complete') AS w,
         SUM(name = 'level_fail') AS l, SUM(name = 'level_quit') AS q,
         -- received_at, not the device clock, which can be a day off.
         MAX(CASE WHEN name = 'level_start' THEN received_at END) AS last_start
       FROM events
       WHERE project_id = ? AND level IS NOT NULL AND client_ts >= ?
         AND name IN ('level_start', 'level_complete', 'level_fail', 'level_quit')
       -- By attempt, not session, so a level resumed after a restart still closes; session only when attempt is missing.
       GROUP BY level, device_id, COALESCE(attempt, session_id))
     SELECT level, SUM(s) AS starts, SUM(w) AS wins, SUM(l) AS losses,
       SUM(q + CASE WHEN last_start < ? THEN MAX(0, s - w - l - q) ELSE 0 END) AS quits
     FROM g GROUP BY level
     ORDER BY CAST(level AS INTEGER), level`,
  ).bind(project, now - RANGE_DAYS * DAY, now - QUIT_AFTER_MS).all<{ level: string; starts: number; wins: number; losses: number; quits: number }>();
  return results.map((r) => ({
    ...r,
    winRate: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null,
    attemptsPerWin: r.wins > 0 ? r.starts / r.wins : null,
  }));
}

export async function boosters(db: D1Database, project: string, now: number) {
  const marks = BOOSTER_EVENTS.map(() => "?").join(", ");
  const since = now - RANGE_DAYS * DAY;
  // Two grouped queries in one round trip; a single (day, label) scan would return rows without bound.
  const [byBooster, byDay] = await db.batch<{ label: string; count: number }>([
    db.prepare(
      `SELECT name || ' ' || COALESCE(json_extract(props, '$.booster'), '?') AS label, COUNT(*) AS count
       FROM events WHERE project_id = ? AND client_ts >= ? AND name IN (${marks})
       GROUP BY label ORDER BY count DESC LIMIT 12`,
    ).bind(project, since, ...BOOSTER_EVENTS),
    db.prepare(
      `SELECT date(client_ts / 1000, 'unixepoch') AS label, COUNT(*) AS count
       FROM events WHERE project_id = ? AND client_ts >= ? AND name IN (${marks})
       GROUP BY label ORDER BY label`,
    ).bind(project, since, ...BOOSTER_EVENTS),
  ]);
  return { byBooster: byBooster.results, byDay: byDay.results };
}

export interface TailRow { client_ts: number; name: string; level: string | null; attempt: number | null; duration_ms: number | null; device_id: string; platform: string | null; props: string | null }

export async function tail(db: D1Database, project: string) {
  return (await db.prepare(
    `SELECT client_ts, name, level, attempt, duration_ms, device_id, platform, props
     FROM events WHERE project_id = ? ORDER BY client_ts DESC LIMIT 50`,
  ).bind(project).all<TailRow>()).results;
}
