import { beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { levelStats } from "../src/queries";
import { BASE, batch, createProject, ev, post, reset } from "./helpers";

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
  it("matches a hand count, inferring quits only for stale unclosed starts", async () => {
    await createProject();
    const now = Date.now();
    const old = now - 60 * 60_000;
    await post(batch([
      ev({ name: "level_start", level: "1", session_id: "s1", ts: old }),
      ev({ name: "level_fail", level: "1", session_id: "s1", ts: old + 1 }),
      ev({ name: "level_start", level: "1", session_id: "s1", ts: old + 2, attempt: 2 }),
      ev({ name: "level_complete", level: "1", session_id: "s1", ts: old + 3, attempt: 2 }),
    ], { device_id: "d1" }));
    await post(batch([
      ev({ name: "level_start", level: "1", session_id: "s2", ts: old }),
      ev({ name: "level_complete", level: "1", session_id: "s2", ts: old + 1 }),
      ev({ name: "level_start", level: "2", session_id: "s2", ts: old + 2 }),
    ], { device_id: "d2" }));
    await post(batch([ev({ name: "level_start", level: "2", session_id: "s3", ts: now - 5 * 60_000 })], { device_id: "d3" }));
    await post(batch([
      ev({ name: "level_start", level: "2", session_id: "s4", ts: old }),
      ev({ name: "level_quit", level: "2", session_id: "s4", ts: old + 1 }),
    ], { device_id: "d4" }));

    const stats = await levelStats(env.DB, "demo", now);
    expect(stats).toEqual([
      { level: "1", starts: 3, wins: 2, losses: 1, quits: 0, winRate: 2 / 3, attemptsPerWin: 1.5 },
      { level: "2", starts: 3, wins: 0, losses: 0, quits: 2, winRate: null, attemptsPerWin: null },
    ]);
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
