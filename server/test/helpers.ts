import { env, exports } from "cloudflare:workers";
import { INSERT_EVENT } from "../src/ingest";
import { sha256Hex } from "../src/keys";

export const WRITE_KEY = "idl_w_testkeytestkeytestkeytestkey";
export const BASE = "https://idolytics.test";

export async function createProject(id = "demo", key = WRITE_KEY) {
  await env.DB.prepare("INSERT INTO projects (id, name, created_at, write_key_hash) VALUES (?, ?, ?, ?)")
    .bind(id, id, Date.now(), await sha256Hex(key))
    .run();
}

let n = 0;
export function ev(over: Record<string, unknown> = {}) {
  n++;
  return {
    event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: "level_start",
    ts: Date.now(),
    session_id: "s1",
    level: "1",
    attempt: 1,
    ...over,
  };
}

export function batch(events: unknown[], over: Record<string, unknown> = {}) {
  return { schema: 1, sdk: "test/0", device_id: "d1", app_version: "1.0.0", platform: "webgl", os: "test", events, ...over };
}

export function post(body: unknown, key: string | null = WRITE_KEY, raw?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://games.example" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return exports.default.fetch(new Request(`${BASE}/v1/events`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
}

export async function rows(sql = "SELECT * FROM events ORDER BY client_ts, event_id") {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

export async function reset() {
  await env.DB.batch(["events", "projects", "usage", "devices", "device_days", "cohort_days", "level_days", "event_days"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

let stored = 0;
/** Inserts a stored row directly, to control received_at. */
export async function store(e: { name: string; device: string; session: string; level: string; attempt?: number | null; ts: number; received: number }) {
  await env.DB.prepare(INSERT_EVENT)
    .bind("demo", `raw-${++stored}`, e.name, e.device, e.session, null, e.ts, e.received, null, null, null, null, e.level, e.attempt ?? null, null, null, null, null)
    .run();
}

let rawRow = 0;
/** Inserts a full raw row for project demo. ts and received default to each other. */
export async function raw(e: {
  name: string; device: string; session: string; ts: number; received?: number; version?: string; platform?: string;
  country?: string; level?: string; attempt?: number; duration?: number; value?: number; props?: Record<string, unknown>; id?: string;
}) {
  await env.DB.prepare(INSERT_EVENT)
    .bind("demo", e.id ?? `r-${String(++rawRow).padStart(6, "0")}`, e.name, e.device, e.session, null, e.ts, e.received ?? e.ts,
      e.version ?? "1.0", e.platform ?? "android", null, e.country ?? "ID", e.level ?? null, e.attempt ?? null,
      e.duration ?? null, e.value ?? null, null, e.props ? JSON.stringify(e.props) : null)
    .run();
}

/** Runs the rollup for project demo until it has read every raw row. */
export async function rollUp(now: number, chunk?: number) {
  const { rollupProject } = await import("../src/rollup");
  for (let i = 0; i < 1000; i++) {
    const p = await env.DB.prepare("SELECT * FROM projects WHERE id = 'demo'").first<import("../src/rollup").Project>();
    if ((await rollupProject(env.DB, p!, now, chunk)) < (chunk ?? 1000)) return;
  }
  throw new Error("rollup did not finish");
}
