import { esc } from "./html";
import { dailyCap } from "./ingest";
import { newWriteKey, safeEqual, sha256Hex } from "./keys";
import {
  cohortTable, devicePage, economy, eventsPage, type Filters, type Kpis, levelDetail, type LevelRow, levelTable, live, LIVE_MS, overview,
  parseFilters, RANGES, RAW_MAX_DAYS, type TailRow, usageToday,
} from "./queries";
import { dayOf, QUIT_AFTER_MS } from "./rollup";
import { barList, dayBars } from "./svg";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  // same-origin, not no-referrer: with no-referrer browsers send Origin: null on the dashboard's own form posts.
  "Referrer-Policy": "same-origin",
};

/** HTTP Basic: any user name, the admin key as password. Returns null when authorised. */
export async function checkAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!env.ADMIN_KEY) return new Response("ADMIN_KEY is not set. Run: npx wrangler secret put ADMIN_KEY", { status: 500 });
  const auth = request.headers.get("Authorization") ?? "";
  let pass = "";
  try {
    pass = auth.startsWith("Basic ") ? atob(auth.slice(6)).split(":").slice(1).join(":") : "";
  } catch {
    // Malformed base64 is treated as no password.
  }
  if (pass && (await safeEqual(pass, env.ADMIN_KEY))) return null;
  return new Response("Admin key required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="idolytics", charset="UTF-8"' } });
}

/** A form post from this dashboard: the browser says same-origin, or the Origin matches. Origin: null alone is refused. */
const sameOrigin = (request: Request) =>
  request.headers.get("Sec-Fetch-Site") === "same-origin" || request.headers.get("Origin") === new URL(request.url).origin;

export async function createProject(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Cross origin form refused", { status: 403 });
  const form = await request.formData();
  const id = String(form.get("id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim() || id;
  const back = `<p><a href="/">Back</a></p>`;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || name.length > 80) {
    return page("New project", `<section><p class="error">The id must be 1 to 40 lowercase letters, digits or dashes.</p>${back}</section>`, 400);
  }
  const key = newWriteKey();
  const hash = await sha256Hex(key);
  const [res] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO projects (id, name, created_at, write_key_hash) VALUES (?, ?, ?, ?)").bind(id, name, Date.now(), hash),
    env.DB.prepare("INSERT INTO keys (key_hash, project_id, env) SELECT ?1, ?2, 'live' WHERE changes() > 0").bind(hash, id),
  ]);
  if (!res.meta.changes) return page("New project", `<section><p class="error">A project with id ${esc(id)} already exists.</p>${back}</section>`, 409);
  return page("Project created", `<section><h2>${esc(name)} is ready</h2>
    <p>Copy the write key now. It is shown once and stored only as a hash.</p>
    <pre class="key">${esc(key)}</pre>
    <p>Put it, with this server's URL, into the idolytics Settings asset in Unity.</p>
    <p><a href="/?project=${encodeURIComponent(id)}">Open the dashboard</a></p></section>`);
}

// shortcut: fixed offsets only, no DST; switch to IANA zones if a DST-region studio adopts it
const TZ_CHOICES = [...Array.from({ length: 21 }, (_, i) => (i - 8) * 60), 330].sort((a, b) => a - b);
const TZ_NAMES: Record<number, string> = { 420: "WIB", 480: "WITA", 540: "WIT" };

/** A reporting time zone in minutes east of UTC: an integer in -720..840, else null. */
export function parseTz(raw: string | null): number | null {
  const n = raw && /^-?\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  return n >= -720 && n <= 840 ? n : null;
}

export function tzLabel(min: number): string {
  if (!min) return "UTC";
  const a = Math.abs(min);
  return `UTC${min < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`;
}

/** POST /settings/tz: sets a project's reporting time zone. The cron then rebuilds the last 90 days. */
export async function setTimezone(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Cross origin form refused", { status: 403 });
  const form = await request.formData();
  const tz = parseTz(String(form.get("tz") ?? ""));
  if (tz === null) return new Response("Time zone must be minutes from -720 to 840", { status: 400 });
  // The test sibling follows its project.
  await env.DB.prepare("UPDATE projects SET tz_min = ?1 WHERE id IN (?2, ?2 || '~test')").bind(tz, String(form.get("project") ?? "")).run();
  const back = String(form.get("back") ?? "/");
  return new Response(null, { status: 303, headers: { Location: /^\/(?![/\\])[^\x00-\x1f]*$/.test(back) ? back : "/" } });
}

/**
 * POST /settings/test-key: creates or rotates a project's test key. Test events go to the hidden sibling
 * project "<id>~test", created here on the first key with the parent's time zone. The key is shown once.
 */
export async function createTestKey(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Cross origin form refused", { status: 403 });
  const id = String((await request.formData()).get("project") ?? "");
  const parent = id.includes("~") ? null : await env.DB.prepare("SELECT id, name FROM projects WHERE id = ?").bind(id).first<{ id: string; name: string }>();
  if (!parent) return new Response("Unknown project", { status: 404 });
  const key = newWriteKey();
  await env.DB.batch([
    // write_key_hash is unused for siblings since keys came in; it only has to be unique.
    env.DB.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, write_key_hash, tz_min, rollup_tz)
      SELECT id || '~test', name || ' (test)', ?2, 'sibling:' || id, tz_min, tz_min FROM projects WHERE id = ?1`).bind(id, Date.now()),
    env.DB.prepare("DELETE FROM keys WHERE project_id = ? AND env = 'test'").bind(id),
    env.DB.prepare("INSERT INTO keys (key_hash, project_id, env) VALUES (?, ?, 'test')").bind(await sha256Hex(key), id),
  ]);
  return page("Test key", `<section><h2>Test key for ${esc(parent.name)}</h2>
    <p>Copy the test key now. It is shown once and stored only as a hash. Any earlier test key no longer works.</p>
    <pre class="key">${esc(key)}</pre>
    <p>Put it in the IdolyticsSettings asset of Editor and development builds. Its events show under Test, never under Live.</p>
    <p><a href="/?project=${encodeURIComponent(id)}&amp;env=test">Open the test data</a></p></section>`);
}

interface Proj { id: string; name: string; tz_min: number; rollup_tz: number; wm_at: number; rebuild_until: number | null; created_at: number }
const PAGES: Record<string, string> = {
  "/": "Overview", "/retention": "Retention", "/levels": "Levels", "/economy": "Economy", "/events": "Events", "/live": "Live", "/settings": "Settings",
};
/** Tabs of modules that show only once the project has their events. */
const MODULES: Record<string, "levels" | "economy"> = { "/levels": "levels", "/economy": "economy" };
/** Pages without the filter bar. */
const NO_FILTERS = new Set(["/live", "/settings"]);
/** Detail pages, linked from the tables; no tab of their own. */
const DETAIL = new Set(["/level", "/device"]);
/** Pages where the device, event and property filters read raw events. */
const RAW_PAGES = new Set(["/levels", "/events", "/device"]);
export const isPage = (path: string) => path in PAGES || DETAIL.has(path);

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const num = (v: number | null) => (v === null ? "–" : compact.format(v));
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const dur = (ms: number | null) => {
  if (ms === null) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
};
const short = (day: string) => day.slice(5);

export async function dashboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rows = (await env.DB.prepare("SELECT id, name, tz_min, rollup_tz, wm_at, rebuild_until, created_at FROM projects ORDER BY created_at").all<Proj>()).results;
  // Test siblings ("<id>~test") never show in the project list.
  const all = rows.filter((p) => !p.id.includes("~"));
  const current = all.find((p) => p.id === url.searchParams.get("project")) ?? all[0];
  const newForm = `<details${all.length ? "" : " open"}><summary>New project</summary>
    <form method="post" action="/projects"><label>Id <input name="id" required maxlength="40" placeholder="my-game"></label>
    <label>Name <input name="name" maxlength="80" placeholder="My Game"></label><button>Create</button></form></details>`;
  if (!current) return page("idolytics", `<section><p>No projects yet. Create one to get a write key.</p>${newForm}</section>`);

  const now = Date.now();
  const testEnv = url.searchParams.get("env") === "test";
  const sibling = rows.find((p) => p.id === `${current.id}~test`);
  /** The project whose data this page shows: the test sibling under Test. */
  const data = testEnv ? sibling : current;
  const pid = data?.id ?? "";
  const tz = current.tz_min;
  const today = dayOf(now, tz);
  const f = parseFilters(url.searchParams, today, RAW_PAGES.has(url.pathname));
  /** This page's URL with some params changed; null removes one. */
  const link = (over: Record<string, string | null>, path = url.pathname) => {
    const q = new URLSearchParams(url.search);
    q.set("project", current.id);
    for (const [k, v] of Object.entries(over)) { if (v === null) q.delete(k); else q.set(k, v); }
    return `${path}?${q}`;
  };
  const projects = all.map((p) => `<a href="${esc(link({ project: p.id }))}"${p === current ? ' aria-current="page"' : ""}>${esc(p.name)}</a>`).join("");
  const envSwitch = `<nav class="env" aria-label="Data"><a href="${esc(link({ env: null }))}"${testEnv ? "" : ' aria-current="page"'}>Live</a><a href="${
    esc(link({ env: "test" }))}"${testEnv ? ' aria-current="page"' : ""}>Test</a></nav>`;
  const PAGE_ONLY = { by: null, sort: null, dir: null, level: null };
  const mod = pid ? await env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM level_days WHERE project_id = ?1) AS levels,
    EXISTS (SELECT 1 FROM econ_days WHERE project_id = ?1) AS economy`).bind(pid).run<{ levels: number; economy: number }>() : null;
  const tabs = Object.entries(PAGES).filter(([path]) => !MODULES[path] || path === url.pathname || mod?.results[0]?.[MODULES[path]])
    .map(([path, label]) => `<a href="${esc(link(PAGE_ONLY, path))}"${path === url.pathname ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const deviceHref = (id: string) => link({ ...PAGE_ONLY, event: null, prop: null, device: id }, "/device");
  const dayHref = (d: string) => link({ range: "custom", from: d, to: d });
  const zone = tzLabel(tz);
  const tzForm = `<form method="post" action="/settings/tz" class="tz"><input type="hidden" name="project" value="${esc(current.id)}">
    <input type="hidden" name="back" value="${esc(url.pathname + url.search)}">
    <label>Reporting time zone <select name="tz">${[...new Set([...TZ_CHOICES, tz])].sort((a, b) => a - b).map((m) =>
      `<option value="${m}"${m === tz ? " selected" : ""}>${tzLabel(m)}${TZ_NAMES[m] ? ` (${TZ_NAMES[m]})` : ""}</option>`).join("")}</select></label>
    <button>Save</button></form>`;
  const rebuilding = data && (data.tz_min !== data.rollup_tz || data.rebuild_until !== null)
    ? `<p class="banner">The last 90 days are being rebuilt in the background, after a time zone change or an update. Recent numbers may be incomplete for a while.</p>` : "";
  const fresh = data?.wm_at
    ? `Rolled up to ${new Date(data.wm_at + tz * 60_000).toISOString().slice(5, 16).replace("T", " ")} ${zone}. Updates every 15 minutes.`
    : "No events rolled up yet. Numbers appear within 15 minutes of the first event.";

  let body: string, rowsRead: number, options = { versions: [] as string[], countries: [] as string[], platforms: ["android", "ios", "webgl", "editor"] };
  if (url.pathname === "/settings") {
    const u = await usageToday(env.DB, new Date(now).toISOString().slice(0, 10), all.map((p) => p.id));
    rowsRead = u.rowsRead;
    body = settingsBody(all, rows, current, u, dailyCap(env), tzForm);
  } else if (!data) {
    rowsRead = 0;
    body = `<section><p class="empty">No test key yet. Create one in <a href="${esc(link({ env: null }, "/settings"))}">Settings</a>; its events show here.</p></section>`;
  } else if (url.pathname === "/live") {
    const r = await live(env.DB, pid, now);
    rowsRead = r.rowsRead;
    body = liveBody(r, zone, tz, deviceHref);
  } else if (url.pathname === "/economy") {
    const r = await economy(env.DB, pid, f);
    rowsRead = r.rowsRead;
    body = economyBody(r, dayHref);
  } else if (url.pathname === "/retention") {
    const r = await cohortTable(env.DB, pid, f, today);
    rowsRead = r.rowsRead;
    body = retentionBody(r);
  } else if (url.pathname === "/levels") {
    const r = await levelTable(env.DB, pid, f, tz, now);
    rowsRead = r.rowsRead;
    const sort = url.searchParams.get("sort") ?? "level", dir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
    body = levelsBody(r.levels, sort, dir, (over) => link(over), (l) => link({ sort: null, dir: null, level: l }, "/level"));
  } else if (url.pathname === "/level") {
    const level = url.searchParams.get("level") ?? "";
    if (!level || level.length > 64) { rowsRead = 0; body = `<section><p class="empty">Pick a level on the Levels page.</p></section>`; }
    else {
      const r = await levelDetail(env.DB, pid, f, level);
      rowsRead = r.rowsRead;
      body = levelDetailBody(level, r);
    }
  } else if (url.pathname === "/events") {
    const r = await eventsPage(env.DB, pid, f, tz);
    rowsRead = r.rowsRead;
    body = eventsBody(r, f, zone, tz, dayHref, deviceHref);
  } else if (url.pathname === "/device") {
    if (!f.device) { rowsRead = 0; body = `<section><p class="empty">Enter a device id in Filters, or open one from the Events page.</p></section>`; }
    else {
      const r = await devicePage(env.DB, pid, f, tz, f.device);
      rowsRead = r.rowsRead;
      body = deviceBody(f.device, r, zone, tz);
    }
  } else {
    const o = await overview(env.DB, pid, f, today);
    rowsRead = o.rowsRead;
    options = o.options;
    body = overviewBody(o, f, dayHref, link(PAGE_ONLY, "/levels"));
  }
  const rawSet = !!(f.device || f.events.length || f.props.length);
  const filterNote = [
    (f.c || f.who !== "all") && url.pathname !== "/" && url.pathname !== "/retention" ? "Country and new or returning players do not filter this page." : "",
    rawSet && !RAW_PAGES.has(url.pathname) ? "Device, event and property filters apply to the Levels, Events and Device pages only." : "",
    f.events.length && url.pathname === "/levels" ? "The event filter does not apply to levels." : "",
  ].filter(Boolean).map((n) => `<p class="note">${n}</p>`).join("");
  const rawBanner = f.raw ? `<p class="banner">Filtered on raw events${f.capped ? `, limited to the last ${RAW_MAX_DAYS} days of the range` : ""}.
    Days here are by arrival time, and raw events are kept for 90 days.</p>` : "";

  const html = `<nav class="projects">${projects}${newForm}</nav>${envSwitch}
    <nav class="tabs" aria-label="Pages">${tabs}</nav>
    ${NO_FILTERS.has(url.pathname) ? "" : filterBar(f, url.pathname, current.id, testEnv, options)}
    ${rebuilding}${rawBanner}<p class="note">${fresh} Days run midnight to midnight in ${zone}.</p>${filterNote}${body}`;
  const res = page(`idolytics: ${current.name}`, html, 200, tzForm);
  res.headers.set("X-D1-Rows-Read", String(rowsRead + (mod?.meta.rows_read ?? 0)));
  return res;
}

function filterBar(f: Filters, path: string, project: string, testEnv: boolean, o: { versions: string[]; countries: string[]; platforms: string[] }) {
  const select = (name: string, label: string, all: string, values: string[], current: string | null) =>
    `<label>${label} <select name="${name}"><option value="">${all}</option>${[...new Set([...values, ...(current ? [current] : [])])]
      .map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  const rangeLabel = f.range === "custom" ? (f.from === f.to ? f.from : `${f.from} to ${f.to}`) : `${RANGES[f.range]} (${short(f.from)} to ${short(f.to)})`;
  const active = [rangeLabel, f.compare ? "vs previous period" : "", f.v ? `version ${f.v}` : "", f.p ?? "", f.c ?? "",
    f.who === "all" ? "" : `${f.who} players`, f.device ? `device ${f.device}` : "", f.events.join(", "),
    ...f.props.map(([k, v]) => `${k}=${v}`), f.by ? `by ${f.by}` : ""].filter(Boolean).join(" · ");
  const text = (name: string, label: string, value: string, hint: string) =>
    `<label>${label} <input name="${name}" value="${esc(value)}" placeholder="${hint}" maxlength="120"></label>`;
  return `<section class="filters">
    <input type="checkbox" id="filters-open" class="toggle"><label for="filters-open" class="summary"><strong>Filters</strong> ${esc(active)}</label>
    <form method="get" action="${esc(path)}"><input type="hidden" name="project" value="${esc(project)}">${testEnv ? '<input type="hidden" name="env" value="test">' : ""}
      <label>Date range <select name="range">${Object.entries(RANGES).map(([k, v]) => `<option value="${k}"${k === f.range ? " selected" : ""}>${v}</option>`).join("")}
        <option value="custom"${f.range === "custom" ? " selected" : ""}>Custom</option></select></label>
      <label>From <input type="date" name="from" value="${f.range === "custom" ? f.from : ""}"></label>
      <label>To <input type="date" name="to" value="${f.range === "custom" ? f.to : ""}"></label>
      <label>Compare <select name="cmp"><option value="">Previous period</option><option value="off"${f.compare ? "" : " selected"}>Off</option></select></label>
      ${select("v", "Version", "All versions", o.versions, f.v)}
      ${select("p", "Platform", "All platforms", o.platforms, f.p)}
      ${select("c", "Country", "All countries", o.countries, f.c)}
      <label>Players <select name="who">${[["all", "All"], ["new", "New"], ["returning", "Returning"]].map(([k, v]) =>
        `<option value="${k === "all" ? "" : k}"${k === f.who ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      ${text("device", "Device", f.device ?? "", "device id")}
      ${text("event", "Events", f.events.join(","), "level_fail,level_quit")}
      ${[0, 1, 2].map((i) => text("prop", `Property ${i + 1}`, f.props[i] ? f.props[i].join("=") : "", "key=value")).join("")}
      ${path === "/events" ? text("by", "Break down by", f.by ?? "", "props key") : ""}
      <button>Apply</button><a class="reset" href="${esc(path)}?project=${encodeURIComponent(project)}${testEnv ? "&amp;env=test" : ""}">Reset</a>
    </form></section>`;
}

type Overview = Awaited<ReturnType<typeof overview>>;

function overviewBody(o: Overview, f: Filters, dayHref: (d: string) => string, levelsHref: string) {
  const period = f.days === 1 ? "previous day" : `previous ${f.days} days`;
  const card = (key: keyof Kpis, label: string, show: (v: number | null) => string, rate: boolean, help: string) => {
    const cur = o.current[key], prev = o.previous?.[key] ?? null;
    let delta = "";
    if (o.previous) {
      if (cur === null || prev === null || (!rate && prev === 0)) delta = `No data for the ${period}`;
      else {
        const d = rate ? (cur - prev) * 100 : ((cur - prev) / prev) * 100;
        const r = Math.round(d);
        delta = `${r > 0 ? "▲" : r < 0 ? "▼" : ""} ${Math.abs(r)}${rate ? " pts" : "%"} vs ${period}`;
      }
    }
    return `<div class="kpi" data-kpi="${key}" title="${esc(help)}"><h3>${label}</h3><p class="value">${show(cur)}</p>${delta ? `<p class="delta">${esc(delta)}</p>` : ""}</div>`;
  };
  const levels = o.levels.length ? `<section><h2>Levels with the most quits</h2>
    <p class="note">Quit rate is quits / starts. A start with no result for ${QUIT_AFTER_MS / 60_000} minutes counts as a quit. <a href="${esc(levelsHref)}">All levels</a></p>
    <div class="scroll"><table><thead><tr><th>Level</th><th>Starts</th><th>Quits</th><th>Quit rate</th></tr></thead><tbody>${o.levels.map((l) =>
      `<tr><td>${esc(l.level)}</td><td>${l.starts}</td><td>${l.quits}</td><td>${pct(l.quitRate)}</td></tr>`).join("")}</tbody></table></div></section>` : "";
  return `<section class="kpis">
    ${card("dau", "Average DAU", num, false, "Average distinct players per day")}
    ${card("newUsers", "New users", num, false, "Installs whose first day is in the range")}
    ${card("sessions", "Sessions", num, false, "Distinct session ids")}
    ${card("sessionLength", "Avg session length", dur, false, "Time from the first to the last event of a session, averaged")}
    ${card("playtimePerUser", "Playtime per user", dur, false, "Total session time / distinct players in the range")}
    ${card("d1", "D1 retention", pct, true, "Share of installs active one day later, for cohorts whose day 1 has finished")}
    ${card("d7", "D7 retention", pct, true, "Share of installs active seven days later, for cohorts whose day 7 has finished")}
    ${card("stickiness", "Stickiness", pct, true, "Average DAU / distinct players in the range")}
  </section>
  <section><h2>Daily players</h2><p class="note">New and returning players per day, with sessions. Select a day to show only that day.</p>
    ${dayBars(o.days, [{ name: "New", cls: "s1", values: o.newByDay }, { name: "Returning", cls: "s2", values: o.returningByDay }],
      { name: "Sessions", cls: "s3", values: o.sessionsByDay }, dayHref)}
    <p class="legend"><span class="key s1"></span>New <span class="key s2"></span>Returning <span class="key s3 line"></span>Sessions</p></section>
  <section><h2>Top events</h2><p class="note">Event count in the range.${f.c || f.who !== "all" ? " Not filtered by country or new or returning players." : ""}</p>
    ${barList(o.topEvents.map((e) => ({ label: e.name, value: e.count })))}</section>
  ${levels}`;
}

function retentionBody(r: Awaited<ReturnType<typeof cohortTable>>) {
  const head = Array.from({ length: 31 }, (_, n) => `<th>D${n}</th>`).join("");
  const rows = r.rows.map((c) => `<tr><th scope="row">${short(c.day)}</th><td>${c.size}</td>${c.cells.map((v, n) => {
    if (v === null) return `<td class="incomplete" title="Day ${n} has not finished">·</td>`;
    const p = Math.round(v * 100);
    return `<td style="background:color-mix(in srgb,var(--s1) ${p}%,var(--surface))${p > 55 ? ";color:#fff" : ""}"
      title="Installed ${c.day}, day ${n}: ${c.counts[n]} of ${c.size}">${p}%</td>`;
  }).join("")}</tr>`).join("");
  return `<section class="kpis">${r.summary.map((s) => `<div class="kpi" data-kpi="d${s.n}"><h3>D${s.n} retention</h3><p class="value">${pct(s.rate)}</p></div>`).join("")}</section>
  <section><h2>Retention by install day</h2>
    <p class="note">Each row is the players who installed that day; a cell is the share of them active N days later. A dot marks a day that has not finished. The version, platform and country filters use each install's first day.</p>
    ${r.rows.length ? `<div class="scroll"><table class="heat"><thead><tr><th>Installed</th><th>Players</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">No installs in this range.</p>`}</section>`;
}

const ratio = (a: number, b: number) => (b ? a / b : null);
const avg = (sum: number, n: number) => (n ? (sum / n).toFixed(1) : "–");
const LEVEL_COLS: { key: string; label: string; value: (l: LevelRow) => number | null; show?: (l: LevelRow) => string }[] = [
  { key: "starts", label: "Starts", value: (l) => l.starts },
  { key: "players", label: "Players", value: (l) => l.players },
  { key: "wins", label: "Wins", value: (l) => l.wins },
  { key: "fails", label: "Fails", value: (l) => l.fails },
  { key: "quits", label: "Quits (inferred)", value: (l) => l.quits },
  { key: "win", label: "Win rate", value: (l) => ratio(l.wins, l.wins + l.fails), show: (l) => pct(ratio(l.wins, l.wins + l.fails)) },
  { key: "first", label: "First try win rate", value: (l) => ratio(l.first_try_wins, l.first_starts), show: (l) => pct(ratio(l.first_try_wins, l.first_starts)) },
  { key: "apw", label: "Attempts per win", value: (l) => ratio(l.starts, l.wins), show: (l) => (l.wins && l.starts ? (l.starts / l.wins).toFixed(1) : "–") },
  { key: "duration", label: "Avg duration", value: (l) => ratio(l.duration_sum, l.duration_n), show: (l) => dur(ratio(l.duration_sum, l.duration_n)) },
  { key: "stars", label: "Avg stars", value: (l) => ratio(l.stars_sum, l.stars_n), show: (l) => avg(l.stars_sum, l.stars_n) },
  { key: "moves", label: "Avg moves left", value: (l) => ratio(l.moves_left_sum, l.moves_left_n), show: (l) => avg(l.moves_left_sum, l.moves_left_n) },
];
const byLevel = (a: LevelRow, b: LevelRow) => Number(a.level) - Number(b.level) || a.level.localeCompare(b.level, "en", { numeric: true });

function levelsBody(levels: LevelRow[], sort: string, dir: "asc" | "desc", link: (over: Record<string, string | null>) => string, levelHref: (l: string) => string) {
  const col = LEVEL_COLS.find((c) => c.key === sort);
  const sorted = [...levels].sort((a, b) => {
    if (!col) return dir === "desc" ? byLevel(b, a) : byLevel(a, b);
    const x = col.value(a), y = col.value(b);
    if (x === null || y === null) return x === y ? byLevel(a, b) : x === null ? 1 : -1; // no value sorts last
    return (dir === "desc" ? y - x : x - y) || byLevel(a, b);
  });
  const head = [{ key: "level", label: "Level" }, ...LEVEL_COLS].map((c) => {
    const on = (col?.key ?? "level") === c.key;
    const next = on && dir === "asc" ? "desc" : on ? "asc" : c.key === "level" ? "asc" : "desc";
    return `<th${on ? ` aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""}><a href="${esc(link({ sort: c.key, dir: next }))}">${c.label}${on ? (dir === "asc" ? " ↑" : " ↓") : ""}</a></th>`;
  }).join("");
  const rows = sorted.map((l) => `<tr><td><a href="${esc(levelHref(l.level))}">${esc(l.level)}</a></td>${LEVEL_COLS.map((c) =>
    `<td>${c.show ? c.show(l) : c.value(l)}</td>`).join("")}</tr>`).join("");
  // Progression: players who started each level, as a share of the first level's players.
  const funnel = [...levels].sort(byLevel);
  const base = funnel[0]?.players ?? 0;
  const steps = funnel.map((l) => {
    const share = ratio(l.players, base);
    return `<li><span>Level ${esc(l.level)}: ${l.players} players (${pct(share)})</span><i style="width:${Math.round((share ?? 0) * 100)}%"></i></li>`;
  }).join("");
  return `<section><h2>Levels</h2>
    <div class="scroll"><table class="levels"><thead><tr>${head}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${LEVEL_COLS.length + 1}" class="empty">No level events in this range.</td></tr>`}</tbody></table></div>
    <p class="note">Players are distinct devices that started the level. Win rate is wins / (wins + fails). First try win rate is wins on attempt 1 /
    starts of attempt 1. Attempts per win is starts / wins. Stars and moves left are averaged over wins that sent them. Quits are inferred:
    level_quit events plus starts with no result for ${QUIT_AFTER_MS / 60_000} minutes, counted on the day of the start. Select a level for its detail.</p></section>
  <section><h2>Progression</h2><p class="note">Players who started each level in the range, as a share of the first level's players.</p>
    ${steps ? `<ol class="funnel">${steps}</ol>` : `<p class="empty">No level events in this range.</p>`}</section>`;
}

type Counts = { key: string; starts: number; wins: number; fails: number; quits: number };
const countsTable = (first: string, rows: Counts[], label: (k: string) => string) =>
  `<div class="scroll"><table><thead><tr><th>${first}</th><th>Starts</th><th>Wins</th><th>Fails</th><th>Quits (inferred)</th><th>Win rate</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td>${esc(label(r.key))}</td><td>${r.starts}</td><td>${r.wins}</td><td>${r.fails}</td><td>${r.quits}</td>
  <td>${pct(ratio(r.wins, r.wins + r.fails))}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No events for this level in this range.</td></tr>`}</tbody></table></div>`;

function levelDetailBody(level: string, r: Awaited<ReturnType<typeof levelDetail>>) {
  return `<section><h2>Level ${esc(level)} by day</h2><p class="note">Newest day first. Win rate is wins / (wins + fails).</p>
    ${countsTable("Day", r.byDay, short)}</section>
  <section><h2>Level ${esc(level)} by version</h2>${countsTable("Version", r.byVersion, (k) => k || "(none)")}</section>
  <section><h2>Reasons, boosters and continues</h2>
    <p class="note">Events sent with this level, other than starts and wins, by props.reason, props.via or props.booster.</p>
    ${barList(r.events.map((e) => ({ label: `${e.name} ${e.detail}`.trim(), value: e.count })))}</section>`;
}

const time = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(5, 19).replace("T", " ");
const seconds = (ms: number | null) => (ms === null ? "" : (ms / 1000).toFixed(1) + " s");
/** Raw event rows. With deviceHref, a device column links each id to its page. */
function rawTable(rows: TailRow[], zone: string, tz: number, deviceHref: ((id: string) => string) | null, empty: string) {
  const body = rows.map((e) => `<tr><td>${time(e.client_ts, tz)}</td><td>${esc(e.name)}</td><td>${esc(e.level)}</td><td>${esc(e.attempt)}</td>
    <td>${seconds(e.duration_ms)}</td>${deviceHref ? `<td title="${esc(e.platform)}"><a href="${esc(deviceHref(e.device_id))}">${esc(e.device_id.slice(0, 8))}</a></td>` : ""}
    <td>${esc(e.app_version)}</td><td><code>${esc(e.props)}</code></td></tr>`).join("");
  const cols = deviceHref ? 8 : 7;
  return `<div class="scroll"><table class="tail"><thead><tr><th>Time (${zone})</th><th>Event</th><th>Level</th><th>Attempt</th><th>Duration</th>
    ${deviceHref ? "<th>Device</th>" : ""}<th>Version</th><th>Props</th></tr></thead>
    <tbody>${body || `<tr><td colspan="${cols}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
}

function eventsBody(r: Awaited<ReturnType<typeof eventsPage>>, f: Filters, zone: string, tz: number, dayHref: (d: string) => string, deviceHref: (id: string) => string) {
  const which = f.events.length ? f.events.join(", ") : "All events";
  const breakdown = r.breakdown ? `<section><h2>${esc(which)} by ${esc(f.by)}</h2><p class="note">The 20 most common values of props.${esc(f.by)}.</p>
    <div class="scroll"><table><thead><tr><th>Value</th><th>Events</th></tr></thead><tbody>${r.breakdown.map((b) =>
      `<tr><td>${b.prop === null ? "(not set)" : esc(b.prop)}</td><td>${b.n}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">No events.</td></tr>`}</tbody></table></div></section>` : "";
  return `<section><h2>${esc(which)} over time</h2><p class="note">Events per day. Select a day to show only that day.</p>
    ${dayBars(r.days, [{ name: "Events", cls: "s1", values: r.counts }], null, dayHref)}</section>
  ${breakdown}
  <section><h2>Top events</h2><p class="note">Event count in the range.</p>
    ${barList(r.topEvents.map((e) => ({ label: e.name, value: e.count })))}</section>
  <section><h2>Latest events</h2><p class="note">${r.filtered ? `The 100 newest matching raw events that arrived in the range${f.days > RAW_MAX_DAYS ? `, within its last ${RAW_MAX_DAYS} days` : ""}` : "The 100 newest raw events by arrival, any date"}.
    Times in ${zone}. Select a device for its timeline.</p>
    ${rawTable(r.tail, zone, tz, deviceHref, "No events yet.")}</section>`;
}

function deviceBody(id: string, r: Awaited<ReturnType<typeof devicePage>>, zone: string, tz: number) {
  const d = r.device;
  const days = r.days.map((x) => `<tr><td>${short(x.day)}</td><td>${x.sessions}</td><td>${dur(x.playtime)}</td><td>${x.events}</td><td>${x.level ?? "–"}</td></tr>`).join("");
  return `<section><h2>Device ${esc(id)}</h2>
    ${d ? `<p>First day ${esc(d.first_day)}. Last seen ${r.days[0] ? esc(r.days[0].day) : "before this range"}.</p>
      <p class="note">${esc(d.version)} · ${esc(d.platform)} · ${esc(d.country)} (from its first event)</p>` : `<p class="empty">No rolled up data for this device yet.</p>`}</section>
  <section><h2>Active days</h2><p class="note">Days in the range with events, newest first.</p>
    <div class="scroll"><table><thead><tr><th>Day</th><th>Sessions</th><th>Playtime</th><th>Events</th><th>Highest level</th></tr></thead>
    <tbody>${days || `<tr><td colspan="5" class="empty">No active days in this range.</td></tr>`}</tbody></table></div></section>
  <section><h2>Timeline</h2><p class="note">The 200 newest raw events that arrived in the range, with all props. Times in ${zone}.</p>
    ${rawTable(r.timeline, zone, tz, null, "No raw events in this range.")}</section>`;
}

const money = (v: number) => (v ? v.toFixed(2) : "–");
const SERIES = ["s1", "s2", "s3"];

function economyBody(r: Awaited<ReturnType<typeof economy>>, dayHref: (d: string) => string) {
  const sections: string[] = [];
  if (r.currencies.length) {
    sections.push(`<section><h2>Currency</h2><p class="note">Amounts are the value of currency_earned and currency_spent events, by props.source and props.sink.</p>
      <div class="scroll"><table><thead><tr><th>Currency</th><th>Earned</th><th>Spent</th></tr></thead><tbody>${r.currencies.map((c) =>
        `<tr><td>${esc(c.currency || "(not set)")}</td><td>${num(c.earned)}</td><td>${num(c.spent)}</td></tr>`).join("")}</tbody></table></div>
      ${r.currencies.slice(0, 3).map((c) => `<h3>${esc(c.currency || "(not set)")} per day</h3>
        ${dayBars(r.days, [{ name: "Earned", cls: "s1", values: c.earnedByDay }, { name: "Spent", cls: "s2", values: c.spentByDay }], null, dayHref)}
        <p class="legend"><span class="key s1"></span>Earned <span class="key s2"></span>Spent</p>
        <div class="pair"><div><h3>Top sources</h3>${barList(c.sources)}</div><div><h3>Top sinks</h3>${barList(c.sinks)}</div></div>`).join("")}</section>`);
  }
  if (r.boosters.length) {
    sections.push(`<section><h2>Boosters</h2><p class="note">Used counts booster_used, booster_bought and try_taken; offered counts booster_offered and try_offer_shown, by props.booster (props.mode for an offer without one).</p>
      <div class="scroll"><table><thead><tr><th>Booster</th><th>Used</th><th>Offered</th></tr></thead><tbody>${r.boosters.map((b) =>
        `<tr><td>${esc(b.booster || "(not set)")}</td><td>${b.used}</td><td>${b.offered}</td></tr>`).join("")}</tbody></table></div></section>`);
  }
  if (r.ads.length) {
    const shown = r.ads.slice(0, 3);
    sections.push(`<section><h2>Ads</h2><p class="note">ad_shown by props.format; interstitial_shown counts as interstitial and continue_watched as rewarded. Revenue is the value sent with the ad.</p>
      ${dayBars(r.days, shown.map((a, i) => ({ name: a.format || "(not set)", cls: SERIES[i], values: a.byDay })), null, dayHref)}
      <p class="legend">${shown.map((a, i) => `<span class="key ${SERIES[i]}"></span>${esc(a.format || "(not set)")}`).join(" ")}</p>
      <div class="scroll"><table><thead><tr><th>Format</th><th>Shown</th><th>Revenue</th></tr></thead><tbody>${r.ads.map((a) =>
        `<tr><td>${esc(a.format || "(not set)")}</td><td>${a.shown}</td><td>${money(a.revenue)}</td></tr>`).join("")}</tbody></table></div></section>`);
  }
  if (r.revenue.length) {
    sections.push(`<section><h2>Revenue</h2><p class="note">Revenue is the value of ad_shown and iap_purchase events, per currency.
      ARPDAU is revenue / device days (${r.deviceDays} in the range).</p>
      <div class="scroll"><table><thead><tr><th>Currency</th><th>Revenue</th><th>Ads</th><th>In-app</th><th>ARPDAU</th></tr></thead><tbody>${r.revenue.map((m) =>
        `<tr><td>${esc(m.currency || "(not set)")}</td><td>${money(m.total)}</td><td>${money(m.ads)}</td><td>${money(m.iap)}</td><td>${m.arpdau === null ? "–" : m.arpdau.toFixed(2)}</td></tr>`).join("")}</tbody></table></div></section>`);
  }
  return sections.join("") || `<section><p class="empty">No economy or ad events in this range.</p>
    <p class="note">Send currency_earned, currency_spent, booster_used, ad_shown or iap_purchase events; see the event schema.</p></section>`;
}

function liveBody(r: Awaited<ReturnType<typeof live>>, zone: string, tz: number, deviceHref: (id: string) => string) {
  const minutes = LIVE_MS / 60_000;
  return `<section class="kpis"><div class="kpi" data-kpi="devices"><h3>Devices, last ${minutes} min</h3><p class="value">${r.devices}</p></div>
    <div class="kpi" data-kpi="events"><h3>Events, last ${minutes} min</h3><p class="value">${r.events}</p></div></section>
  <section><h2>Newest events</h2><p class="note">Raw events that arrived in the last ${minutes} minutes, newest 50. Reload the page to refresh. Times in ${zone}.</p>
    ${rawTable(r.tail, zone, tz, deviceHref, `No events in the last ${minutes} minutes.`)}</section>`;
}

/** A bar with a warning colour from 70%. */
const meter = (used: number, of: number) => {
  const share = of ? Math.min(1, used / of) : 0;
  return `<div class="meter${share >= 0.7 ? " warn" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${of}" aria-valuenow="${used}"><i style="width:${Math.round(share * 100)}%"></i></div>`;
};
// Free plan daily limits (developers.cloudflare.com/d1/platform/limits); writes are estimated, reads are not tracked.
const FREE_WRITES = 100_000, FREE_BYTES = 500 * 1024 * 1024;
// About 2 row writes per event (row and arrival index) plus about 1 for the rollups.
const WRITES_PER_EVENT = 3;

function settingsBody(list: Proj[], rows: Proj[], current: Proj, u: Awaited<ReturnType<typeof usageToday>>, cap: number, tzForm: string) {
  const has = new Set(rows.map((p) => p.id));
  const used = u.events.get(current.id) ?? 0, usedTest = u.events.get(`${current.id}~test`) ?? 0;
  const total = [...u.events.values()].reduce((t, n) => t + n, 0);
  const writes = total * WRITES_PER_EVENT;
  const projects = list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.id)}</td><td>${tzLabel(p.tz_min)}</td><td>${u.events.get(p.id) ?? 0}</td>
    <td>${has.has(`${p.id}~test`) ? u.events.get(`${p.id}~test`) ?? 0 : "No test key"}</td></tr>`).join("");
  const testKey = has.has(`${current.id}~test`);
  return `<section><h2>Projects</h2><div class="scroll"><table><thead><tr><th>Name</th><th>Id</th><th>Time zone</th><th>Live events today</th><th>Test events today</th></tr></thead>
    <tbody>${projects}</tbody></table></div><p class="note">Events today count from UTC midnight, as the daily cap does.</p></section>
  <section><h2>${esc(current.name)}</h2>
    ${tzForm}
    <h3>Daily event cap</h3><p>${used} of ${cap} events today${usedTest ? `, and ${usedTest} of ${cap} on the test key` : ""}.</p>${meter(used, cap)}
    <p class="note">Each key's project has its own cap. Over it, ingest answers 429 until UTC midnight and the SDK retries later.</p>
    <h3>Test key</h3><p class="note">${testKey ? "A test key exists. Rotating it stops the old one at once." : "Test builds get their own key; their events show under Test, never under Live."}</p>
    <form method="post" action="/settings/test-key"><input type="hidden" name="project" value="${esc(current.id)}"><button>${testKey ? "Rotate test key" : "Create test key"}</button></form></section>
  <section><h2>D1 usage estimate</h2>
    <h3>Estimated D1 rows written today</h3><p>About ${num(writes)} of ${num(FREE_WRITES)} on the free plan (${total} events × ${WRITES_PER_EVENT}).</p>${meter(writes, FREE_WRITES)}
    ${u.bytes === null ? "" : `<h3>Database size</h3><p>${(u.bytes / 1024 / 1024).toFixed(1)} MB of 500 MB.</p>${meter(u.bytes, FREE_BYTES)}`}
    <p class="note">Rows read are not tracked here; each page reports its own in the X-D1-Rows-Read header. Exact numbers are in the Cloudflare dashboard under D1, Metrics.</p></section>`;
}

function page(title: string, body: string, status = 200, tools = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><header><h1>${esc(title)}</h1>${tools}</header><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const CSS = `
:root{color-scheme:light;--bg:#f4f4f2;--surface:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--line:#e2e1dc;--s1:#2a78d6;--s2:#eb6834;--s3:#6b5bd2;--error:#b42318;--warn-bg:#fdf3d8}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--text:#f0efec;--muted:#c3c2b7;--line:#33332f;--s1:#3987e5;--s2:#d95926;--s3:#8e80e8;--error:#f97066;--warn-bg:#3a3220}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main{max-width:1040px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:end;justify-content:space-between;margin-bottom:8px}
h1{font-size:20px;margin:16px 0 8px}h2{font-size:17px;margin:0 0 4px}h3{font-size:13px;margin:0;color:var(--muted);font-weight:500}
a{color:var(--s1)}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}
nav a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--text);text-decoration:none;background:var(--surface)}
nav a[aria-current]{border-color:var(--s1);font-weight:600}
nav.tabs{gap:0;border-bottom:1px solid var(--line);margin-bottom:16px}
nav.tabs a{border:0;border-radius:0;background:none;padding:8px 14px;border-bottom:2px solid transparent;margin-bottom:-1px}
nav.tabs a[aria-current]{border-bottom-color:var(--s1)}
details{flex-basis:100%}summary{cursor:pointer;color:var(--muted);padding:4px 0}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:8px}
form.tz{margin:0}
label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);min-height:40px}
button{font:inherit;min-height:40px;padding:0 16px;border:0;border-radius:6px;background:var(--s1);color:#fff;cursor:pointer}
.filters{padding:12px 16px}.filters form{margin-top:12px}
.filters .summary{display:block;font-size:14px;color:var(--text);cursor:pointer}.filters .summary strong{margin-right:6px}
.toggle{position:absolute;opacity:0;width:1px;height:1px}.toggle:focus-visible+.summary{outline:2px solid var(--s1);outline-offset:4px}
.toggle:not(:checked)~form{display:none}
.filters .summary::after{content:" ▾";color:var(--muted)}
@media (min-width:900px){.toggle:not(:checked)~form{display:flex}.filters .summary{cursor:default}.filters .summary::after{content:none}}
.reset{align-self:center;padding:0 4px}
.banner{background:var(--warn-bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.note{color:var(--muted);font-size:13px;margin:0 0 8px}.empty{color:var(--muted)}.error{color:var(--error)}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:12px}
.kpi{border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.kpi .value{font-size:24px;font-weight:600;margin:2px 0;font-variant-numeric:tabular-nums}.kpi .delta{font-size:12px;color:var(--muted);margin:0}
svg{width:100%;max-width:640px;height:auto;display:block;overflow:visible}
.grid{stroke:var(--line)}.axis,.label,.value{font-size:11px;fill:var(--muted)}.label{fill:var(--text)}
.line{fill:none;stroke-width:2;pointer-events:none}.line.s1{stroke:var(--s1)}.line.s2{stroke:var(--s2)}.line.s3{stroke:var(--s3)}
circle{pointer-events:none;stroke:var(--surface);stroke-width:2}circle.s1{fill:var(--s1)}circle.s2{fill:var(--s2)}circle.s3{fill:var(--s3)}
.bar{fill:var(--s1)}.bar.s2{fill:var(--s2)}rect.bar{stroke:var(--surface);stroke-width:1}
.hit{fill:transparent}a:hover .hit,a:focus .hit{fill:var(--line);opacity:.5}
.legend{font-size:13px;color:var(--muted);margin:4px 0 0}
.legend .key{display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:middle;margin:0 6px 0 12px}
.legend .key:first-child{margin-left:0}.key.s1{background:var(--s1)}.key.s2{background:var(--s2)}.key.s3{background:var(--s3)}.key.line{height:3px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500}
.heat td,.heat th{padding:4px 6px;font-size:12px;text-align:center;border:1px solid var(--surface)}
.heat th[scope=row]{position:sticky;left:0;background:var(--surface);text-align:left}
.heat .incomplete{color:var(--muted);background:repeating-linear-gradient(135deg,var(--surface) 0 4px,var(--bg) 4px 8px)}
nav.env{gap:0;margin:-4px 0 12px}nav.env a{border-radius:0;padding:4px 12px}nav.env a:first-child{border-radius:999px 0 0 999px}nav.env a:last-child{border-radius:0 999px 999px 0;border-left:0}
.meter{height:10px;border-radius:5px;background:var(--line);margin:4px 0 12px;max-width:420px}.meter i{display:block;height:100%;border-radius:5px;background:var(--s1)}
.meter.warn i{background:var(--s2)}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}h3{margin-top:12px}
.funnel{list-style:none;margin:0;padding:0;font-size:14px}.funnel li{margin:0 0 6px}
.funnel i{display:block;height:8px;border-radius:4px;background:var(--s1);margin-top:2px;min-width:2px}
.levels th a{color:inherit;text-decoration:none}
.tail td,.tail th{text-align:left}.tail code{display:inline-block;min-width:220px;font-size:12px;white-space:normal;word-break:break-all}
pre.key{padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;word-break:break-all;user-select:all}
`;
