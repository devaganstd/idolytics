import { esc } from "./html";
import { newWriteKey, safeEqual, sha256Hex } from "./keys";
import { boosters, daily, levelStats, projects, QUIT_AFTER_MS, RANGE_DAYS, tail } from "./queries";
import { barList, lineChart } from "./svg";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
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

export async function createProject(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return new Response("Cross origin form refused", { status: 403 });
  const form = await request.formData();
  const id = String(form.get("id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim() || id;
  const back = `<p><a href="/">Back</a></p>`;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || name.length > 80) {
    return page("New project", `<section><p class="error">The id must be 1 to 40 lowercase letters, digits or dashes.</p>${back}</section>`, 400);
  }
  const key = newWriteKey();
  const res = await env.DB.prepare("INSERT OR IGNORE INTO projects (id, name, created_at, write_key_hash) VALUES (?, ?, ?, ?)")
    .bind(id, name, Date.now(), await sha256Hex(key)).run();
  if (!res.meta.changes) return page("New project", `<section><p class="error">A project with id ${esc(id)} already exists.</p>${back}</section>`, 409);
  return page("Project created", `<section><h2>${esc(name)} is ready</h2>
    <p>Copy the write key now. It is shown once and stored only as a hash.</p>
    <pre class="key">${esc(key)}</pre>
    <p>Put it, with this server's URL, into the idolytics Settings asset in Unity.</p>
    <p><a href="/?project=${encodeURIComponent(id)}">Open the dashboard</a></p></section>`);
}

export async function dashboard(request: Request, env: Env): Promise<Response> {
  const all = await projects(env.DB);
  const wanted = new URL(request.url).searchParams.get("project");
  const current = all.find((p) => p.id === wanted) ?? all[0];
  const nav = all.map((p) => `<a href="/?project=${encodeURIComponent(p.id)}"${p === current ? ' aria-current="page"' : ""}>${esc(p.name)}</a>`).join("");
  const newForm = `<details${all.length ? "" : " open"}><summary>New project</summary>
    <form method="post" action="/projects"><label>Id <input name="id" required maxlength="40" placeholder="my-game"></label>
    <label>Name <input name="name" maxlength="80" placeholder="My Game"></label><button>Create</button></form></details>`;
  if (!current) return page("idolytics", `<section><p>No projects yet. Create one to get a write key.</p>${newForm}</section>`);

  const now = Date.now();
  const [days, levels, boost, events] = await Promise.all([
    daily(env.DB, current.id, now),
    levelStats(env.DB, current.id, now),
    boosters(env.DB, current.id, now),
    tail(env.DB, current.id),
  ]);
  const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
  const num = (v: number | null) => (v === null ? "–" : v.toFixed(1));
  const maxStarts = Math.max(1, ...levels.map((l) => l.starts));
  const quits = levels.filter((l) => l.quits > 0).sort((a, b) => b.quits - a.quits).slice(0, 10);

  const levelRows = levels.map((l) => `<tr><td>${esc(l.level)}</td>
    <td><span class="meter" style="width:${Math.round((l.starts / maxStarts) * 48)}px"></span>${l.starts}</td>
    <td>${l.wins}</td><td>${l.losses}</td><td>${pct(l.winRate)}</td><td>${num(l.attemptsPerWin)}</td><td>${l.quits}</td></tr>`).join("");
  const tailRows = events.map((e) => `<tr><td>${new Date(e.client_ts).toISOString().slice(5, 19).replace("T", " ")}</td>
    <td>${esc(e.name)}</td><td>${esc(e.level)}</td><td>${esc(e.attempt)}</td>
    <td>${e.duration_ms === null ? "" : (e.duration_ms / 1000).toFixed(1) + " s"}</td>
    <td title="${esc(e.platform)}">${esc(e.device_id.slice(0, 8))}</td><td><code>${esc(e.props)}</code></td></tr>`).join("");

  const body = `<nav>${nav}${newForm}</nav>
  <section><h2>Daily players and sessions</h2>
    <p class="note">Last ${RANGE_DAYS} days by device date (UTC). Players are distinct install ids.</p>
    ${lineChart(days.map((d) => d.day), [
      { name: "Players", cls: "s1", values: days.map((d) => d.players) },
      { name: "Sessions", cls: "s2", values: days.map((d) => d.sessions) },
    ])}
    <p class="legend"><span class="key s1"></span>Players <span class="key s2"></span>Sessions</p></section>
  <section><h2>Levels</h2>
    <div class="scroll"><table><thead><tr><th>Level</th><th>Starts</th><th>Wins</th><th>Losses</th><th>Win rate</th><th>Attempts per win</th><th>Quits*</th></tr></thead>
    <tbody>${levelRows || `<tr><td colspan="7" class="empty">No level events yet.</td></tr>`}</tbody></table></div>
    <p class="note">Win rate is wins / (wins + losses). Attempts per win is starts / wins.
    *Quits are inferred: a level_start with no level_complete or level_fail for the same device, level and attempt,
    received more than ${QUIT_AFTER_MS / 60_000} minutes ago, plus any level_quit the game sends.</p></section>
  <section><h2>Where players quit</h2><p class="note">Inferred quits per level, highest first.</p>
    ${barList(quits.map((l) => ({ label: `Level ${l.level}`, value: l.quits })))}</section>
  <section><h2>Booster use</h2><p class="note">Counts booster_used, booster_bought and try_taken, by event and booster.</p>
    ${barList(boost.byBooster.map((b) => ({ label: b.label, value: b.count })))}
    <h3>Per day</h3>
    ${lineChart(boost.byDay.map((d) => d.label), [{ name: "Boosters", cls: "s1", values: boost.byDay.map((d) => d.count) }])}</section>
  <section><h2>Latest events</h2>
    <div class="scroll"><table class="tail"><thead><tr><th>Time (UTC)</th><th>Event</th><th>Level</th><th>Attempt</th><th>Duration</th><th>Device</th><th>Props</th></tr></thead>
    <tbody>${tailRows || `<tr><td colspan="7" class="empty">No events yet.</td></tr>`}</tbody></table></div></section>`;
  return page(`idolytics: ${current.name}`, body);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><header><h1>${esc(title)}</h1></header><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const CSS = `
:root{color-scheme:light;--bg:#f4f4f2;--surface:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--line:#e2e1dc;--s1:#2a78d6;--s2:#eb6834;--error:#b42318}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--text:#f0efec;--muted:#c3c2b7;--line:#33332f;--s1:#3987e5;--s2:#d95926;--error:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main{max-width:960px;margin:0 auto;padding:0 16px}
h1{font-size:20px;margin:16px 0 8px}h2{font-size:17px;margin:0 0 4px}h3{font-size:14px;margin:16px 0 4px;color:var(--muted)}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 16px}
nav a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--text);text-decoration:none;background:var(--surface)}
nav a[aria-current]{border-color:var(--s1);font-weight:600}
details{flex-basis:100%}summary{cursor:pointer;color:var(--muted);padding:4px 0}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:8px}
label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
input{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);min-height:40px}
button{font:inherit;min-height:40px;padding:0 16px;border:0;border-radius:6px;background:var(--s1);color:#fff;cursor:pointer}
.note{color:var(--muted);font-size:13px;margin:0 0 8px}.empty{color:var(--muted)}.error{color:var(--error)}
svg{width:100%;max-width:560px;height:auto;display:block;overflow:visible}
.grid{stroke:var(--line)}.axis,.label,.value{font-size:11px;fill:var(--muted)}.label{fill:var(--text)}
.line{fill:none;stroke-width:2}.line.s1{stroke:var(--s1)}.line.s2{stroke:var(--s2)}
circle.s1{fill:var(--s1)}circle.s2{fill:var(--s2)}circle{stroke:var(--surface);stroke-width:2}
.bar{fill:var(--s1)}
.legend{font-size:13px;color:var(--muted);margin:4px 0 0}
.legend .key{display:inline-block;width:12px;height:3px;border-radius:2px;vertical-align:middle;margin:0 6px 0 12px}
.legend .key:first-child{margin-left:0}.key.s1{background:var(--s1)}.key.s2{background:var(--s2)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500}
.tail td,.tail th{text-align:left}.tail code{display:inline-block;min-width:220px;font-size:12px;white-space:normal;word-break:break-all}
.meter{display:inline-block;height:8px;border-radius:2px;background:var(--s1);margin-right:6px;vertical-align:middle;opacity:.6}
pre.key{padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;word-break:break-all;user-select:all}
`;
