import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { parseTz, tzLabel } from "../src/dashboard";
import { at, NOW, seed } from "./fixture";
import { BASE, batch, createProject, ev, post, raw, reset, rollUp } from "./helpers";

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

const RANGE = "range=custom&from=2026-11-01&to=2026-11-03";
const kpi = (html: string, key: string) => html.match(new RegExp(`data-kpi="${key}"[^>]*><h3>[^<]*</h3><p class="value">([^<]*)<`))?.[1];

describe("dashboard pages", () => {
  beforeEach(async () => {
    await createProject();
    await seed();
    await rollUp(NOW);
    // Every page but Events must work from rollups alone.
    await env.DB.prepare("DELETE FROM events").run();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(20, 12)); // 2026-11-21
  });
  afterEach(() => vi.useRealTimers());

  it("shows hand counted KPIs from rollups only", async () => {
    const res = await get(`/?project=demo&${RANGE}`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("X-D1-Rows-Read"))).toBeGreaterThan(0);
    const html = await res.text();
    expect(kpi(html, "dau")).toBe("1.7"); // 5 device days / 3 days
    expect(kpi(html, "newUsers")).toBe("3");
    expect(kpi(html, "sessions")).toBe("5");
    expect(kpi(html, "sessionLength")).toBe("2m 48s"); // 14 minutes / 5 sessions
    expect(kpi(html, "playtimePerUser")).toBe("4m 40s"); // 14 minutes / 3 players
    expect(kpi(html, "d1")).toBe("33%"); // d1 back on day 1 of 3 installs
    expect(kpi(html, "d7")).toBe("0%");
    expect(kpi(html, "stickiness")).toBe("56%"); // 1.67 / 3
    expect(html).toContain("No data for the previous 3 days");
    expect(html).toContain('href="/?project=demo&amp;range=custom&amp;from=2026-11-02&amp;to=2026-11-02"');
    expect(html).toMatch(/<td>2<\/td><td>2<\/td><td>2<\/td><td>100%<\/td>/); // level 2: 2 starts, 2 quits
  });

  it("applies the platform and players filters", async () => {
    const ios = await (await get(`/?project=demo&${RANGE}&p=ios`)).text();
    expect(kpi(ios, "dau")).toBe("0.7"); // 2 device days / 3 days
    expect(kpi(ios, "newUsers")).toBe("1");
    const returning = await (await get(`/?project=demo&${RANGE}&who=returning`)).text();
    expect(kpi(returning, "newUsers")).toBe("0");
    expect(kpi(returning, "sessions")).toBe("2");
  });

  it("compares with the previous period", async () => {
    const html = await (await get("/?project=demo&range=custom&from=2026-11-02&to=2026-11-03")).text();
    expect(kpi(html, "dau")).toBe("1.5");
    // Previous period 10-31 to 11-01: 2 device days, so DAU 1; new users 2 against 1 now.
    expect(html).toMatch(/data-kpi="dau".*?▲ 50% vs previous 2 days/s);
    expect(html).toMatch(/data-kpi="newUsers".*?▼ 50% vs previous 2 days/s);
  });

  it("shows the retention cohorts with unfinished days marked", async () => {
    const html = await (await get(`/retention?project=demo&${RANGE}`)).text();
    expect(kpi(html, "d1")).toBe("33%");
    const row = html.match(/<tr><th scope="row">11-01<\/th>.*?<\/tr>/s)![0];
    expect(row).toContain("<td>2</td>");
    expect([...row.matchAll(/>(\d+)%</g)].slice(0, 4).map((m) => m[1])).toEqual(["100", "50", "50", "0"]);
    expect((row.match(/class="incomplete"/g) ?? []).length).toBe(11); // D20 to D30, as today is 11-21
  });

  it("shows the level table", async () => {
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    expect(html).toContain("<td>1</td><td>3</td><td>2</td><td>1</td><td>0</td>");
    expect(html).toContain("<td>67%</td><td>1.5</td>");
    expect(html).toContain("1m 33s"); // (120 + 100 + 60) s / 3
  });

  it("escapes player supplied text", async () => {
    await raw({ name: "tap", device: "d9", session: "x", ts: at(19, 10), props: { note: "<script>alert(1)</script>" } });
    const html = await (await get("/events?project=demo")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("reporting time zone", () => {
  const save = (body: string, origin = BASE) => exports.default.fetch(new Request(`${BASE}/settings/tz`, {
    method: "POST", redirect: "manual",
    headers: { ...AUTH, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body,
  }));

  it("parses and labels fixed offsets", () => {
    expect(parseTz("420")).toBe(420);
    expect(parseTz("-480")).toBe(-480);
    for (const bad of ["abc", "841", "-721", "7.5", "", "0x1a4", null]) expect(parseTz(bad)).toBe(null);
    expect(tzLabel(0)).toBe("UTC");
    expect(tzLabel(420)).toBe("UTC+7");
    expect(tzLabel(330)).toBe("UTC+5:30");
    expect(tzLabel(-480)).toBe("UTC-8");
  });

  it("saves the project setting and shows the rebuild banner", async () => {
    await createProject();
    const res = await save("project=demo&tz=420&back=%2Fretention%3Fproject%3Ddemo");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/retention?project=demo");
    expect(await env.DB.prepare("SELECT tz_min, rollup_tz FROM projects").first()).toEqual({ tz_min: 420, rollup_tz: 0 });
    const html = await (await get("/?project=demo")).text();
    expect(html).toContain('<option value="420" selected>UTC+7 (WIB)</option>');
    expect(html).toContain("being rebuilt");
    expect(html).toContain("midnight to midnight in UTC+7");
  });

  it("refuses an invalid zone, a cross origin post and an outside redirect", async () => {
    await createProject();
    expect((await save("project=demo&tz=nope")).status).toBe(400);
    expect((await save("project=demo&tz=60", "https://evil.example")).status).toBe(403);
    expect((await save("project=demo&tz=60&back=//evil.example")).headers.get("Location")).toBe("/");
  });
});
