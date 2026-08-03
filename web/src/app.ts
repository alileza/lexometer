// lexometer dashboard — Grafana-style panels rendered with uPlot (the same
// charting library Grafana's Time series panel uses).

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface Row { t: number; metric: string; labels: Record<string, string>; value: number }
interface Summary { rows: Row[]; metrics: string[]; lastReceived: number; now: number }

// Grafana classic palette, fixed assignment per token type
const GREEN = '#73BF69', BLUE = '#5794F2', YELLOW = '#FADE2A', ORANGE = '#FF9830', RED = '#F2495C';
const TOKEN_TYPES: [string, string][] = [
  ['cacheRead', BLUE], ['cacheCreation', GREEN], ['output', YELLOW], ['input', ORANGE],
];
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

// ---- time range picker (Grafana-style presets) ----
const RANGES: [string, number][] = [['6h', 6 * HOUR], ['24h', 24 * HOUR], ['7d', 7 * 86400], ['30d', 30 * 86400], ['All', 0]];
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
      points: { show: false },
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
      drag: { x: true, y: false },
      points: { size: 6, width: 2 },
    },
    scales: { x: { time: true } },
    axes: axisDefaults(fmt),
    plugins: [tooltipPlugin(fmt)],
  };

  const u = new uPlot(opts, data, body);
  plots.push(u);
}

function statPanel(value: string, label: string, cls = ''): string {
  return `<div class="panel stat-panel"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
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
  const today = day(s.now);

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
    + `</div>`;

  chartPanel(app, 'Cost', `USD per hour · ${activeRange}`,
    hourly(inRange, tMin, tMax, [isCost]),
    [{ label: 'cost', color: GREEN, fill: true }], fmtUSD);

  chartPanel(app, 'Token usage', `tokens per hour by type · ${activeRange}`,
    hourly(inRange, tMin, tMax, TOKEN_TYPES.map(([n]) => (r: Row) => isTok(r) && r.labels['type'] === n)),
    TOKEN_TYPES.map(([n, c]) => ({ label: n, color: c, fill: true })), fmtTok);

  chartPanel(app, 'Sessions', `sessions started per hour · ${activeRange}`,
    hourly(inRange, tMin, tMax, [isSession]),
    [{ label: 'sessions', color: BLUE, bars: true }], v => v == null ? '–' : String(Math.round(v)), 140);

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
setInterval(() => { if (!wsOpen) tick(); }, 10_000);
setInterval(() => { if (wsOpen) tick(); }, 30_000); // refresh relative timestamps
