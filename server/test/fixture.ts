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
