import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { parseTz, tzLabel } from "../src/dashboard";
import { at, NOW, seed, seedAsPlays, seedEconomy, seedMatch } from "./fixture";
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

  it("gives no key for an id that already exists", async () => {
    await create(BASE);
    const again = await create(BASE);
    expect(again.status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM keys").first())!.n).toBe(1);
  });

  it("refuses cross origin posts and missing auth", async () => {
    expect((await create("https://evil.example")).status).toBe(403);
    expect((await create(BASE, {} as typeof AUTH)).status).toBe(401);
  });
});

const RANGE = "range=custom&from=2026-11-01&to=2026-11-03";
/** Text of each cell in the table row whose first cell reads first. */
const cells = (html: string, first: string) => {
  const row = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => c[1].replace(/<[^>]+>/g, "").trim()))
    .find((r) => r[0] === first);
  return row;
};
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

  it("shows the level table with distinct players and first try win rate", async () => {
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    // Level 1: d1 fails then wins on attempt 2, d2 wins on attempt 1. Level 2: d2 left it, d1 quit it the next day.
    expect(cells(html, "1")).toEqual(["1", "3", "2", "2", "1", "0", "67%", "50%", "1.5", "1m 33s", "2.0", "2.0"]);
    expect(cells(html, "2")).toEqual(["2", "2", "2", "0", "0", "2", "–", "0%", "–", "–", "–", "–"]);
    expect(html).toContain('href="/level?project=demo&amp;range=custom&amp;from=2026-11-01&amp;to=2026-11-03&amp;level=1"');
    expect(html).toMatch(/Quits \(inferred\)/);
  });

  it("sorts the level table by a column", async () => {
    const html = await (await get(`/levels?project=demo&${RANGE}&sort=quits&dir=desc`)).text();
    expect(html.indexOf('level=2"')).toBeLessThan(html.indexOf('level=1"'));
  });

  it("shows the progression funnel", async () => {
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    const funnel = html.slice(html.indexOf("Progression"));
    expect(funnel).toContain("Level 1: 2 players (100%)");
    expect(funnel).toContain("Level 2: 2 players (100%)");
  });

  it("shows a level by day and version, with fail reasons and boosters", async () => {
    await raw({ name: "level_fail", device: "d2", session: "e", ts: at(2, 8, 5), received: at(2, 10), version: "1.1", level: "1", attempt: 2, props: { reason: "out_of_moves" } });
    await raw({ name: "booster_bought", device: "d2", session: "e", ts: at(2, 8, 6), received: at(2, 10), version: "1.1", level: "1", props: { booster: 2 } });
    await rollUp(NOW);
    const html = await (await get(`/level?project=demo&${RANGE}&level=1`)).text();
    expect(cells(html, "11-01")).toEqual(["11-01", "3", "2", "1", "0", "67%"]);
    expect(cells(html, "11-03")).toEqual(["11-03", "0", "0", "1", "0", "0%"]);
    expect(cells(html, "1.1")).toEqual(["1.1", "0", "0", "1", "0", "0%"]);
    expect(html).toContain("level_fail out_of_moves: 1");
    expect(html).toContain("booster_bought 2: 1");
  });
  it("escapes player supplied text", async () => {
    await raw({ name: "tap", device: "d9", session: "x", ts: at(19, 10), props: { note: "<script>alert(1)</script>" } });
    const html = await (await get("/events?project=demo")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("raw filters, events and device pages", () => {
  beforeEach(async () => {
    await createProject();
    await seed();
    await rollUp(NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(20, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("filters the level table on raw events by device", async () => {
    const res = await get(`/levels?project=demo&${RANGE}&device=d1`);
    const html = await res.text();
    expect(html).toContain("Filtered on raw events");
    expect(cells(html, "1")).toEqual(["1", "2", "1", "1", "1", "0", "50%", "0%", "2.0", "1m 50s", "3.0", "2.0"]);
    expect(cells(html, "2")).toEqual(["2", "1", "1", "0", "0", "1", "–", "0%", "–", "–", "–", "–"]);
    expect(Number(res.headers.get("X-D1-Rows-Read"))).toBeGreaterThan(0);
  });

  it("joins property filters with AND", async () => {
    const html = await (await get(`/levels?project=demo&${RANGE}&prop=stars%3D3&prop=moves_left%3D2`)).text();
    expect(cells(html, "1")?.slice(0, 4)).toEqual(["1", "0", "0", "1"]); // only the level_complete matches: no starts, one win
    expect(cells(html, "1")?.[8]).toBe("–"); // attempts per win needs starts
    expect(cells(html, "2")).toBeUndefined();
    const none = await (await get(`/levels?project=demo&${RANGE}&prop=stars%3D3&prop=moves_left%3D9`)).text();
    expect(cells(none, "1")).toBeUndefined();
  });

  it("caps a raw filtered range at 30 days", async () => {
    const html = await (await get("/events?project=demo&range=90&device=d1")).text();
    expect(html).toContain("Filtered on raw events");
    expect(html).toContain("limited to the last 30 days");
  });

  it("counts an event over time from rollups and breaks it down by a property on raw events", async () => {
    const plain = await (await get(`/events?project=demo&${RANGE}&event=session_start`)).text();
    expect(plain).not.toContain("Filtered on raw events");
    expect(plain).toContain("2026-11-01: Events 2");
    expect(plain).toContain("2026-11-03: Events 1");
    const by = await (await get(`/events?project=demo&${RANGE}&event=level_complete&by=stars`)).text();
    expect(by).toContain("Filtered on raw events");
    expect(cells(by, "3")).toEqual(["3", "1"]);
    expect(cells(by, "1")).toEqual(["1", "1"]);
  });

  it("filters the raw tail by name and device and links device ids", async () => {
    const html = await (await get(`/events?project=demo&${RANGE}&event=level_fail`)).text();
    const tail = html.slice(html.indexOf("Latest events"));
    expect((tail.match(/<tr><td>/g) ?? []).length).toBe(1);
    expect(tail).toContain('href="/device?project=demo&amp;range=custom&amp;from=2026-11-01&amp;to=2026-11-03&amp;device=d1"');
    const d3 = await (await get(`/events?project=demo&${RANGE}&device=d3`)).text();
    expect((d3.slice(d3.indexOf("Latest events")).match(/<tr><td>/g) ?? []).length).toBe(1);
  });

  it("shows a device with its days and timeline", async () => {
    const html = await (await get(`/device?project=demo&${RANGE}&device=d1`)).text();
    expect(html).toContain("First day 2026-11-01");
    expect(html).toContain("1.0 · android · ID");
    expect(html).toContain("Last seen 2026-11-02");
    expect(cells(html, "11-02")).toEqual(["11-02", "1", "5m 00s", "4", "2"]);
    expect(cells(html, "11-01")).toEqual(["11-01", "1", "6m 00s", "5", "1"]);
    const timeline = html.slice(html.indexOf("Timeline"));
    expect((timeline.match(/<tr><td>/g) ?? []).length).toBe(9);
    expect(timeline.indexOf("booster_used")).toBeLessThan(timeline.indexOf("session_start"));
  });
});

describe("economy, live and settings", () => {
  beforeEach(async () => {
    await createProject();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(20, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("hides the Levels and Economy tabs until their events arrive", async () => {
    await raw({ name: "session_start", device: "d1", session: "a", ts: at(0, 10) });
    await rollUp(NOW);
    const html = await (await get(`/?project=demo&${RANGE}`)).text();
    expect(html).not.toMatch(/>Levels<\/a>/);
    expect(html).not.toMatch(/>Economy<\/a>/);
    expect(await (await get(`/economy?project=demo&${RANGE}`)).text()).toContain("No economy or ad events in this range.");
    await seed();
    await seedEconomy();
    await rollUp(NOW);
    const after = await (await get(`/?project=demo&${RANGE}`)).text();
    expect(after).toMatch(/>Levels<\/a>/);
    expect(after).toMatch(/>Economy<\/a>/);
  });

  it("shows currency, boosters, ads and ARPDAU from rollups", async () => {
    await seedEconomy();
    await rollUp(NOW);
    const res = await get(`/economy?project=demo&range=custom&from=2026-11-01&to=2026-11-02`);
    const html = await res.text();
    expect(Number(res.headers.get("X-D1-Rows-Read"))).toBeGreaterThan(0);
    expect(cells(html, "coins")).toEqual(["coins", "170", "30"]);
    expect(html).toContain("level_reward: 120");
    expect(html).toContain("daily_gift: 50");
    expect(html).toContain("booster: 30");
    expect(cells(html, "hammer")).toEqual(["hammer", "2", "1"]);
    expect(cells(html, "bomb")).toEqual(["bomb", "1", "0"]);
    expect(cells(html, "free")).toEqual(["free", "0", "1"]);
    expect(cells(html, "interstitial")).toEqual(["interstitial", "2", "0.02"]);
    expect(cells(html, "rewarded")).toEqual(["rewarded", "2", "0.05"]);
    expect(cells(html, "USD")).toEqual(["USD", "1.06", "0.07", "0.99", "0.35"]); // 1.06 over 3 device days
    // A module with no events in the range is hidden.
    const day2 = await (await get(`/economy?project=demo&range=custom&from=2026-11-02&to=2026-11-02`)).text();
    expect(day2).toContain("Currency");
    expect(day2).not.toContain("Boosters");
    expect(day2).not.toContain("Ads");
  });

  it("shows the last 30 minutes from raw rows", async () => {
    const now = at(20, 12);
    await raw({ name: "tap", device: "d1", session: "a", ts: now - 5 * 60_000 });
    await raw({ name: "tap", device: "d1", session: "a", ts: now - 6 * 60_000 });
    await raw({ name: "level_start", device: "d2", session: "b", ts: now - 20 * 60_000, level: "4" });
    await raw({ name: "tap", device: "d3", session: "c", ts: now - 40 * 60_000 });
    const res = await get("/live?project=demo");
    const html = await res.text();
    expect(html).toMatch(/data-kpi="devices"[^>]*><h3>[^<]*<\/h3><p class="value">2</);
    expect(html).toMatch(/data-kpi="events"[^>]*><h3>[^<]*<\/h3><p class="value">3</);
    expect((html.slice(html.indexOf("Newest events")).match(/<tr><td>/g) ?? []).length).toBe(3);
    expect(Number(res.headers.get("X-D1-Rows-Read"))).toBeLessThan(20);
  });

  it("shows projects, the daily cap with today's usage and a D1 estimate", async () => {
    await env.DB.prepare("INSERT INTO usage (project_id, day, events) VALUES ('demo', '2026-11-21', 40)").run();
    const html = await (await get("/settings?project=demo")).text();
    expect(cells(html, "demo")?.slice(0, 2)).toEqual(["demo", "demo"]);
    expect(html).toContain("40 of 50 events today");
    expect(html).toMatch(/class="meter warn"/); // 80% of the cap
    expect(html).toContain("Estimated D1 rows written today");
    expect(html).toContain("Reporting time zone");
    expect(html).toContain("Create test key");
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

  it("accepts a same-origin browser post that sends Origin: null, and refuses Origin: null alone", async () => {
    await createProject();
    const post = (extra: Record<string, string>) => exports.default.fetch(new Request(`${BASE}/settings/tz`, {
      method: "POST", redirect: "manual",
      headers: { ...AUTH, Origin: "null", "Content-Type": "application/x-www-form-urlencoded", ...extra }, body: "project=demo&tz=420",
    }));
    expect((await post({})).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
    expect(await env.DB.prepare("SELECT tz_min FROM projects").first()).toEqual({ tz_min: 420 });
  });

  it("refuses an invalid zone, a cross origin post and an outside redirect", async () => {
    await createProject();
    expect((await save("project=demo&tz=nope")).status).toBe(400);
    expect((await save("project=demo&tz=60", "https://evil.example")).status).toBe(403);
    expect((await save("project=demo&tz=60&back=//evil.example")).headers.get("Location")).toBe("/");
    expect((await save("project=demo&tz=60&back=%2F%09%2Fevil.example")).headers.get("Location")).toBe("/");
  });
});

describe("game profiles: plays, progress, content and flows", () => {
  beforeEach(async () => {
    await createProject();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(20, 12));
  });
  afterEach(() => vi.useRealTimers());
  const section = (html: string, heading: string) => html.slice(html.indexOf(`<h2>${heading}`));

  it("keeps the 0.2.1 Levels numbers for Ninja Smash shaped data and hides the new pages", async () => {
    await seed();
    await rollUp(NOW);
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    expect(cells(html, "1")).toEqual(["1", "3", "2", "2", "1", "0", "67%", "50%", "1.5", "1m 33s", "2.0", "2.0"]);
    expect(cells(html, "2")).toEqual(["2", "2", "2", "0", "0", "2", "–", "0%", "–", "–", "–", "–"]);
    expect(html).toMatch(/>Levels<\/a>/);
    for (const tab of ["Progress", "Content", "Flows"]) expect(html).not.toMatch(new RegExp(`>${tab}</a>`));
  });

  it("shows the same Levels numbers when the game sends play_start and play_end", async () => {
    await seedAsPlays();
    await rollUp(NOW);
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    expect(cells(html, "1")).toEqual(["1", "3", "2", "2", "1", "0", "67%", "50%", "1.5", "1m 33s", "2.0", "2.0"]);
    expect(cells(html, "2")).toEqual(["2", "2", "2", "0", "0", "2", "–", "0%", "–", "–", "–", "–"]);
    // The same through the raw path.
    const raw = await (await get(`/levels?project=demo&${RANGE}&prop=kind%3Dlevel`)).text();
    expect(cells(raw, "1")?.slice(0, 6)).toEqual(["1", "3", "2", "2", "1", "0"]);
  });

  it("labels the plays page from the profile and adds draws, abandons and breakdowns", async () => {
    await seedMatch();
    await rollUp(NOW);
    const html = await (await get(`/levels?project=demo&${RANGE}`)).text();
    for (const tab of ["Matches", "Progress", "Content", "Flows"]) expect(html).toMatch(new RegExp(`>${tab}</a>`));
    expect(html).toContain("<h2>Matches</h2>");
    expect(cells(html, "Board ↑")).toEqual(["Board", "Starts", "Players", "Wins", "Losses", "Quits (inferred)", "Draws", "Abandons",
      "Win rate", "First try win rate", "Attempts per win", "Avg duration"].map((c, i) => (i === 0 ? c + " ↑" : c)));
    expect(cells(html, "hourglass")).toEqual(["hourglass", "3", "1", "1", "1", "1", "0", "0", "50%", "100%", "3.0", "1m 00s"]);
    expect(cells(html, "ring")).toEqual(["ring", "2", "2", "1", "0", "0", "1", "0", "100%", "–", "2.0", "1m 00s"]);
    expect(cells(html, "delta")).toEqual(["delta", "2", "1", "0", "1", "0", "0", "1", "0%", "–", "–", "1m 00s"]);
    const diff = section(html, "By difficulty");
    expect(cells(diff, "easy")).toEqual(["easy", "3", "2", "0", "1", "0", "0", "100%"]);
    expect(cells(diff, "normal")).toEqual(["normal", "2", "0", "2", "0", "0", "0", "0%"]);
    expect(cells(diff, "hard")).toEqual(["hard", "2", "0", "0", "0", "1", "1", "–"]);
    expect(cells(section(html, "By mode"), "normal")).toEqual(["normal", "7", "2", "2", "1", "1", "1", "50%"]);
    expect(cells(section(html, "By opponent"), "bot")).toEqual(["bot", "6", "2", "2", "1", "50%"]);
    expect(html).not.toContain("Progression"); // the level funnel is for levels only
  });

  it("shows pick rate and win rate per dimension value", async () => {
    await seedMatch();
    await rollUp(NOW);
    const res = await get(`/content?project=demo&${RANGE}&dim=deck`);
    expect(Number(res.headers.get("X-D1-Rows-Read"))).toBeGreaterThan(0);
    const html = await res.text();
    expect(html).toMatch(/aria-current="page"[^>]*>Card</);
    expect(cells(html, "burst")).toEqual(["burst", "6", "100%", "3", "2", "2", "1", "50%", "0.58"]); // player days: m1 11-01, m2 11-01 and 11-02
    expect(cells(html, "wall")).toEqual(["wall", "3", "50%", "1", "1", "1", "1", "50%", "0.60"]);
    expect(html.indexOf(">burst<")).toBeLessThan(html.indexOf(">wall<"));
    const diff = await (await get(`/content?project=demo&${RANGE}&dim=difficulty`)).text();
    expect(cells(diff, "easy")).toEqual(["easy", "2", "33%", "2", "2", "0", "0", "100%", "0.85"]);
  });

  it("shows players along each track, time to each milestone and where they stop", async () => {
    await seedMatch();
    await rollUp(NOW);
    const html = await (await get(`/progress?project=demo&${RANGE}`)).text();
    const trophies = section(html, "Trophies");
    expect(cells(trophies, "Below 300")).toEqual(["Below 300", "2", "–", "–", "–"]);
    expect(cells(trophies, "300+")).toEqual(["300+", "1", "1", "0.0", "0"]);
    expect(cells(trophies, "800+")).toEqual(["800+", "1", "1", "1.0", "1"]);
    expect(cells(trophies, "1500+")).toEqual(["1500+", "0", "0", "–", "0"]);
    expect(cells(section(html, "Arena"), "3+")).toEqual(["3+", "1", "1", "1.0", "1"]);
  });

  it("shows a step funnel per flow, with tutorial events as the flow tutorial", async () => {
    await seedMatch();
    await rollUp(NOW);
    const html = await (await get(`/flows?project=demo&${RANGE}`)).text();
    const t1 = section(html, "tutorial1");
    expect(cells(t1, "1")).toEqual(["1", "2", "–", "6s"]);
    expect(cells(t1, "2")).toEqual(["2", "2", "0%", "9s"]);
    expect(cells(t1, "3")).toEqual(["3", "1", "50%", "4s"]);
    const t = section(html, "tutorial<");
    expect(cells(t, "Begin")).toEqual(["Begin", "1", "–", "–"]);
    expect(cells(t, "Complete")).toEqual(["Complete", "1", "0%", "2m 00s"]);
  });

  it("shows the detected preset and saves a profile, which rebuilds the rollups", async () => {
    await seedMatch();
    await rollUp(NOW);
    vi.setSystemTime(NOW); // suggestions read the last 7 days of raw events
    const html = await (await get("/settings?project=demo")).text();
    expect(html).toContain("Detected: match_battle");
    expect(html).toMatch(/Suggested dimensions:[^<]*deck/);
    const save = (body: string, origin = BASE) => exports.default.fetch(new Request(`${BASE}/settings/profile`, {
      method: "POST", redirect: "manual", headers: { ...AUTH, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body,
    }));
    expect((await save("project=demo&preset=run_roguelike")).status).toBe(303);
    const p = await env.DB.prepare("SELECT profile, tz_min, rollup_tz FROM projects").first<{ profile: string; tz_min: number; rollup_tz: number }>();
    expect(JSON.parse(p!.profile)).toMatchObject({ preset: "run_roguelike", play_label: "Run" });
    expect(p!.rollup_tz).not.toBe(p!.tz_min);
    const custom = JSON.stringify({ preset: "match_battle", play_label: "Duel", play_kinds: ["match"], dimensions: [{ key: "deck", multi: true }] });
    expect((await save(`project=demo&profile=${encodeURIComponent(custom)}`)).status).toBe(303);
    expect(JSON.parse((await env.DB.prepare("SELECT profile FROM projects").first<{ profile: string }>())!.profile)).toMatchObject({ play_label: "Duel" });
    expect((await save("project=demo&profile=%7Bnope")).status).toBe(400);
    expect((await save(`project=demo&profile=${encodeURIComponent(JSON.stringify({ dimensions: "x" }))}`)).status).toBe(400);
    expect((await save("project=demo&preset=run_roguelike", "https://evil.example")).status).toBe(403);
  });
});
