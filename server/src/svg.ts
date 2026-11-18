import { esc } from "./html";

// Narrow viewBox so SVG text stays readable on a phone; CSS caps the width on desktop.
const W = 420;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

interface Series { name: string; cls: string; values: number[] }

/** Round an axis maximum up to 1, 2 or 5 times a power of ten. */
const niceMax = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
};

/**
 * Stacked bars per day with an optional line on the same count axis. Each day links to href(day),
 * so a click applies that day as the range. Hover shows the day's values.
 */
export function dayBars(days: string[], stacks: Series[], line: Series | null, href: (day: string) => string): string {
  if (!days.length) return `<p class="empty">No days in range.</p>`;
  const H = 190, L = 30, R = 6, T = 10, B = 22, plot = H - T - B;
  const totals = days.map((_, i) => stacks.reduce((t, s) => t + s.values[i], 0));
  const max = niceMax(Math.max(1, ...totals, ...(line?.values ?? [])));
  const slot = (W - L - R) / days.length;
  const bw = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => T + plot * (1 - v / max);
  const grid = [0, 0.5, 1].map((f) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}"/>`
    + `<text class="axis" x="${L - 6}" y="${y(max * f) + 4}" text-anchor="end">${fmt(max * f)}</text>`).join("");
  const tickAt = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const ticks = tickAt.map((i, k) => `<text class="axis" x="${L + (i + 0.5) * slot}" y="${H - 6}"
    text-anchor="${tickAt.length > 1 && k === 0 ? "start" : k === tickAt.length - 1 && k > 0 ? "end" : "middle"}">${esc(days[i].slice(5))}</text>`).join("");
  const cols = days.map((d, i) => {
    const x = L + i * slot;
    let top = y(0);
    const segs = stacks.map((s) => {
      const h = (plot * s.values[i]) / max;
      top -= h;
      return h > 0 ? `<rect class="bar ${s.cls}" x="${x + (slot - bw) / 2}" y="${top}" width="${bw}" height="${h}"/>` : "";
    }).join("");
    const tip = [...stacks, ...(line ? [line] : [])].map((s) => `${s.name} ${fmt(s.values[i])}`).join(", ");
    return `<a href="${esc(href(d))}"><title>${esc(d)}: ${esc(tip)}</title><rect class="hit" x="${x}" y="${T}" width="${slot}" height="${plot}"/>${segs}</a>`;
  }).join("");
  const path = line ? `<polyline class="line ${line.cls}" points="${line.values.map((v, i) => `${L + (i + 0.5) * slot},${y(v)}`).join(" ")}"/>`
    + (days.length <= 31 ? line.values.map((v, i) => `<circle class="${line.cls}" cx="${L + (i + 0.5) * slot}" cy="${y(v)}" r="3"/>`).join("") : "") : "";
  const label = [...stacks, ...(line ? [line] : [])].map((s) => s.name).join(", ");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per day">${grid}${cols}${path}${ticks}</svg>`;
}

/** Horizontal bars, one series. Labels left, values right. */
export function barList(items: { label: string; value: number }[], unit = ""): string {
  if (!items.length) return `<p class="empty">Nothing yet.</p>`;
  const row = 24, H = items.length * row, L = 118, R = 44;
  const max = Math.max(1, ...items.map((i) => i.value));
  const bars = items.map((it, i) => {
    const w = Math.max(2, ((W - L - R) * it.value) / max);
    const y = i * row;
    return `<g><title>${esc(it.label)}: ${fmt(it.value)}${unit}</title>`
      + `<text class="axis" x="${L - 8}" y="${y + 17}" text-anchor="end">${esc(it.label.length > 18 ? it.label.slice(0, 17) + "…" : it.label)}</text>`
      + `<rect class="bar" x="${L}" y="${y + 5}" width="${w}" height="16" rx="4"/>`
      + `<text class="value" x="${L + w + 6}" y="${y + 17}">${fmt(it.value)}${unit}</text></g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="bar chart">${bars}</svg>`;
}
