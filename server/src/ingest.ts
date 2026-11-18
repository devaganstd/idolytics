import { sha256Hex } from "./keys";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_EVENTS = 100;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const DAY = 86_400_000;
// Keys that would carry personal data. Allows keys such as step_name or level_name.
const DENY_KEY = /(^|_)(e_?mail|phone)(_|$)|^((first|last|full|player|user|real|display)_?)?name$|^nickname$/;
const LOOKS_LIKE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

type Props = Record<string, string | number | boolean>;
export interface Row {
  event_id: string; name: string; session_id: string; user_id: string | null; client_ts: number;
  level: string | null; attempt: number | null; duration_ms: number | null;
  value: number | null; currency: string | null; props: string | null;
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || v === null || str(v, max);
const isInt = (v: unknown) => Number.isSafeInteger(v);
const nonNegInt = (v: unknown) => isInt(v) && (v as number) >= 0;

function validProps(p: unknown): p is Props {
  if (p === undefined || p === null) return true;
  if (typeof p !== "object" || Array.isArray(p)) return false;
  const entries = Object.entries(p);
  if (entries.length > 25) return false;
  return entries.every(([k, v]) => {
    if (!NAME.test(k) || DENY_KEY.test(k)) return false;
    if (typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    return typeof v === "string" && v.length <= 100 && !LOOKS_LIKE_EMAIL.test(v);
  });
}

/** Returns a row for a valid event, or null. Unknown top level fields are dropped. */
export function toRow(e: any, now: number): Row | null {
  if (!e || typeof e !== "object") return null;
  if (!str(e.event_id, 64) || !str(e.name, 40) || !NAME.test(e.name) || e.name.startsWith("idl_")) return null;
  if (!isInt(e.ts) || e.ts < now - 30 * DAY || e.ts > now + DAY) return null;
  if (!str(e.session_id, 64) || !optStr(e.user_id, 64) || !optStr(e.currency, 16)) return null;
  if (typeof e.user_id === "string" && LOOKS_LIKE_EMAIL.test(e.user_id)) return null;
  const level = typeof e.level === "number" && isInt(e.level) ? String(e.level) : e.level;
  if (!optStr(level, 40)) return null;
  if (e.attempt != null && !nonNegInt(e.attempt)) return null;
  if (e.duration_ms != null && !nonNegInt(e.duration_ms)) return null;
  if (e.value != null && !(typeof e.value === "number" && Number.isFinite(e.value))) return null;
  if (!validProps(e.props)) return null;
  const hasProps = e.props && Object.keys(e.props).length > 0;
  return {
    event_id: e.event_id, name: e.name, session_id: e.session_id, user_id: e.user_id ?? null, client_ts: e.ts,
    level: level ?? null, attempt: e.attempt ?? null, duration_ms: e.duration_ms ?? null,
    value: e.value ?? null, currency: e.currency ?? null, props: hasProps ? JSON.stringify(e.props) : null,
  };
}

export async function ingest(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return json({ error: "missing write key" }, 401);

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);

  const project = await env.DB.prepare("SELECT id FROM projects WHERE write_key_hash = ?")
    .bind(await sha256Hex(key)).first<{ id: string }>();
  if (!project) return json({ error: "unknown write key" }, 401);

  let body: any;
  try { body = JSON.parse(new TextDecoder().decode(buf)); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!body || !Array.isArray(body.events) || body.events.length > MAX_EVENTS) return json({ error: `events must be an array of at most ${MAX_EVENTS}` }, 400);
  if (!str(body.device_id, 64)) return json({ error: "device_id is required" }, 400);
  for (const f of ["app_version", "platform", "os"]) if (!optStr(body[f], 64)) return json({ error: `invalid ${f}` }, 400);

  const now = Date.now();
  const rows = body.events.map((e: unknown) => toRow(e, now)).filter((r: Row | null): r is Row => r !== null);
  const country = (request as { cf?: { country?: string } }).cf?.country ?? null;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO events (project_id, event_id, name, device_id, session_id, user_id, client_ts, received_at,
      app_version, platform, os, country, level, attempt, duration_ms, value, currency, props)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  if (rows.length) {
    await env.DB.batch(rows.map((r: Row) => stmt.bind(
      project.id, r.event_id, r.name, body.device_id, r.session_id, r.user_id, r.client_ts, now,
      body.app_version ?? null, body.platform ?? null, body.os ?? null, country,
      r.level, r.attempt, r.duration_ms, r.value, r.currency, r.props,
    )));
  }
  return json({ accepted: rows.length, rejected: body.events.length - rows.length }, 202);
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status: number) {
  return Response.json(data, { status, headers: CORS });
}
