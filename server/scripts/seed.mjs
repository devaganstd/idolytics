// Posts sample Ninja Smash style sessions to a running idolytics server, as the Unity adapter would send them.
// Usage: node scripts/seed.mjs <server-url> <write-key> [players]
const [url, key, playersArg] = process.argv.slice(2);
if (!url || !key) {
  console.error("Usage: node scripts/seed.mjs <server-url> <write-key> [players]");
  process.exit(1);
}
const players = Number(playersArg ?? 12);
const DAY = 86_400_000;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const winChance = (level) => Math.max(0.25, 0.9 - level * 0.08);

let accepted = 0;
for (let p = 0; p < players; p++) {
  const device = crypto.randomUUID();
  const platform = pick(["android", "webgl", "ios"]);
  const sessionDays = 1 + Math.floor(Math.random() * 5);
  let level = 1;
  for (let d = sessionDays - 1; d >= 0; d--) {
    const session = crypto.randomUUID();
    let ts = Date.now() - d * DAY - 3 * 3_600_000 - Math.floor(Math.random() * 3_600_000);
    const events = [];
    const add = (name, extra = {}) => events.push({ event_id: crypto.randomUUID(), name, ts: (ts += 1000 + Math.floor(Math.random() * 4000)), session_id: session, ...extra });
    add("session_start");
    const attempts = {};
    for (let round = 0; round < 6 && level <= 10; round++) {
      const attempt = (attempts[level] = (attempts[level] ?? 0) + 1);
      add("level_start", { level: String(level), attempt });
      if (Math.random() < 0.15) add("booster_bought", { level: String(level), props: { booster: pick([0, 1, 2]) } });
      if (Math.random() < 0.1) add("try_taken", { level: String(level), props: { booster: pick([0, 1, 2]), free: 1 } });
      const duration_ms = 15_000 + Math.floor(Math.random() * 60_000);
      ts += duration_ms;
      if (Math.random() < 0.08) break; // player closes the game mid level: the server infers a quit
      if (Math.random() < winChance(level)) {
        add("level_complete", { level: String(level), attempt, duration_ms, props: { moves_left: Math.floor(Math.random() * 4) } });
        level++;
      } else {
        add("level_fail", { level: String(level), attempt, duration_ms, props: { targets_left: 1 + Math.floor(Math.random() * 3), reason: "out_of_moves" } });
        if (Math.random() < 0.3) add("continue_watched", { level: String(level) });
      }
    }
    if (Math.random() < 0.3) add("name_set");
    const res = await fetch(new URL("/v1/events", url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ schema: 1, sdk: "seed/0.1.0", device_id: device, app_version: "1.0.0", platform, os: "seed", events }),
    });
    const body = await res.json();
    if (res.status !== 202) {
      console.error(res.status, body);
      process.exit(1);
    }
    accepted += body.accepted;
  }
}
console.log(`Sent ${accepted} events for ${players} players.`);
