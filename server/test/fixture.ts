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

/**
 * Hand counted idle game data, as SDK 0.2.1 sends it. i1 (android) and i2 (ios) install on 11-01. A run is one prestige cycle,
 * sent without a level, so it rolls up under the play key "(none)".
 *   Runs: i1 #1 08:05 11-01 to prestige 18:05 11-01 (value 5, 10 h, boost x2); i1 #2 18:06 11-01 to prestige 09:05 11-02 (12, 15 h, boost x2);
 *         i2 #1 12:05 11-01 to prestige 20:05 11-02 (3, 32 h); i1 #3 09:06 11-02, never ended: an inferred quit.
 *   Session gaps (since_last_ms): i1 30 min and 6 h on 11-01, 14 h on 11-02; i2 30 h and 2 h on 11-02. First sessions have none.
 *   Offline rewards (coins): i1 30 min free 1000 on 11-01, 14 h ad x2 2e12 on 11-02; i2 30 h ad x3 3e15 on 11-02. i1 earns 3e15 coins by tapping.
 *   Income per second (log10): i1 5000 on 11-01, 2e6 on 11-02; i2 500 on 11-01, 7e9 on 11-02.
 *   Tutorial: i2 begins, step 1, skips at step 2.
 */
export async function seedIdle() {
  const ios = { platform: "ios", country: "US" };
  const e = (name: string, device: string, session: string, ts: number, more: Record<string, unknown> = {}) =>
    raw({ name, device, session: device + session, ts, ...(device === "i2" ? ios : {}), ...more });
  const H = 3_600_000;
  const start = (device: string, s: string, ts: number, gap?: number) => e("session_start", device, s, ts, gap === undefined ? {} : { props: { since_last_ms: gap } });
  const run = (device: string, s: string, ts: number, attempt: number) => e("play_start", device, s, ts, { attempt, props: { kind: "run" } });
  const prestige = (device: string, s: string, ts: number, attempt: number, value: number, duration: number, boost?: string) =>
    e("play_end", device, s, ts, { attempt, value, duration, props: { kind: "run", result: "prestige", ...(boost ? { boost } : {}) } });
  const income = (device: string, s: string, ts: number, value: number) => e("progress", device, s, ts, { value, props: { track: "income_per_sec" } });
  const offline = (device: string, s: string, ts: number, duration: number, value: number, multiplier: number, via: string) =>
    e("offline_reward", device, s, ts, { duration, value, currency: "coins", props: { multiplier, via } });

  await start("i1", "a", at(0, 8));
  await run("i1", "a", at(0, 8, 5), 1);
  await income("i1", "a", at(0, 8, 10), 5000);
  await start("i1", "b", at(0, 10), 30 * MIN);
  await offline("i1", "b", at(0, 10) + 30_000, 30 * MIN, 1000, 1, "free");
  await e("currency_earned", "i1", "b", at(0, 10, 1), { value: 3e15, currency: "coins", props: { source: "tap" } });
  await start("i1", "c", at(0, 18), 6 * H);
  await prestige("i1", "c", at(0, 18, 5), 1, 5, 10 * H, "x2");
  await run("i1", "c", at(0, 18, 6), 2);
  await start("i1", "d", at(1, 9), 14 * H);
  await offline("i1", "d", at(1, 9) + 30_000, 14 * H, 2e12, 2, "ad");
  await prestige("i1", "d", at(1, 9, 5), 2, 12, 15 * H, "x2");
  await run("i1", "d", at(1, 9, 6), 3);
  await income("i1", "d", at(1, 9, 10), 2e6);

  await start("i2", "a", at(0, 12));
  await e("tutorial_begin", "i2", "a", at(0, 12, 1));
  await e("tutorial_step", "i2", "a", at(0, 12, 2), { props: { step: 1 } });
  await e("tutorial_skip", "i2", "a", at(0, 12, 3), { props: { step: 2 } });
  await run("i2", "a", at(0, 12, 5), 1);
  await income("i2", "a", at(0, 12, 10), 500);
  await start("i2", "b", at(1, 20), 30 * H);
  await offline("i2", "b", at(1, 20) + 30_000, 30 * H, 3e15, 3, "ad");
  await prestige("i2", "b", at(1, 20, 5), 1, 3, 32 * H);
  await income("i2", "b", at(1, 20, 10), 7e9);
  await start("i2", "c", at(1, 21), 2 * H);
}

/**
 * Hand counted match lengths on 11-01, board "arena", mode "ranked". h1 (android) and h2 (editor, dev plays).
 *   Completed plays, duration_ms in seconds / props.match_sec: h1 win 40/37, loss 70/66, draw 100/95; h2 win 3/1, loss 13/10.
 *   Not completed, so left out: h1 abandon 500/480 and quit 900/880.
 *   All: avg 45.2 s, median ≈ 37.5 s, p90 ≈ 105 s; match_sec avg 41.8, median ≈ 37.5, p90 ≈ 105.
 *   Without the editor: avg 70 s, median ≈ 75 s, p90 ≈ 111 s; match_sec avg 66, median ≈ 75, p90 ≈ 111.
 */
export async function seedDurations() {
  let attempt = 0;
  const play = async (device: string, ts: number, result: string, sec: number, matchSec: number) => {
    const props = { kind: "match", mode: "ranked" };
    const a = ++attempt;
    const more = { session: device + "s", level: "arena", attempt: a, platform: device === "h2" ? "editor" : "android" };
    await raw({ name: "play_start", device, ts, ...more, props });
    await raw({ name: "play_end", device, ts: ts + sec * 1000, ...more, duration: sec * 1000, props: { ...props, result, match_sec: matchSec } });
  };
  await play("h1", at(0, 10), "win", 40, 37);
  await play("h1", at(0, 10, 2), "loss", 70, 66);
  await play("h1", at(0, 10, 4), "draw", 100, 95);
  await play("h1", at(0, 10, 7), "abandon", 500, 480);
  await play("h1", at(0, 10, 20), "quit", 900, 880);
  await play("h2", at(0, 11), "win", 3, 1);
  await play("h2", at(0, 11, 1), "loss", 13, 10);
}
