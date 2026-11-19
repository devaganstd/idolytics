import { beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { sha256Hex } from "../src/keys";
import { runCron } from "../src/rollup";
import { BASE, batch, createProject, ev, post, reset, rows, WRITE_KEY } from "./helpers";

const AUTH = { Authorization: "Basic " + btoa("admin:test-admin-key") };
const get = (path: string) => exports.default.fetch(new Request(BASE + path, { headers: AUTH }));
const testKey = (project = "demo", origin = BASE) => exports.default.fetch(new Request(`${BASE}/settings/test-key`, {
  method: "POST", headers: { ...AUTH, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: `project=${project}`,
}));
const keyOf = async (res: Response) => (await res.text()).match(/idl_w_[A-Za-z0-9_-]+/)?.[0];

beforeEach(reset);

describe("test and live keys", () => {
  it("copies every existing write key in as a live key", async () => {
    // A project from before 0.2.2 has only projects.write_key_hash.
    await env.DB.prepare("INSERT INTO projects (id, name, created_at, write_key_hash) VALUES ('old', 'old', 1, ?)").bind(await sha256Hex(WRITE_KEY)).run();
    const copy = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0005"))!.queries.find((q) => q.includes("INSERT INTO keys"))!;
    await env.DB.prepare(copy).run();
    expect((await post(batch([ev()]))).status).toBe(202);
    expect((await rows())[0].project_id).toBe("old");
  });

  it("creates a test key that writes to the hidden sibling project", async () => {
    await createProject();
    const res = await testKey();
    expect(res.status).toBe(200);
    const key = (await keyOf(res))!;
    expect(key).toBeTruthy();
    expect((await post(batch([ev({ name: "test_only" })]), key)).status).toBe(202);
    expect((await post(batch([ev({ name: "live_only" })]))).status).toBe(202);
    expect((await rows("SELECT project_id, name FROM events ORDER BY name"))).toEqual([
      { project_id: "demo", name: "live_only" }, { project_id: "demo~test", name: "test_only" },
    ]);
    expect(await env.DB.prepare("SELECT events FROM usage WHERE project_id = 'demo~test'").first()).toEqual({ events: 1 });

    await runCron(env.DB, Date.now() + 120_000);
    const live = await (await get("/events?project=demo")).text();
    expect(live).toContain("live_only");
    expect(live).not.toContain("test_only");
    expect(live).not.toContain("demo~test"); // the sibling is not in the project list
    const test = await (await get("/events?project=demo&env=test")).text();
    expect(test).toContain("test_only");
    expect(test).not.toContain("live_only");
    expect(test).toMatch(/aria-current="page"[^>]*>Test</);
  });

  it("rotates the test key, shows it once and refuses cross origin posts", async () => {
    await createProject();
    const first = (await keyOf(await testKey()))!;
    const second = (await keyOf(await testKey()))!;
    expect(second).not.toBe(first);
    expect((await post(batch([ev()]), first)).status).toBe(401);
    expect((await post(batch([ev()]), second)).status).toBe(202);
    expect((await post(batch([ev()]))).status).toBe(202); // the live key is untouched
    expect(await (await get("/settings?project=demo")).text()).not.toContain(second);
    expect((await testKey("demo", "https://evil.example")).status).toBe(403);
    expect((await testKey("nope")).status).toBe(404);
  });

  it("keeps the sibling on the parent's time zone", async () => {
    await createProject();
    await testKey();
    await exports.default.fetch(new Request(`${BASE}/settings/tz`, {
      method: "POST", redirect: "manual", headers: { ...AUTH, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: "project=demo&tz=420",
    }));
    expect(await rows("SELECT id, tz_min FROM projects ORDER BY id")).toEqual([{ id: "demo", tz_min: 420 }, { id: "demo~test", tz_min: 420 }]);
  });
});
