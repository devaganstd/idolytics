import { DAY } from "../src/rollup";
import { raw } from "./helpers";

export const D1 = Date.UTC(2026, 10, 1); // 2026-11-01 00:00 UTC
export const at = (day: number, h: number, m = 0) => D1 + day * DAY + h * 3_600_000 + m * 60_000;
export const NOW = at(2, 23);
export const MIN = 60_000;

/** Hand counted fixture. d1 and d2 install on 11-01, d3 on 11-02. Received one minute after the device time. */
export async function seed() {
  const e = (name: string, device: string, session: string, ts: number, more: Record<string, unknown> = {}) =>
    raw({ name, device, session, ts, received: ts + MIN, ...more });
  const ios = { version: "1.0", platform: "ios", country: "US" };
  // 11-01 d1: fails level 1, wins it on attempt 2. Session 10:00 to 10:06.
  await e("session_start", "d1", "a", at(0, 10, 0));
  await e("level_start", "d1", "a", at(0, 10, 1), { level: "1", attempt: 1 });
  await e("level_fail", "d1", "a", at(0, 10, 3), { level: "1", attempt: 1, duration: 120_000 });
  await e("level_start", "d1", "a", at(0, 10, 4), { level: "1", attempt: 2 });
  await e("level_complete", "d1", "a", at(0, 10, 6), { level: "1", attempt: 2, duration: 100_000, props: { stars: 3, moves_left: 2 } });
  // 11-01 d2 on iOS: wins level 1 first try, starts level 2 and never comes back to it.
  await e("session_start", "d2", "b", at(0, 12, 0), ios);
  await e("level_start", "d2", "b", at(0, 12, 1), { ...ios, level: "1", attempt: 1 });
  await e("level_complete", "d2", "b", at(0, 12, 2), { ...ios, level: "1", attempt: 1, duration: 60_000, props: { stars: 1 } });
  await e("level_start", "d2", "b", at(0, 12, 3), { ...ios, level: "2", attempt: 1 });
  // 11-02 d1 returns: quits level 2 explicitly, uses a booster. d3 installs on 1.1.
  await e("session_start", "d1", "c", at(1, 9, 0));
  await e("level_start", "d1", "c", at(1, 9, 1), { level: "2", attempt: 1 });
  await e("level_quit", "d1", "c", at(1, 9, 2), { level: "2", attempt: 1 });
  await e("booster_used", "d1", "c", at(1, 9, 5), { value: 5 });
  await e("session_start", "d3", "d", at(1, 20, 0), { version: "1.1" });
  // 11-03 d2 returns.
  await e("session_start", "d2", "e", at(2, 8, 0), ios);
}

