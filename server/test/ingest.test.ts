import { beforeEach, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { BASE, batch, createProject, ev, post, reset, rows, WRITE_KEY } from "./helpers";

beforeEach(async () => {
  await reset();
  await createProject();
});

describe("POST /v1/events", () => {
  it("accepts a valid batch and stores level fields as columns", async () => {
    const res = await post(batch([
      ev({ name: "level_complete", level: "3", attempt: 2, duration_ms: 41000, value: 120, props: { moves_left: 2, stars: 3 } }),
      ev({ name: "booster_bought", props: { booster: 1 } }),
    ]));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, rejected: 0 });
    const r = await rows();
    expect(r).toHaveLength(2);
    const win = r.find((x) => x.name === "level_complete")!;
    expect(win).toMatchObject({ project_id: "demo", device_id: "d1", session_id: "s1", level: "3", attempt: 2, duration_ms: 41000, value: 120, app_version: "1.0.0", platform: "webgl" });
    expect(JSON.parse(win.props as string)).toEqual({ moves_left: 2, stars: 3 });
    expect(win.received_at).toBeTypeOf("number");
  });

  it("returns CORS headers so a WebGL build can read the response", async () => {
    const res = await post(batch([ev()]));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers the CORS preflight", async () => {
    const res = await exports.default.fetch(new Request(`${BASE}/v1/events`, {
      method: "OPTIONS",
      headers: { Origin: "https://games.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")!.toLowerCase()).toContain("authorization");
  });

  it("does not insert a replayed batch twice", async () => {
    const b = batch([ev(), ev()]);
    await post(b);
    const res = await post(b);
    expect(res.status).toBe(202);
    expect(await rows()).toHaveLength(2);
  });

  it("rejects a missing or wrong write key", async () => {
    expect((await post(batch([ev()]), null)).status).toBe(401);
    expect((await post(batch([ev()]), "idl_w_wrong")).status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects bodies over 64 KB", async () => {
    const res = await post(null, WRITE_KEY, JSON.stringify(batch([ev({ props: { pad: "x".repeat(70_000) } })])));
    expect(res.status).toBe(413);
  });

  it("rejects malformed batches", async () => {
    expect((await post(null, WRITE_KEY, "{not json")).status).toBe(400);
    expect((await post({ events: "nope", device_id: "d1" })).status).toBe(400);
    expect((await post(batch([ev()], { device_id: undefined }))).status).toBe(400);
    expect((await post(batch(Array.from({ length: 101 }, () => ev())))).status).toBe(400);
  });

  it("rejects bad events one by one and keeps the rest", async () => {
    const now = Date.now();
    const bad = [
      ev({ name: "Level Start" }),
      ev({ name: "idl_internal" }),
      ev({ event_id: undefined }),
      ev({ ts: undefined }),
      ev({ session_id: undefined }),
      ev({ props: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, i])) }),
      ev({ props: { nested: { a: 1 } } }),
      ev({ props: { list: [1, 2] } }),
      ev({ props: { long: "x".repeat(101) } }),
      ev({ props: { email: "a" } }),
      ev({ props: { name: "Budi" } }),
      ev({ props: { phone: "1" } }),
      ev({ props: { contact: "budi@example.com" } }),
      ev({ props: { "Bad Key": 1 } }),
      ev({ props: { player_name: "Budi" } }),
      ev({ props: { e_mail: "x" } }),
      ev({ props: { phone_number: "1" } }),
      ev({ user_id: "budi@example.com" }),
    ];
    const res = await post(batch([...bad, ev({ name: "custom_ok", props: { ok: true, n: 1.5, s: "fine", step_name: "intro" } })]));
    expect(await res.json()).toEqual({ accepted: 1, rejected: bad.length });
    const r = await rows();
    expect(r.map((x) => x.name)).toEqual(["custom_ok"]);
  });

  it("keeps events with bad optional numbers or clock, fixing the field", async () => {
    const now = Date.now();
    const res = await post(batch([
      ev({ event_id: "neg", duration_ms: -5, attempt: 2 }),
      ev({ event_id: "frac", attempt: 1.5, duration_ms: "slow" }),
      ev({ event_id: "past", ts: now - 31 * 86_400_000 }),
      ev({ event_id: "future", ts: now + 2 * 86_400_000 }),
    ]));
    expect(await res.json()).toEqual({ accepted: 4, rejected: 0 });
    const r = Object.fromEntries((await rows()).map((x) => [x.event_id, x]));
    expect(r.neg).toMatchObject({ duration_ms: null, attempt: 2 });
    expect(r.frac).toMatchObject({ duration_ms: null, attempt: null });
    for (const id of ["past", "future"]) expect(r[id].client_ts).toBe(r[id].received_at);
  });

  it("answers 429 and stores nothing once the project hits its daily cap", async () => {
    // vitest.config.ts sets DAILY_EVENT_CAP to 50.
    const full = await post(batch(Array.from({ length: 50 }, () => ev())));
    expect(full.status).toBe(202);
    const over = await post(batch([ev()]));
    expect(over.status).toBe(429);
    const retry = Number(over.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(await rows()).toHaveLength(50);
  });

  it("never stores the IP address", async () => {
    await exports.default.fetch(new Request(`${BASE}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WRITE_KEY}`, "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify(batch([ev()])),
    }));
    expect(JSON.stringify(await rows())).not.toContain("203.0.113.9");
  });
});
