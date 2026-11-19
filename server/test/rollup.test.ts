import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAY } from "../src/rollup";
import { at, MIN, NOW, seed, seedAsPlays, seedEconomy, seedIdle, seedMatch } from "./fixture";
import { createProject, raw, reset, rollUp, rows } from "./helpers";
import { runCron } from "../src/rollup";

const table = (t: string, cols: string, order: string) => rows(`SELECT ${cols} FROM ${t} ORDER BY ${order}`);
const snapshot = async () => ({
  devices: await table("devices", "device_id, first_day, version, platform, country, open_min", "device_id"),
  deviceDays: await table("device_days", "day, device_id, version, platform, is_new, sessions, playtime_ms, events", "day, device_id"),
  cohorts: await table("cohort_days", "first_day, day, version, platform, country, devices", "first_day, day, platform"),
  levels: await table("play_days", "*", "day, level, platform"),
  events: await table("event_days", "day, name, version, platform, count, devices, value_sum", "day, name, platform"),
});

beforeEach(async () => {
  await reset();
  await createProject();
});

describe("rollup", () => {
  it("matches a hand count", async () => {
    await seed();
    await rollUp(NOW);
    const s = await snapshot();
    expect(s.deviceDays).toEqual([
      { day: "2026-11-01", device_id: "d1", version: "1.0", platform: "android", is_new: 1, sessions: 1, playtime_ms: 6 * MIN, events: 5 },
      { day: "2026-11-01", device_id: "d2", version: "1.0", platform: "ios", is_new: 1, sessions: 1, playtime_ms: 3 * MIN, events: 4 },
      { day: "2026-11-02", device_id: "d1", version: "1.0", platform: "android", is_new: 0, sessions: 1, playtime_ms: 5 * MIN, events: 4 },
      { day: "2026-11-02", device_id: "d3", version: "1.1", platform: "android", is_new: 1, sessions: 1, playtime_ms: 0, events: 1 },
      { day: "2026-11-03", device_id: "d2", version: "1.0", platform: "ios", is_new: 0, sessions: 1, playtime_ms: 0, events: 1 },
    ]);
    expect(s.cohorts).toEqual([
      { first_day: "2026-11-01", day: "2026-11-01", version: "1.0", platform: "android", country: "ID", devices: 1 },
      { first_day: "2026-11-01", day: "2026-11-01", version: "1.0", platform: "ios", country: "US", devices: 1 },
      { first_day: "2026-11-01", day: "2026-11-02", version: "1.0", platform: "android", country: "ID", devices: 1 },
      { first_day: "2026-11-01", day: "2026-11-03", version: "1.0", platform: "ios", country: "US", devices: 1 },
      { first_day: "2026-11-02", day: "2026-11-02", version: "1.1", platform: "android", country: "ID", devices: 1 },
    ]);
    const zero = { kind: "level", mode: "", difficulty: "", draws: 0, abandons: 0, prestiges: 0, starts: 0, players: 0, wins: 0, fails: 0, quits: 0, first_try_wins: 0, duration_sum: 0, duration_n: 0, stars_sum: 0, stars_n: 0, moves_left_sum: 0, moves_left_n: 0, first_starts: 0 };
    expect(s.levels).toEqual([
      { ...zero, project_id: "demo", day: "2026-11-01", level: "1", version: "1.0", platform: "android",
        starts: 2, players: 1, first_starts: 1, wins: 1, fails: 1, duration_sum: 220_000, duration_n: 2, stars_sum: 3, stars_n: 1, moves_left_sum: 2, moves_left_n: 1 },
      { ...zero, project_id: "demo", day: "2026-11-01", level: "1", version: "1.0", platform: "ios",
        starts: 1, players: 1, first_starts: 1, wins: 1, first_try_wins: 1, duration_sum: 60_000, duration_n: 1, stars_sum: 1, stars_n: 1 },
      { ...zero, project_id: "demo", day: "2026-11-01", level: "2", version: "1.0", platform: "ios", starts: 1, players: 1, first_starts: 1, quits: 1 },
      { ...zero, project_id: "demo", day: "2026-11-02", level: "2", version: "1.0", platform: "android", starts: 1, players: 1, first_starts: 1, quits: 1 },
    ]);
    expect(s.events.filter((e) => e.name === "session_start").map((e) => [e.day, e.platform, e.version, e.count, e.devices])).toEqual([
      ["2026-11-01", "android", "1.0", 1, 1], ["2026-11-01", "ios", "1.0", 1, 1],
      ["2026-11-02", "android", "1.0", 1, 1], ["2026-11-02", "android", "1.1", 1, 1], ["2026-11-03", "ios", "1.0", 1, 1],
    ]);
    expect(s.events.find((e) => e.name === "booster_used")).toMatchObject({ count: 1, devices: 1, value_sum: 5 });
    expect(s.devices.map((d) => [d.device_id, d.first_day, d.open_min])).toEqual([
      ["d1", "2026-11-01", null], ["d2", "2026-11-01", null], ["d3", "2026-11-02", null],
    ]);
  });

  it("gives the same rollups when the rows arrive across many runs", async () => {
    await seed();
    await rollUp(NOW);
    const once = await snapshot();
    await reset();
    await createProject();
    await seed();
    await rollUp(NOW, 3);
    expect(await snapshot()).toEqual(once);
  });

  it("counts distinct sessions and players across runs", async () => {
    await raw({ name: "session_start", device: "d1", session: "a", ts: at(0, 10) });
    await raw({ name: "level_start", device: "d1", session: "a", ts: at(0, 10, 1), level: "1", attempt: 1 });
    await rollUp(at(0, 11));
    await raw({ name: "level_start", device: "d1", session: "a", ts: at(0, 11, 30), level: "1", attempt: 2 });
    await rollUp(at(0, 13));
    expect((await snapshot()).deviceDays[0]).toMatchObject({ sessions: 1, playtime_ms: 90 * MIN, events: 3 });
    expect((await snapshot()).levels[0]).toMatchObject({ starts: 2, players: 1 });
  });

  it("counts a quit only after 30 minutes, and takes it back when a late result arrives", async () => {
    const t = at(0, 10);
    await raw({ name: "level_start", device: "d1", session: "a", ts: t, level: "7", attempt: 1 });
    await rollUp(t + 10 * MIN);
    expect((await snapshot()).levels[0]).toMatchObject({ starts: 1, quits: 0 });
    expect((await snapshot()).devices[0].open_min).toBe(t);
    await rollUp(t + 40 * MIN);
    expect((await snapshot()).levels[0]).toMatchObject({ starts: 1, quits: 1 });
    // The player resumes in a new session and wins the same attempt.
    await raw({ name: "level_complete", device: "d1", session: "b", ts: t + 50 * MIN, level: "7", attempt: 1 });
    await rollUp(t + 60 * MIN);
    expect((await snapshot()).levels[0]).toMatchObject({ starts: 1, wins: 1, quits: 0 });
  });

  it("cuts days at the project's midnight and rebuilds when the zone changes", async () => {
    await env.DB.prepare("UPDATE projects SET tz_min = 420, rollup_tz = 420").run();
    await raw({ name: "session_start", device: "d1", session: "a", ts: at(0, 18) }); // 11-02 01:00 in UTC+7
    await raw({ name: "session_start", device: "d1", session: "b", ts: at(1, 10) }); // 11-02 17:00 in UTC+7
    await rollUp(NOW);
    expect((await snapshot()).deviceDays).toMatchObject([{ day: "2026-11-02", sessions: 2, is_new: 1 }]);
    await env.DB.prepare("UPDATE projects SET tz_min = 0").run();
    await rollUp(NOW);
    const s = await snapshot();
    expect(s.deviceDays).toMatchObject([{ day: "2026-11-01", sessions: 1, is_new: 1 }, { day: "2026-11-02", sessions: 1, is_new: 0 }]);
    expect(s.devices[0].first_day).toBe("2026-11-01");
    expect(s.cohorts.map((c) => [c.first_day, c.day, c.devices])).toEqual([["2026-11-01", "2026-11-01", 1], ["2026-11-01", "2026-11-02", 1]]);
    const p = await env.DB.prepare("SELECT rollup_tz, rebuild_from, rebuild_until FROM projects").first();
    expect(p).toEqual({ rollup_tz: 0, rebuild_from: null, rebuild_until: null });
  });

  it("counts level events by reason, booster and continue", async () => {
    const t = at(0, 10);
    await raw({ name: "level_fail", device: "d1", session: "a", ts: t, level: "3", attempt: 1, props: { reason: "out_of_moves" } });
    await raw({ name: "level_fail", device: "d2", session: "b", ts: t, level: "3", attempt: 1, props: { reason: "out_of_moves" } });
    await raw({ name: "level_quit", device: "d1", session: "a", ts: t, level: "3", attempt: 2, props: { via: "menu" } });
    await raw({ name: "booster_bought", device: "d1", session: "a", ts: t, level: "3", props: { booster: 2 } });
    await raw({ name: "continue_watched", device: "d1", session: "a", ts: t, level: "3" });
    await raw({ name: "level_complete", device: "d1", session: "a", ts: t, level: "3", attempt: 3 });
    await raw({ name: "tap", device: "d1", session: "a", ts: t });
    await rollUp(NOW);
    expect(await rows("SELECT name, detail, count FROM level_events ORDER BY name, detail")).toEqual([
      { name: "booster_bought", detail: "2", count: 1 },
      { name: "continue_watched", detail: "", count: 1 },
      { name: "level_fail", detail: "out_of_moves", count: 2 },
      { name: "level_quit", detail: "menu", count: 1 },
    ]);
  });

  it("rolls up play_start and play_end with kind level exactly like level events", async () => {
    await seed();
    await rollUp(NOW);
    const levels = await snapshot();
    const detail = await rows("SELECT * FROM level_events ORDER BY day, level, name, detail, platform");
    await reset();
    await createProject();
    await seedAsPlays();
    await rollUp(NOW);
    const plays = await snapshot();
    expect(plays.levels).toEqual(levels.levels);
    expect(await rows("SELECT * FROM level_events ORDER BY day, level, name, detail, platform")).toEqual(detail);
  });

  it("rolls up matches, dimensions, tracks and flows to a hand count", async () => {
    await seedMatch();
    await rollUp(NOW);
    const plays = await rows(`SELECT day, level, difficulty, platform, starts, players, wins, fails, quits, draws, abandons
      FROM play_days WHERE kind = 'match' ORDER BY day, level, difficulty`);
    expect(plays).toEqual([
      { day: "2026-11-01", level: "delta", difficulty: "hard", platform: "ios", starts: 1, players: 1, wins: 0, fails: 0, quits: 0, draws: 0, abandons: 1 },
      { day: "2026-11-01", level: "hourglass", difficulty: "easy", platform: "android", starts: 1, players: 1, wins: 1, fails: 0, quits: 0, draws: 0, abandons: 0 },
      { day: "2026-11-01", level: "hourglass", difficulty: "normal", platform: "android", starts: 1, players: 0, wins: 0, fails: 1, quits: 0, draws: 0, abandons: 0 },
      { day: "2026-11-01", level: "ring", difficulty: "easy", platform: "ios", starts: 1, players: 1, wins: 1, fails: 0, quits: 0, draws: 0, abandons: 0 },
      { day: "2026-11-01", level: "ring", difficulty: "hard", platform: "android", starts: 1, players: 1, wins: 0, fails: 0, quits: 0, draws: 1, abandons: 0 },
      { day: "2026-11-02", level: "delta", difficulty: "normal", platform: "ios", starts: 1, players: 1, wins: 0, fails: 1, quits: 0, draws: 0, abandons: 0 },
      { day: "2026-11-02", level: "hourglass", difficulty: "easy", platform: "android", starts: 1, players: 1, wins: 0, fails: 0, quits: 1, draws: 0, abandons: 0 },
    ]);
    // Detected from play_start with kind match.
    expect(await env.DB.prepare("SELECT profile_detected FROM projects").first()).toEqual({ profile_detected: "match_battle" });
    const deck = await rows(`SELECT value, SUM(plays) AS plays, SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws,
      ROUND(SUM(score_sum), 2) AS score, SUM(score_n) AS score_n FROM dim_days WHERE dim = 'deck' GROUP BY value ORDER BY value`);
    const all = { plays: 6, wins: 2, losses: 2, draws: 1, score: 2.9, score_n: 5 };
    expect(deck).toEqual([
      { value: "burst", ...all }, { value: "canon", ...all }, { value: "frost", ...all }, { value: "meteor", ...all }, { value: "pierce", ...all },
      { value: "wall", plays: 3, wins: 1, losses: 1, draws: 1, score: 1.8, score_n: 3 },
    ]);
    expect(await rows("SELECT dim, value, SUM(plays) AS plays FROM dim_days WHERE dim IN ('', 'opponent') GROUP BY dim, value ORDER BY dim"))
      .toEqual([{ dim: "", value: "", plays: 6 }, { dim: "opponent", value: "bot", plays: 6 }]);
    expect(await rows("SELECT day, track, bucket, devices, reached, reach_days FROM track_days ORDER BY track, day, bucket")).toEqual([
      { day: "2026-11-01", track: "arena", bucket: "2", devices: 1, reached: 1, reach_days: 0 },
      { day: "2026-11-02", track: "arena", bucket: "3", devices: 1, reached: 1, reach_days: 1 },
      { day: "2026-11-01", track: "trophies", bucket: "300", devices: 1, reached: 1, reach_days: 0 },
      { day: "2026-11-01", track: "trophies", bucket: "<300", devices: 1, reached: 0, reach_days: 0 },
      { day: "2026-11-02", track: "trophies", bucket: "800", devices: 1, reached: 1, reach_days: 1 },
      { day: "2026-11-02", track: "trophies", bucket: "<300", devices: 1, reached: 0, reach_days: 0 },
    ]);
    expect(await rows("SELECT flow, step, SUM(devices) AS devices, SUM(duration_sum) AS duration_sum, SUM(duration_n) AS duration_n FROM step_days GROUP BY flow, step ORDER BY flow, step")).toEqual([
      { flow: "tutorial", step: 0, devices: 1, duration_sum: 0, duration_n: 0 },
      { flow: "tutorial", step: 1, devices: 1, duration_sum: 0, duration_n: 0 },
      { flow: "tutorial", step: 999, devices: 1, duration_sum: 120_000, duration_n: 1 },
      { flow: "tutorial1", step: 1, devices: 2, duration_sum: 12_000, duration_n: 2 },
      { flow: "tutorial1", step: 2, devices: 2, duration_sum: 18_000, duration_n: 2 },
      { flow: "tutorial1", step: 3, devices: 1, duration_sum: 4000, duration_n: 1 },
    ]);
  });

  it("keeps milestones reached before a rebuild window counted once", async () => {
    await seedMatch();
    await rollUp(NOW);
    // Pretend the milestones were reached long before the 90 day rebuild window.
    await env.DB.batch([
      env.DB.prepare("UPDATE track_days SET day = '2026-01-01' WHERE reached > 0"),
      env.DB.prepare("UPDATE devices SET first_day = '2026-01-01', tracks = (SELECT json_group_object(key, '2026-01-01') FROM json_each(devices.tracks)) WHERE tracks IS NOT NULL"),
      env.DB.prepare("UPDATE projects SET rollup_tz = tz_min + 100000"),
    ]);
    await rollUp(NOW, 4);
    expect(await rows("SELECT day, SUM(reached) AS reached FROM track_days GROUP BY day")).toEqual([{ day: "2026-01-01", reached: 4 }, { day: "2026-11-01", reached: 0 }, { day: "2026-11-02", reached: 0 }]);
  });

  it("gives the same match rollups across many runs, and caps dimension values", async () => {
    await seedMatch();
    await rollUp(NOW);
    const q = () => rows(`SELECT 'p' t, day, level k, difficulty v, starts a, wins b, quits c FROM play_days
      UNION ALL SELECT 'd', day, dim, value, plays, players, wins FROM dim_days
      UNION ALL SELECT 't', day, track, bucket, devices, reached, reach_days FROM track_days
      UNION ALL SELECT 's', day, flow, step, devices, duration_sum, duration_n FROM step_days ORDER BY 1, 2, 3, 4`);
    const once = await q();
    await reset();
    await createProject();
    await seedMatch();
    await rollUp(NOW, 4);
    expect(await q()).toEqual(once);

    await reset();
    await createProject();
    for (let i = 0; i < 203; i++) {
      await raw({ name: "play_end", device: "x", session: "s", ts: at(0, 10, i % 60), level: "b", attempt: i,
        props: { kind: "match", result: "win", deck: `card${i}` } });
    }
    await rollUp(NOW);
    expect(await rows("SELECT COUNT(DISTINCT value) AS n, SUM(value = 'other') AS other FROM dim_days WHERE dim = 'deck'")).toEqual([{ n: 201, other: 1 }]);
    expect(await rows("SELECT SUM(plays) AS n FROM dim_days WHERE dim = 'deck' AND value = 'other'")).toEqual([{ n: 3 }]);
  });

  it("rolls up idle runs, log10 income, session gaps, offline rewards and a tutorial skip to a hand count", async () => {
    await seedIdle();
    await rollUp(NOW);
    expect(await env.DB.prepare("SELECT profile_detected FROM projects").first()).toEqual({ profile_detected: "idle_tycoon" });
    expect(await rows(`SELECT day, platform, starts, players, wins, quits, prestiges, duration_sum, duration_n FROM play_days
      WHERE kind = 'run' AND level = '(none)' ORDER BY day, platform`)).toEqual([
      { day: "2026-11-01", platform: "android", starts: 2, players: 1, wins: 0, quits: 0, prestiges: 1, duration_sum: 36_000_000, duration_n: 1 },
      { day: "2026-11-01", platform: "ios", starts: 1, players: 1, wins: 0, quits: 0, prestiges: 0, duration_sum: 0, duration_n: 0 },
      { day: "2026-11-02", platform: "android", starts: 1, players: 1, wins: 0, quits: 1, prestiges: 1, duration_sum: 54_000_000, duration_n: 1 },
      { day: "2026-11-02", platform: "ios", starts: 0, players: 0, wins: 0, quits: 0, prestiges: 1, duration_sum: 115_200_000, duration_n: 1 },
    ]);
    expect(await rows("SELECT COUNT(*) AS n FROM play_days WHERE level <> '(none)'")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT value, SUM(plays) AS plays FROM dim_days WHERE dim IN ('', 'boost') GROUP BY dim, value ORDER BY dim"))
      .toEqual([{ value: "", plays: 3 }, { value: "x2", plays: 2 }]);
    expect(await rows("SELECT day, bucket, SUM(devices) AS devices, SUM(reached) AS reached, SUM(reach_days) AS reach_days FROM track_days GROUP BY day, bucket ORDER BY day, bucket"))
      .toEqual([
        { day: "2026-11-01", bucket: "1000", devices: 1, reached: 1, reach_days: 0 },
        { day: "2026-11-01", bucket: "<1000", devices: 1, reached: 0, reach_days: 0 },
        { day: "2026-11-02", bucket: "1000", devices: 0, reached: 1, reach_days: 1 },
        { day: "2026-11-02", bucket: "1000000", devices: 1, reached: 2, reach_days: 2 },
        { day: "2026-11-02", bucket: "1000000000", devices: 1, reached: 1, reach_days: 1 },
      ]);
    expect(await rows("SELECT day, bucket, platform, sessions FROM gap_days ORDER BY day, platform, bucket")).toEqual([
      { day: "2026-11-01", bucket: "4-12h", platform: "android", sessions: 1 },
      { day: "2026-11-01", bucket: "<1h", platform: "android", sessions: 1 },
      { day: "2026-11-02", bucket: "12-24h", platform: "android", sessions: 1 },
      { day: "2026-11-02", bucket: "1-4h", platform: "ios", sessions: 1 },
      { day: "2026-11-02", bucket: "24h+", platform: "ios", sessions: 1 },
    ]);
    expect(await rows("SELECT day, detail, platform, count, value_sum, duration_sum FROM econ_days WHERE name = 'offline_reward' ORDER BY day, platform")).toEqual([
      { day: "2026-11-01", detail: "free", platform: "android", count: 1, value_sum: 1000, duration_sum: 1_800_000 },
      { day: "2026-11-02", detail: "ad", platform: "android", count: 1, value_sum: 2e12, duration_sum: 50_400_000 },
      { day: "2026-11-02", detail: "ad", platform: "ios", count: 1, value_sum: 3e15, duration_sum: 108_000_000 },
    ]);
    expect(await rows("SELECT step, devices, skips FROM step_days WHERE flow = 'tutorial' ORDER BY step")).toEqual([
      { step: 0, devices: 1, skips: 0 }, { step: 1, devices: 1, skips: 0 }, { step: 2, devices: 1, skips: 1 },
    ]);
  });

  it("counts players per play kind", async () => {
    await raw({ name: "play_start", device: "x", session: "s", ts: at(0, 10), level: "1", attempt: 1, props: { kind: "level" } });
    await raw({ name: "play_start", device: "x", session: "s", ts: at(0, 10, 1), level: "1", attempt: 2, props: { kind: "match" } });
    await rollUp(NOW);
    expect(await rows("SELECT kind, starts, players FROM play_days ORDER BY kind")).toEqual([
      { kind: "level", starts: 1, players: 1 }, { kind: "match", starts: 1, players: 1 },
    ]);
  });

  it("treats props keys such as constructor as plain dimension, track and flow names", async () => {
    await env.DB.prepare("UPDATE projects SET profile = ?").bind(JSON.stringify({ preset: "match_battle", dimensions: [{ key: "constructor" }],
      tracks: [{ key: "constructor", milestones: [1] }] })).run();
    await raw({ name: "play_end", device: "x", session: "s", ts: at(0, 10), level: "1", attempt: 1, props: { kind: "match", result: "win", constructor: "a", toString: "b" } });
    await raw({ name: "progress", device: "x", session: "s", ts: at(0, 10, 1), value: 2, props: { track: "constructor" } });
    await raw({ name: "step", device: "x", session: "s", ts: at(0, 10, 2), props: { flow: "__proto__", step: 1 } });
    await rollUp(NOW);
    expect(await rows("SELECT dim, value FROM dim_days WHERE dim = 'constructor'")).toEqual([{ dim: "constructor", value: "a" }]);
    expect(await rows("SELECT bucket, reached FROM track_days WHERE track = 'constructor'")).toEqual([{ bucket: "1", reached: 1 }]);
    const seen = JSON.parse((await env.DB.prepare("SELECT seen_keys FROM projects").first<{ seen_keys: string }>())!.seen_keys);
    expect(Object.keys(seen.k).sort()).toEqual(["constructor", "toString"]);
    expect(Object.keys(seen.f)).toEqual(["__proto__"]);
  });

  it("detects the preset again each day from the last 7 days until a profile is saved", async () => {
    await seedMatch();
    await rollUp(NOW);
    const project = () => env.DB.prepare("SELECT profile_detected, detected_on, tz_min, rollup_tz FROM projects").first<Record<string, unknown>>();
    expect(await project()).toMatchObject({ profile_detected: "match_battle", detected_on: "2026-11-03", rollup_tz: 0 });
    // A week later the game sends idle runs only: the new preset is detected and the rollups rebuild with it.
    for (let i = 0; i < 3; i++) {
      await raw({ name: "play_start", device: "m1", session: "z", ts: at(9, 10, i), attempt: 100 + i, props: { kind: "run" } });
      await raw({ name: "play_end", device: "m1", session: "z", ts: at(9, 10, i) + 30_000, attempt: 100 + i, props: { kind: "run", result: "prestige" } });
    }
    await rollUp(at(9, 23));
    expect(await project()).toMatchObject({ profile_detected: "idle_tycoon", detected_on: "2026-11-10" });
    expect((await project())!.rollup_tz).not.toBe(0);
    // A saved profile stops detection.
    await env.DB.prepare("UPDATE projects SET profile = ?, rollup_tz = 0, rebuild_from = NULL, rebuild_until = NULL").bind(JSON.stringify({ preset: "match_battle" })).run();
    await raw({ name: "play_start", device: "m1", session: "z", ts: at(10, 10), attempt: 200, props: { kind: "run" } });
    await rollUp(at(10, 23));
    expect(await project()).toMatchObject({ profile_detected: "idle_tycoon", detected_on: "2026-11-10", rollup_tz: 0 });
  });

  it("rolls up economy and ad events by currency and detail", async () => {
    await seedEconomy();
    await raw({ name: "tap", device: "d1", session: "a", ts: at(0, 10) });
    await rollUp(NOW);
    const econ = await rows("SELECT day, name, currency, detail, platform, count, value_sum FROM econ_days ORDER BY day, name, detail");
    expect(econ.map((r) => [r.day, r.name, r.currency, r.detail, r.count, r.value_sum])).toEqual([
      ["2026-11-01", "ad_shown", "USD", "interstitial", 1, 0.02],
      ["2026-11-01", "ad_shown", "USD", "rewarded", 1, 0.05],
      ["2026-11-01", "booster_bought", "", "bomb", 1, 0],
      ["2026-11-01", "booster_offered", "", "hammer", 1, 0],
      ["2026-11-01", "booster_used", "", "hammer", 1, 0],
      ["2026-11-01", "continue_watched", "", "rewarded", 1, 0],
      ["2026-11-01", "currency_earned", "coins", "daily_gift", 1, 50],
      ["2026-11-01", "currency_earned", "coins", "level_reward", 1, 100],
      ["2026-11-01", "currency_spent", "coins", "booster", 1, 30],
      ["2026-11-01", "iap_purchase", "USD", "starter", 1, 0.99],
      ["2026-11-01", "interstitial_shown", "", "interstitial", 1, 0],
      ["2026-11-01", "try_offer_shown", "", "free", 1, 0],
      ["2026-11-01", "try_taken", "", "hammer", 1, 0],
      ["2026-11-02", "currency_earned", "coins", "level_reward", 1, 20],
    ]);
  });

  it("keeps every row when many share one arrival time", async () => {
    for (let i = 0; i < 5; i++) await raw({ name: "tap", device: "d1", session: "a", ts: at(0, 10), received: at(0, 10) });
    await rollUp(NOW, 2);
    expect((await snapshot()).events[0]).toMatchObject({ count: 5, devices: 1 });
  });

  it("deletes raw rows older than 90 days once rolled up", async () => {
    await raw({ name: "tap", device: "d1", session: "a", ts: NOW - 91 * DAY });
    await raw({ name: "tap", device: "d1", session: "a", ts: NOW - 89 * DAY });
    await rollUp(NOW);
    expect(await rows("SELECT client_ts FROM events")).toEqual([{ client_ts: NOW - 89 * DAY }]);
    expect((await snapshot()).deviceDays).toHaveLength(2);
  });
});

describe("cron", () => {
  beforeEach(reset);

  it("rolls up projects in rotation when they do not all fit in one run", async () => {
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const id of ids) {
      await env.DB.prepare("INSERT INTO projects (id, name, created_at, write_key_hash) VALUES (?, ?, ?, ?)").bind(id, id, 1, id).run();
      await env.DB.prepare("INSERT INTO events (project_id, event_id, name, device_id, session_id, client_ts, received_at) VALUES (?, 'e', 'tap', 'd', 's', ?, ?)")
        .bind(id, at(0, 10), at(0, 10)).run();
    }
    const done = async () => (await rows("SELECT id FROM projects WHERE wm_at > 0 ORDER BY id")).map((r) => r.id);
    await runCron(env.DB, at(0, 12));
    const first = await done();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(ids.length);
    await runCron(env.DB, at(0, 12, 15));
    expect(await done()).toEqual(ids);
  });

  it("rolls up many idle projects in one run", async () => {
    for (let i = 0; i < 12; i++) await env.DB.prepare("INSERT INTO projects (id, name, created_at, write_key_hash, tz_min, rollup_tz) VALUES (?, ?, 1, ?, 0, 0)").bind(`p${i}`, `p${i}`, `h${i}`).run();
    const res = await runCron(env.DB, at(0, 12));
    expect(res).toEqual({ projects: 12, of: 12 });
  });
});
