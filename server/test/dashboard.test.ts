import { beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { boosters, levelStats } from "../src/queries";
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
