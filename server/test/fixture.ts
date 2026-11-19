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


/**
 * Hand counted economy and ads, 11-01 and 11-02. coins: earned 170 (level_reward 120, daily_gift 50), spent 30 (booster).
 * Boosters: hammer used 2 offered 1, bomb used 1, offer mode free 1. Ads: interstitial 2 (0.02 USD), rewarded 2 (0.05 USD).
 * IAP 0.99 USD. Revenue 1.06 USD over 3 device days: ARPDAU 0.35.
 */
export async function seedEconomy() {
  const ios = { platform: "ios", country: "US" };
  const e = (name: string, device: string, ts: number, more: Record<string, unknown> = {}) =>
    raw({ name, device, session: device + "s", ts, ...(device === "d2" ? ios : {}), ...more });
  await e("currency_earned", "d1", at(0, 10), { value: 100, currency: "coins", props: { source: "level_reward" } });
  await e("currency_earned", "d2", at(0, 11), { value: 50, currency: "coins", props: { source: "daily_gift" } });
  await e("currency_spent", "d1", at(0, 12), { value: 30, currency: "coins", props: { sink: "booster" } });
  await e("currency_earned", "d1", at(1, 10), { value: 20, currency: "coins", props: { source: "level_reward" } });
  await e("booster_used", "d1", at(0, 10, 5), { level: "1", props: { booster: "hammer", source: "stock" } });
  await e("booster_bought", "d2", at(0, 11, 5), { level: "1", props: { booster: "bomb" } });
  await e("try_taken", "d1", at(0, 10, 6), { level: "1", props: { booster: "hammer", free: 1 } });
  await e("booster_offered", "d2", at(0, 11, 6), { props: { booster: "hammer" } });
  await e("try_offer_shown", "d1", at(0, 10, 7), { props: { mode: "free" } });
  await e("ad_shown", "d1", at(0, 10, 8), { value: 0.02, currency: "USD", props: { format: "interstitial" } });
  await e("ad_shown", "d2", at(0, 11, 8), { value: 0.05, currency: "USD", props: { format: "rewarded" } });
  await e("interstitial_shown", "d1", at(0, 10, 9), { level: "1" });
  await e("continue_watched", "d1", at(0, 10, 10), { level: "1" });
  await e("iap_purchase", "d2", at(0, 11, 9), { value: 0.99, currency: "USD", props: { product: "starter" } });
}

const DECK_A = "burst,canon,meteor,pierce,frost,wall,burst,canon"; // 8 cards, 6 distinct
const DECK_B = "burst,canon,meteor,pierce,frost,burst,canon,meteor"; // 8 cards, 5 distinct

/**
 * Hand counted Hex Battle Ground shaped data, as SDK 0.2.0 sends it. m1 (android) and m2 (ios) install on 11-01.
 * Matches against a bot, all mode normal (board, difficulty, deck, result, score):
 *   1 m1 11-01 hourglass easy   A win     0.9    4 m2 11-01 ring   easy   B win     0.8
 *   2 m1 11-01 hourglass normal A loss    0.4    5 m2 11-01 delta  hard   B abandon
 *   3 m1 11-01 ring      hard   A draw    0.5    6 m2 11-02 delta  normal B loss    0.3
 *   7 m1 11-02 hourglass easy   A, started and never ended: an inferred quit.
 * Trophies (milestones 300, 800, 1500): m1 330 then 310 on 11-01, 820 on 11-02; m2 120 on 11-01, 90 on 11-02.
 * Arena (2, 3, 4): m1 2 on 11-01, 3 on 11-02. Flow tutorial1: m1 steps 1, 2, 3 (5 s, 8 s, 4 s), m2 steps 1, 2 (7 s, 10 s).
 * Tutorial: m2 tutorial_begin, tutorial_step 1, tutorial_complete.
 */
export async function seedMatch() {
  const ios = { platform: "ios", country: "US" };
  const e = (name: string, device: string, ts: number, more: Record<string, unknown> = {}) =>
    raw({ name, device, session: device + "s" + Math.floor((ts - D1) / DAY), ts, ...(device === "m2" ? ios : {}), ...more });
  let attempt = 0;
  const match = async (device: string, ts: number, board: string, difficulty: string, deck: string, result: string | null, score?: number) => {
    const props = { kind: "match", mode: "normal", difficulty, opponent: "bot", deck };
    const a = ++attempt;
    await e("play_start", device, ts, { level: board, attempt: a, props });
    if (result) await e("play_end", device, ts + 2 * MIN, { level: board, attempt: a, duration: 60_000, value: score, props: { ...props, result } });
  };
  await match("m1", at(0, 10), "hourglass", "easy", DECK_A, "win", 0.9);
  await match("m1", at(0, 10, 5), "hourglass", "normal", DECK_A, "loss", 0.4);
  await match("m1", at(0, 10, 10), "ring", "hard", DECK_A, "draw", 0.5);
  await match("m2", at(0, 12), "ring", "easy", DECK_B, "win", 0.8);
  await match("m2", at(0, 12, 5), "delta", "hard", DECK_B, "abandon");
  await match("m2", at(1, 12), "delta", "normal", DECK_B, "loss", 0.3);
  await match("m1", at(1, 10), "hourglass", "easy", DECK_A, null);
  const progress = (device: string, ts: number, track: string, value: number) => e("progress", device, ts, { value, props: { track } });
  await progress("m1", at(0, 10, 3), "trophies", 330);
  await progress("m1", at(0, 10, 8), "trophies", 310);
  await progress("m1", at(0, 10, 9), "arena", 2);
  await progress("m1", at(1, 10, 1), "trophies", 820);
  await progress("m1", at(1, 10, 2), "arena", 3);
  await progress("m2", at(0, 12, 3), "trophies", 120);
  await progress("m2", at(1, 12, 3), "trophies", 90);
  const step = (device: string, ts: number, n: number, duration: number) =>
    e("step", device, ts, { duration, props: { flow: "tutorial1", step: n, step_id: `s${n}` } });
  await step("m1", at(0, 9, 1), 1, 5000);
  await step("m1", at(0, 9, 2), 2, 8000);
  await step("m1", at(0, 9, 3), 3, 4000);
  await step("m2", at(0, 11, 1), 1, 7000);
  await step("m2", at(0, 11, 2), 2, 10_000);
  await e("tutorial_begin", "m2", at(0, 11, 3), { props: { tutorial: "basics" } });
  await e("tutorial_step", "m2", at(0, 11, 4), { props: { tutorial: "basics", step: 1 } });
  await e("tutorial_complete", "m2", at(0, 11, 5), { duration: 120_000, props: { tutorial: "basics" } });
}

/** The fixture of seed() as SDK 0.2.0 would send it: play_start and play_end with kind level. */
export async function seedAsPlays() {
  const map: Record<string, [string, string | null]> = {
    level_start: ["play_start", null], level_complete: ["play_end", "win"], level_fail: ["play_end", "loss"], level_quit: ["play_end", "quit"],
  };
  const { rows } = await import("./helpers");
  await seed();
  const all = await rows("SELECT event_id, name, props FROM events WHERE name LIKE 'level_%'");
  const { env } = await import("cloudflare:workers");
  for (const r of all) {
    const [name, result] = map[r.name as string];
    const props = { ...(r.props ? JSON.parse(r.props as string) : {}), kind: "level", ...(result ? { result } : {}) };
    await env.DB.prepare("UPDATE events SET name = ?, props = ? WHERE event_id = ?").bind(name, JSON.stringify(props), r.event_id).run();
  }
}
