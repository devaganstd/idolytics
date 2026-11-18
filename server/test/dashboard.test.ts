import { beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { tzLabel, tzOffset } from "../src/dashboard";
import { boosters, daily, DAY, levelStats, RANGE_DAYS } from "../src/queries";
import { BASE, batch, createProject, ev, post, reset, store } from "./helpers";

const AUTH = { Authorization: "Basic " + btoa("admin:test-admin-key") };
const get = (path: string, headers: Record<string, string> = AUTH) =>
  exports.default.fetch(new Request(BASE + path, { headers }));

beforeEach(async () => {
  await reset();
});

describe("dashboard auth", () => {
  it("asks for the admin key", async () => {
    const res = await get("/", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    expect((await get("/", { Authorization: "Basic " + btoa("admin:wrong") })).status).toBe(401);
  });

  it("serves the page with the admin key", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("New project");
  });
});

describe("projects", () => {
  const create = (origin: string, auth = AUTH) => exports.default.fetch(new Request(`${BASE}/projects`, {
    method: "POST",
    headers: { ...auth, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "id=my-game&name=My+Game",
  }));

  it("creates a project and shows a write key that works once", async () => {
    const res = await create(BASE);
    expect(res.status).toBe(200);
    const key = (await res.text()).match(/idl_w_[A-Za-z0-9_-]+/)![0];
    const ingest = await post(batch([ev()]), key);
    expect(ingest.status).toBe(202);
    const row = await env.DB.prepare("SELECT write_key_hash FROM projects WHERE id = 'my-game'").first<{ write_key_hash: string }>();
    expect(row!.write_key_hash).not.toContain("idl_w_");
  });

  it("refuses cross origin posts and missing auth", async () => {
    expect((await create("https://evil.example")).status).toBe(403);
    expect((await create(BASE, {} as typeof AUTH)).status).toBe(401);
  });
});

describe("level stats", () => {
  const now = Date.now();
  const old = now - 60 * 60_000;
  const at = (min: number) => now - min * 60_000;

  it("matches a hand count, inferring quits only for stale unclosed starts", async () => {
    // d1: fails attempt 1, wins attempt 2. d2: wins level 1, leaves level 2 an hour ago.
    // d3: started level 2 five minutes ago (still playing). d4: quits level 2 explicitly.
    for (const e of [
      { name: "level_start", device: "d1", level: "1", attempt: 1 }, { name: "level_fail", device: "d1", level: "1", attempt: 1 },
      { name: "level_start", device: "d1", level: "1", attempt: 2 }, { name: "level_complete", device: "d1", level: "1", attempt: 2 },
      { name: "level_start", device: "d2", level: "1", attempt: 1 }, { name: "level_complete", device: "d2", level: "1", attempt: 1 },
      { name: "level_start", device: "d2", level: "2", attempt: 1 },
      { name: "level_start", device: "d4", level: "2", attempt: 1 }, { name: "level_quit", device: "d4", level: "2", attempt: 1 },
    ]) await store({ ...e, session: "s-" + e.device, ts: old, received: old });
    await store({ name: "level_start", device: "d3", session: "s3", level: "2", attempt: 1, ts: at(5), received: at(5) });

    expect(await levelStats(env.DB, "demo", now)).toEqual([
      { level: "1", starts: 3, wins: 2, losses: 1, quits: 0, winRate: 2 / 3, attemptsPerWin: 1.5 },
      { level: "2", starts: 3, wins: 0, losses: 0, quits: 2, winRate: null, attemptsPerWin: null },
    ]);
  });

  it("ages a start by when the server received it, not by the device clock", async () => {
    // Device clock 20 hours ahead; the start reached the server two hours ago and was never closed.
    await store({ name: "level_start", device: "d1", session: "s1", level: "5", attempt: 1, ts: now + 20 * 3_600_000, received: at(120) });
    expect((await levelStats(env.DB, "demo", now))[0]).toMatchObject({ level: "5", starts: 1, quits: 1 });
  });

  it("keeps unclosed starts without an attempt apart by session", async () => {
    await store({ name: "level_start", device: "d1", session: "a", level: "4", attempt: null, ts: at(90), received: at(90) });
    await store({ name: "level_start", device: "d1", session: "b", level: "4", attempt: null, ts: at(5), received: at(5) });
    expect((await levelStats(env.DB, "demo", now))[0]).toMatchObject({ level: "4", starts: 2, quits: 1 });
  });

  it("does not count a level resumed and finished in a new session as a quit", async () => {
    await store({ name: "level_start", device: "d1", session: "old", level: "3", attempt: 1, ts: at(90), received: at(90) });
    await store({ name: "level_complete", device: "d1", session: "new", level: "3", attempt: 1, ts: at(10), received: at(10) });
    expect((await levelStats(env.DB, "demo", now))[0]).toMatchObject({ level: "3", starts: 1, wins: 1, quits: 0 });
  });
});

describe("booster use", () => {
  it("totals by booster and by day", async () => {
    await createProject();
    await post(batch([
      ev({ name: "booster_bought", props: { booster: 2 } }), ev({ name: "booster_bought", props: { booster: 2 } }),
      ev({ name: "try_taken", props: { booster: 1 } }), ev({ name: "level_start" }),
    ]));
    const b = await boosters(env.DB, "demo", Date.now());
    expect(b.byBooster).toEqual([{ label: "booster_bought 2", count: 2 }, { label: "try_taken 1", count: 1 }]);
    expect(b.byDay).toEqual([{ label: new Date().toISOString().slice(0, 10), count: 3 }]);
  });
});

describe("time zone", () => {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const evening = today - DAY + 18 * 3_600_000; // yesterday 18:00 UTC
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("buckets an 18:00 UTC event into the next day at UTC+7", async () => {
    await store({ name: "session_start", device: "d1", session: "s1", level: "1", ts: evening, received: evening });
    expect((await daily(env.DB, "demo", Date.now(), 0))[0].day).toBe(iso(evening));
    expect((await daily(env.DB, "demo", Date.now(), 420))[0].day).toBe(iso(today));
  });

  it("starts the range at local midnight", async () => {
    const now = today + 12 * 3_600_000;
    const firstLocalDay = today - (RANGE_DAYS - 1) * DAY - 420 * 60_000; // 00:00 UTC+7, 29 days back
    await store({ name: "session_start", device: "in", session: "a", level: "1", ts: firstLocalDay, received: now });
    await store({ name: "session_start", device: "out", session: "b", level: "1", ts: firstLocalDay - 1, received: now });
    expect(await daily(env.DB, "demo", now, 420)).toEqual([{ day: iso(today - (RANGE_DAYS - 1) * DAY), players: 1, sessions: 1 }]);
  });

  it("parses tz from the query or cookie and falls back to UTC", () => {
    const tz = (q: string, cookie = "") => tzOffset(new Request(`${BASE}/${q}`, { headers: { Cookie: cookie } }));
    expect(tz("?tz=420")).toBe(420);
    expect(tz("?tz=-480")).toBe(-480);
    expect(tz("", "a=1; tz=330")).toBe(330);
    expect(tz("?tz=420", "tz=60")).toBe(420);
    for (const bad of ["?tz=abc", "?tz=841", "?tz=-721", "?tz=7.5", "?tz=", "?tz=0x1a4"]) expect(tz(bad)).toBe(0);
    expect(tz("", "tz=9999")).toBe(0);
    expect(tzLabel(0)).toBe("UTC");
    expect(tzLabel(420)).toBe("UTC+7");
    expect(tzLabel(330)).toBe("UTC+5:30");
    expect(tzLabel(-480)).toBe("UTC-8");
  });

  it("stores the choice in a cookie and shows local times", async () => {
    await createProject();
    await store({ name: "level_start", device: "d1", session: "s1", level: "1", ts: evening, received: evening });
    const res = await get("/?project=demo&tz=420");
    expect(res.headers.get("Set-Cookie")).toMatch(/^tz=420; Path=\/; Max-Age=31536000; SameSite=Lax/);
    const html = await res.text();
    expect(html).toContain("Times in UTC+7");
    expect(html).toContain('<option value="420" selected>UTC+7 (WIB)</option>');
    expect(html).toContain(new Date(evening + 7 * 3_600_000).toISOString().slice(5, 16).replace("T", " "));
    expect(await (await get("/?project=demo", { ...AUTH, Cookie: "tz=420" })).text()).toContain("Times in UTC+7");
  });

  it("falls back to UTC for an invalid tz", async () => {
    await createProject();
    const res = await get("/?project=demo&tz=nope");
    expect(res.headers.get("Set-Cookie")).toMatch(/^tz=0;/);
    expect(await res.text()).toContain("Times in UTC.");
  });
});

describe("dashboard page", () => {
  it("renders every section and escapes player supplied text", async () => {
    await createProject();
    await post(batch([
      ev({ name: "level_start", level: "1" }),
      ev({ name: "booster_bought", props: { booster: 2, note: "<script>alert(1)</script>" } }),
    ]));
    const html = await (await get("/?project=demo")).text();
    for (const heading of ["Daily players and sessions", "Levels", "Where players quit", "Booster use", "Latest events"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
