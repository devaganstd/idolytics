import { env, exports } from "cloudflare:workers";
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
  await env.DB.batch([env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM projects")]);
}
