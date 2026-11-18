import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAY } from "../src/rollup";
import { at, MIN, NOW, seed } from "./fixture";
import { createProject, raw, reset, rollUp, rows } from "./helpers";

const table = (t: string, cols: string, order: string) => rows(`SELECT ${cols} FROM ${t} ORDER BY ${order}`);
const snapshot = async () => ({
  devices: await table("devices", "device_id, first_day, version, platform, country, open_min", "device_id"),
  deviceDays: await table("device_days", "day, device_id, version, platform, is_new, sessions, playtime_ms, events", "day, device_id"),
  cohorts: await table("cohort_days", "first_day, day, version, platform, country, devices", "first_day, day, platform"),
  levels: await table("level_days", "*", "day, level, platform"),
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
    const zero = { starts: 0, players: 0, wins: 0, fails: 0, quits: 0, first_try_wins: 0, duration_sum: 0, duration_n: 0, stars_sum: 0, stars_n: 0, moves_left_sum: 0, moves_left_n: 0, first_starts: 0 };
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
