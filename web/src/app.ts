// lexometer dashboard — Grafana-style panels rendered with uPlot (the same
// charting library Grafana's Time series panel uses).

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface Row { t: number; metric: string; labels: Record<string, string>; value: number }
interface Summary { rows: Row[]; metrics: string[]; lastReceived: number; now: number }

// Grafana classic palette, fixed assignment per token type
const GREEN = '#73BF69', BLUE = '#5794F2', YELLOW = '#FADE2A', ORANGE = '#FF9830',
      RED = '#F2495C', PURPLE = '#B877D9';
const TOKEN_TYPES: [string, string][] = [
  ['cacheRead', BLUE], ['cacheCreation', GREEN], ['output', YELLOW], ['input', ORANGE],
];
// distinct models get palette slots in first-seen sorted order, stable across renders
const MODEL_PALETTE = [GREEN, BLUE, YELLOW, ORANGE, RED, PURPLE, '#37872D', '#1F60C4'];
const TEXT_DIM = 'rgba(204,204,220,0.65)';
const GRID = 'rgba(204,204,220,0.07)';
const HOUR = 3600;

const app = document.getElementById('app')!;
const tip = document.getElementById('tip')!;
const statusEl = document.getElementById('status')!;
const statusText = document.getElementById('status-text')!;
const rangesEl = document.getElementById('ranges')!;

const fmtUSD = (v: number | null) => v == null ? '–' : '$' + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const fmtTok = (v: number | null) =>
  v == null ? '–' :
  v >= 1e9 ? (v / 1e9).toFixed(2) + ' B' : v >= 1e6 ? (v / 1e6).toFixed(1) + ' M' :
  v >= 1e3 ? (v / 1e3).toFixed(1) + ' K' : String(Math.round(v));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fmtDur = (sec: number) => {
  if (sec < 60) return Math.round(sec) + 's';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// ---- time range picker (Grafana-style presets) ----
const RANGES: [string, number][] = [['24h', 24 * HOUR], ['7d', 7 * 86400], ['30d', 30 * 86400], ['All', 0]];
let activeRange = '7d';
for (const [name] of RANGES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.className = name === activeRange ? 'active' : '';
  b.onclick = () => {
    activeRange = name;
    rangesEl.querySelectorAll('button').forEach(x => x.className = x.textContent === name ? 'active' : '');
    if (lastSummary) render(lastSummary);
  };
  rangesEl.appendChild(b);
}

function sum(rows: Row[], pred: (r: Row) => boolean): number {
  let s = 0;
  for (const r of rows) if (pred(r)) s += r.value;
  return s;
}
function byDay(rows: Row[], pred: (r: Row) => boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (pred(r)) m.set(day(r.t), (m.get(day(r.t)) ?? 0) + r.value);
  return m;
}

// Aligned hourly series over [t0, t1] for uPlot: xs plus one values array per bucket fn.
function hourly(rows: Row[], t0: number, t1: number, buckets: ((r: Row) => boolean)[]): uPlot.AlignedData {
  const xs: number[] = [];
  for (let t = t0; t <= t1; t += HOUR) xs.push(t);
  const idx = new Map<number, number>();
  xs.forEach((t, i) => idx.set(t, i));
  const series = buckets.map(() => xs.map(() => 0) as (number | null)[]);
  for (const r of rows) {
    const i = idx.get(r.t);
    if (i === undefined) continue;
    buckets.forEach((pred, s) => { if (pred(r)) series[s]![i] = (series[s]![i] ?? 0) + r.value; });
  }
  return [xs, ...series] as uPlot.AlignedData;
}

// ---- Grafana-style shared tooltip as a uPlot plugin ----
function tooltipPlugin(fmt: (v: number | null) => string): uPlot.Plugin {
  return {
    hooks: {
      setCursor: (u: uPlot) => {
        const { left, top, idx } = u.cursor;
        if (idx == null || left == null || left < 0 || top == null || top < 0) {
          tip.style.display = 'none';
          return;
        }
        const x = u.data[0][idx]!;
        let rowsHTML = '';
        for (let s = 1; s < u.series.length; s++) {
          const srs = u.series[s]!;
          if (!srs.show) continue;
          const v = (u.data[s] as (number | null)[])[idx] ?? null;
          const color = typeof srs.stroke === 'string' ? srs.stroke : '';
          rowsHTML += `<div class="tr"><span class="sw" style="background:${color}"></span>` +
            `<span class="nm">${srs.label}</span><span class="vl">${fmt(v)}</span></div>`;
        }
        tip.innerHTML = `<div class="tt">${new Date(x * 1000).toLocaleString(undefined,
          { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` + rowsHTML;
        tip.style.display = 'block';
        const rect = u.over.getBoundingClientRect();
        let px = rect.left + left + 14;
        if (px + tip.offsetWidth > window.innerWidth - 8) px = rect.left + left - tip.offsetWidth - 14;
        tip.style.left = px + 'px';
        tip.style.top = Math.min(rect.top + top + 14, window.innerHeight - tip.offsetHeight - 8) + 'px';
      },
    },
  };
}

const axisDefaults = (fmt: (v: number | null) => string): uPlot.Axis[] => [
  {
    stroke: TEXT_DIM, font: '11px Inter, sans-serif',
    grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 },
  },
  {
    stroke: TEXT_DIM, font: '11px Inter, sans-serif', size: 58,
    grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 },
    values: (_u: uPlot, ticks: number[]) => ticks.map(v => fmt(v)),
  },
];

interface SeriesDef { label: string; color: string; fill?: boolean; bars?: boolean }

let plots: uPlot[] = [];

function chartPanel(parent: Element, title: string, desc: string, data: uPlot.AlignedData,
                    defs: SeriesDef[], fmt: (v: number | null) => string, height = 220): void {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="panel-title">${title} <span class="desc">${desc}</span></div><div class="panel-body"></div>`;
  parent.appendChild(panel);
  const body = panel.querySelector('.panel-body') as HTMLElement;

  const series: uPlot.Series[] = [
    {},
    ...defs.map((d): uPlot.Series => ({
      label: d.label,
      stroke: d.color,
      width: 2,
      // sparse series need visible markers, like Grafana's auto point display
      points: { show: data[0].length <= 60, size: 5, fill: d.color },
      ...(d.fill ? { fill: d.color + '2e' } : {}), // ~18% alpha fill, Grafana default look
      ...(d.bars ? { paths: uPlot.paths.bars!({ size: [0.6, 100] }), fill: d.color + '99' } : {}),
    })),
  ];

  const opts: uPlot.Options = {
    width: Math.max(320, body.clientWidth || 1120),
    height,
    series,
    legend: { live: false },
    cursor: {
      drag: { x: false, y: false },
      points: { size: 6, width: 2 },
    },
    scales: {
      x: { time: true },
      // counters are zero-based; pad the top so peaks don't kiss the frame
      y: { range: (_u, _min, max) => [0, Math.max(max * 1.15, 1)] },
    },
    axes: axisDefaults(fmt),
    plugins: [tooltipPlugin(fmt)],
  };

  const u = new uPlot(opts, data, body);
  plots.push(u);
}

function statPanel(value: string, label: string, cls = ''): string {
  return `<div class="panel stat-panel"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

// Grafana-style donut: SVG arcs + center total + legend with values and shares.
function donutPanel(parent: Element, title: string, desc: string,
                    slices: [string, number, string][], fmt: (v: number | null) => string): void {
  const total = slices.reduce((a, s) => a + s[1], 0);
  const panel = document.createElement('div');
  panel.className = 'panel';
  const R = 56, CX = 70, CY = 70, W2 = 16;
  let angle = -Math.PI / 2;
  let arcs = '';
  for (const [label, value, color] of slices) {
    if (value <= 0 || total <= 0) continue;
    const frac = value / total;
    const a0 = angle, a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    // 2px gap between arcs unless a slice is the whole ring
    const gap = slices.filter(s => s[1] > 0).length > 1 ? 0.03 : 0;
    const b0 = a0 + gap, b1 = Math.max(a1 - gap, b0 + 0.01);
    const large = b1 - b0 > Math.PI ? 1 : 0;
    const x0 = CX + R * Math.cos(b0), y0 = CY + R * Math.sin(b0);
    const x1 = CX + R * Math.cos(b1), y1 = CY + R * Math.sin(b1);
    arcs += `<path d="M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}"
      fill="none" stroke="${color}" stroke-width="${W2}"><title>${label}: ${fmt(value)}</title></path>`;
  }
  const legend = slices.map(([label, value, color]) =>
    `<div class="dl-row"><span class="sw" style="background:${color}"></span>` +
    `<span class="nm" title="${label}">${label}</span><span class="vl">${fmt(value)}</span>` +
    `<span class="pc">${total > 0 ? (value / total * 100).toFixed(1) : '0.0'}%</span></div>`).join('');
  panel.innerHTML = `<div class="panel-title">${title} <span class="desc">${desc}</span></div>
    <div class="panel-body"><div class="donut-wrap">
    <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="${title}">
      ${arcs}
      <text x="${CX}" y="${CY - 2}" text-anchor="middle" fill="#ccccdc" font-size="17" font-weight="500" class="donut-center">${fmt(total)}</text>
      <text x="${CX}" y="${CY + 15}" text-anchor="middle" fill="rgba(204,204,220,0.4)" font-size="10">total</text>
    </svg>
    <div class="donut-legend">${legend}</div>
    </div></div>`;
  parent.appendChild(panel);
}

let lastSummary: Summary | null = null;

function render(s: Summary) {
  lastSummary = s;
  const rows = s.rows ?? [];
  const live = s.lastReceived > 0 && s.now - s.lastReceived < 120;
  statusEl.className = live ? 'live' : '';
  statusText.textContent = s.lastReceived === 0 ? 'waiting for telemetry…'
    : `last data ${Math.max(0, s.now - s.lastReceived)}s ago`;

  for (const p of plots) p.destroy();
  plots = [];
  tip.style.display = 'none';

  if (rows.length === 0) {
    app.innerHTML = `<div id="empty"><strong>No telemetry yet.</strong> Point Claude Code at lexometer and start a session:
<pre>export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_RESOURCE_ATTRIBUTES="skills_enabled=false"</pre>
Flip <code>skills_enabled</code> to <code>true</code> when you enable an intervention — the dashboard splits before/after on it.</div>`;
    return;
  }

  const isCost = (r: Row) => r.metric === 'claude_code.cost.usage';
  const isTok = (r: Row) => r.metric === 'claude_code.token.usage';
  const isSession = (r: Row) => r.metric === 'claude_code.session.count';
  const isActive = (r: Row) => r.metric === 'claude_code.active_time.total';
  const today = day(s.now);
  const model = (r: Row) => r.labels['model'] ?? 'unknown';
  const models = [...new Set(rows.filter(isCost).map(model))].sort();
  const modelColor = new Map(models.map((m, i) => [m, MODEL_PALETTE[i % MODEL_PALETTE.length]!]));

  // time window from range preset
  const rangeSec = RANGES.find(r => r[0] === activeRange)![1];
  const tMax = Math.ceil(s.now / HOUR) * HOUR;
  const tMinData = Math.min(...rows.map(r => r.t));
  const tMin = rangeSec === 0 ? tMinData : Math.max(tMinData, tMax - rangeSec);
  const inRange = rows.filter(r => r.t >= tMin);

  app.innerHTML = `<div class="row stats">`
    + statPanel(fmtUSD(sum(rows, isCost)), 'total cost recorded', 'green')
    + statPanel(fmtUSD(sum(rows, r => isCost(r) && day(r.t) === today)), 'cost today', 'blue')
    + statPanel(fmtTok(sum(rows, isTok)), 'total tokens')
    + statPanel(String(Math.round(sum(rows, isSession))), 'sessions')
    + statPanel(fmtDur(sum(rows, r => isActive(r) && day(r.t) === today)), 'active time today')
    + `</div>`;

  chartPanel(app, 'Cost', `USD per hour · ${activeRange}`,
    hourly(inRange, tMin, tMax, [isCost]),
    [{ label: 'cost', color: GREEN, fill: true }], fmtUSD);

  // model breakdown: share donut + per-model series, Grafana-dashboard style
  const halfRow = document.createElement('div');
  halfRow.className = 'row half';
  app.appendChild(halfRow);
  donutPanel(halfRow, 'Cost by model', 'share of total recorded cost',
    models.map(m => [m, sum(rows, r => isCost(r) && model(r) === m), modelColor.get(m)!]), fmtUSD);
  donutPanel(halfRow, 'Tokens by type', 'share of all tokens recorded',
    TOKEN_TYPES.map(([n, c]) => [n, sum(rows, r => isTok(r) && r.labels['type'] === n), c]), fmtTok);

  if (models.length > 0) {
    chartPanel(app, 'Cost by model', `USD per hour per model · ${activeRange}`,
      hourly(inRange, tMin, tMax, models.map(m => (r: Row) => isCost(r) && model(r) === m)),
      models.map(m => ({ label: m, color: modelColor.get(m)!, fill: true })), fmtUSD, 180);
  }

  chartPanel(app, 'Token usage', `tokens per hour by type · ${activeRange}`,
    hourly(inRange, tMin, tMax, TOKEN_TYPES.map(([n]) => (r: Row) => isTok(r) && r.labels['type'] === n)),
    TOKEN_TYPES.map(([n, c]) => ({ label: n, color: c, fill: true })), fmtTok);

  chartPanel(app, 'Sessions', `sessions started per hour · ${activeRange}`,
    hourly(inRange, tMin, tMax, [isSession]),
    [{ label: 'sessions', color: BLUE, bars: true }], v => v == null ? '–' : String(Math.round(v)), 140);

  chartPanel(app, 'Active time', `seconds of active Claude Code use per hour · ${activeRange}`,
    hourly(inRange, tMin, tMax, [isActive]),
    [{ label: 'active', color: PURPLE, fill: true }], v => v == null ? '–' : fmtDur(v), 140);

  // before/after comparison when both phases have data
  const phases = [...new Set(rows.map(r => r.labels['skills_enabled']).filter(Boolean))];
  if (phases.length >= 2) {
    const avg = (phase: string) => {
      const m = byDay(rows, r => isCost(r) && r.labels['skills_enabled'] === phase);
      const vals = [...m.values()];
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const before = avg('false'), after = avg('true');
    const delta = before > 0 ? ((after - before) / before) * 100 : 0;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="panel-title">Before vs after <span class="desc">average cost per active day, split on skills_enabled — your measured number, not a vendor claim</span></div>
      <div class="panel-body"><div class="row stats" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      ${statPanel(fmtUSD(before), 'avg $/day · skills_enabled=false')}
      ${statPanel(fmtUSD(after), 'avg $/day · skills_enabled=true')}
      ${statPanel((delta <= 0 ? '' : '+') + delta.toFixed(1) + '%', 'change (negative = saving)', delta <= 0 ? 'green' : 'red')}
      </div></div>`;
    app.appendChild(panel);
  }

  // everything received, so nothing is silently hidden
  const table = document.createElement('div');
  table.className = 'panel';
  table.innerHTML = `<div class="panel-title">All metrics received <span class="desc">totals across the whole recording window</span></div>
    <div class="panel-body"><table><tr><th>Metric</th><th class="num">Total</th></tr>
    ${(s.metrics ?? []).map(m => `<tr><td>${m}</td><td class="num">${fmtTok(sum(rows, r => r.metric === m))}</td></tr>`).join('')}
    </table></div>`;
  app.appendChild(table);
}

window.addEventListener('resize', () => {
  for (const p of plots) {
    const body = p.root.closest('.panel')?.querySelector('.panel-body') as HTMLElement | null;
    if (body) p.setSize({ width: Math.max(320, body.clientWidth), height: p.height });
  }
});

// ---- realtime panel: 1s sampling of /api/live, rolling 10-minute window ----
// (same pattern as a live admin panel: poll fast, keep client-side history,
// plot the per-second delta as a rate — no zoom, it just scrolls)
const LIVE_WINDOW = 600;
function initLive() {
  const liveRoot = document.getElementById('live')!;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="panel-title">Live <span class="desc">tokens per second, last 10 minutes · updates every second</span>
    <span class="rate" id="live-rate"></span></div><div class="panel-body"></div>`;
  liveRoot.appendChild(panel);
  const body = panel.querySelector('.panel-body') as HTMLElement;
  const rateEl = panel.querySelector('#live-rate') as HTMLElement;

  const xs: number[] = [], ys: (number | null)[] = [];
  const u = new uPlot({
    width: Math.max(320, body.clientWidth || 1120),
    height: 110,
    series: [
      {},
      { label: 'tokens/s', stroke: GREEN, width: 2, fill: GREEN + '2e', points: { show: false } },
    ],
    legend: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 6, width: 2 } },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, Math.max(max * 1.15, 10)] },
    },
    axes: axisDefaults(v => fmtTok(v)),
    plugins: [tooltipPlugin(v => v == null ? '–' : fmtTok(v) + '/s')],
  }, [xs, ys] as uPlot.AlignedData, body);
  plotsLive = u;

  let prev: { t: number; tokens: number } | null = null;
  const sample = async () => {
    try {
      const r = await fetch('/api/live');
      const j = await r.json() as { now: number; tokens: number; cost: number };
      const t = j.now / 1000;
      if (prev && t > prev.t) {
        const rate = Math.max(0, (j.tokens - prev.tokens) / (t - prev.t));
        xs.push(t);
        ys.push(rate);
        if (xs.length > LIVE_WINDOW) { xs.shift(); ys.shift(); }
        u.setData([xs, ys] as uPlot.AlignedData);
        rateEl.textContent = rate > 0 ? `▲ ${fmtTok(rate)}/s` : 'idle';
        rateEl.style.color = rate > 0 ? GREEN : 'rgba(204,204,220,0.4)';
      }
      prev = { t, tokens: j.tokens };
    } catch { /* server away; the status line already says so */ }
  };
  sample();
  setInterval(sample, 1000);
}
let plotsLive: uPlot | null = null;

async function tick() {
  try {
    const res = await fetch('/api/summary');
    render(await res.json() as Summary);
  } catch {
    statusEl.className = '';
    statusText.textContent = 'lexometer unreachable';
  }
}

// Live updates over WebSocket: the server pushes a full summary on connect and
// after every telemetry batch. Polling remains as the fallback while the socket
// is down (and as a slow keepalive refresh for the "last data Ns ago" counter).
let wsOpen = false;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { wsOpen = true; };
  ws.onmessage = (ev) => {
    try { render(JSON.parse(ev.data as string) as Summary); } catch { /* ignore bad frame */ }
  };
  ws.onclose = () => {
    wsOpen = false;
    setTimeout(connect, 3000);
  };
  ws.onerror = () => ws.close();
}

tick();
connect();
initLive();
setInterval(() => { if (!wsOpen) tick(); }, 10_000);
setInterval(() => { if (wsOpen) tick(); }, 30_000); // refresh relative timestamps
