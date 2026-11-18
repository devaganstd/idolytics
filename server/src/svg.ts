import { esc } from "./html";

// Narrow viewBox so SVG text stays readable on a phone; CSS caps the width on desktop.
const W = 420;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Line chart over days, one or two series on one shared axis. Hover a point for its value. */
export function lineChart(days: string[], series: { name: string; cls: string; values: number[] }[]): string {
  if (!days.length) return `<p class="empty">No events yet.</p>`;
  const H = 180, L = 30, R = 64, T = 12, B = 22;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => L + (days.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (days.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const grid = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }).join("");
  const ticks = [0, days.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : "end"}">${esc(days[i].slice(5))}</text>`).join("");
  const last = days.length - 1;
  // End labels: push apart when the series end close together so they never overlap.
  const labelY = series.map((s, i) => ({ i, y: y(s.values[last]) + 4 })).sort((a, b) => a.y - b.y);
  labelY.forEach((l, k) => { if (k > 0) l.y = Math.max(l.y, labelY[k - 1].y + 14); });
  const lines = series.map((s, si) => {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const dots = s.values.map((v, i) => `<circle class="${s.cls}" cx="${x(i)}" cy="${y(v)}" r="4"><title>${esc(days[i])}: ${fmt(v)} ${esc(s.name)}</title></circle>`).join("");
    return `<polyline class="line ${s.cls}" points="${pts}"/>${dots}<text class="label" x="${x(last) + 8}" y="${labelY.find((l) => l.i === si)!.y}">${esc(s.name)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(" and "))} per day">${grid}${ticks}${lines}</svg>`;
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
