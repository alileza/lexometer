// lexometer dashboard — Grafana-style panels rendered with uPlot (the same
// charting library Grafana's Time series panel uses).

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface Row { t: number; metric: string; labels: Record<string, string>; value: number }
interface Summary { rows: Row[]; metrics: string[]; lastReceived: number; logsLastReceived: number; now: number }

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

// uPlot must be sized to the panel body's *content* width — body.clientWidth
// includes the 12px horizontal padding, so using it directly overflows the
// canvas past the panel's right edge (the asymmetry). Subtract the padding.
function contentWidth(body: HTMLElement): number {
  const cs = getComputedStyle(body);
  const pad = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
  return Math.max(280, Math.floor((body.clientWidth || 1120) - pad));
}
// Keep every chart sized to its container as the layout changes (sidebar,
// scrollbar appearing, window resize). One observer, all live charts.
const sizeObserver = new ResizeObserver(entries => {
  for (const e of entries) {
    const u = (e.target as HTMLElement & { _u?: uPlot })._u;
    if (u) u.setSize({ width: contentWidth(e.target as HTMLElement), height: u.height });
  }
});
function autosize(u: uPlot, body: HTMLElement & { _u?: uPlot }) {
  body._u = u;
  sizeObserver.observe(body);
}
// Unobserve before destroying so the observer doesn't retain dead charts.
function destroyPlot(u: uPlot) {
  const body = u.root.closest('.panel-body');
  if (body) sizeObserver.unobserve(body);
  u.destroy();
}

function chartPanel(parent: Element, title: string, desc: string, data: uPlot.AlignedData,
                    defs: SeriesDef[], fmt: (v: number | null) => string, height = 220): uPlot {
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
    width: contentWidth(body),
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
  autosize(u, body);
  return u;
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

// ---- per-prompt performance from telemetry log events ----
interface Ev { t: number; session: string; name: string; attrs: Record<string, string> }
let eventsCache: Ev[] = [];
let evPlots: uPlot[] = [];

const num = (a: Record<string, string>, ...keys: string[]): number => {
  for (const k of keys) {
    const v = parseFloat(a[k] ?? '');
    if (!isNaN(v)) return v;
  }
  return 0;
};
// Claude Code's attribute name for the prompt text isn't guaranteed; try the
// likely candidates so a version rename doesn't silently blank the column.
const promptText = (a: Record<string, string>): string =>
  a['prompt'] ?? a['prompt_text'] ?? a['user_prompt'] ?? a['event.prompt'] ?? '';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmmss = (ms: number) => new Date(ms).toLocaleTimeString();

async function refreshEvents() {
  try {
    const r = await fetch('/api/events');
    eventsCache = (await r.json() as Ev[] | null) ?? [];
    renderEvents();
    renderSetup();
  } catch { /* server away */ }
}

// Setup checklist: lexometer can't see Claude Code's environment, so each item
// is verified by whether its data actually arrives — ground truth, not claims.
function renderSetup() {
  const root = document.getElementById('setup-root');
  const s = lastSummary;
  if (!root || !s) return;

  const fresh = (ts: number) => ts > 0;
  const ago = (ts: number) => ts > 0 ? `last data ${Math.max(0, s.now - ts)}s ago` : '';
  const hasSkillsFlag = (s.rows ?? []).some(r => r.labels['skills_enabled']);
  const skillsVals = [...new Set((s.rows ?? []).map(r => r.labels['skills_enabled']).filter(Boolean))].join(', ');
  const hasPromptText = eventsCache.some(e => e.name.includes('user_prompt') && promptText(e.attrs) !== '');

  interface Check { ok: boolean; label: string; detail: string; fix: string; optional?: boolean }
  const checks: Check[] = [
    {
      ok: fresh(s.lastReceived), label: 'Metrics stream',
      detail: fresh(s.lastReceived) ? ago(s.lastReceived) : 'no metrics ever received',
      fix: 'export CLAUDE_CODE_ENABLE_TELEMETRY=1\nexport OTEL_METRICS_EXPORTER=otlp\nexport OTEL_EXPORTER_OTLP_PROTOCOL=http/json\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318',
    },
    {
      ok: fresh(s.logsLastReceived), label: 'Events stream (per-prompt views)',
      detail: fresh(s.logsLastReceived) ? ago(s.logsLastReceived) : 'no log events received — the Prompts and context-buildup panels need this',
      fix: 'export OTEL_LOGS_EXPORTER=otlp',
    },
    {
      ok: hasSkillsFlag, label: 'Experiment flag (before/after)',
      detail: hasSkillsFlag ? `skills_enabled seen: ${skillsVals}` : 'no skills_enabled label on any data — the before/after panel needs it',
      fix: 'export OTEL_RESOURCE_ATTRIBUTES="skills_enabled=false"   # flip to true when you enable an intervention',
    },
    {
      ok: hasPromptText, label: 'Prompt text (optional)', optional: true,
      detail: hasPromptText ? 'prompt text included in events' : 'prompts show as length only — opt in to log the text itself',
      fix: 'export OTEL_LOG_USER_PROMPTS=1',
    },
  ];

  const missing = checks.filter(c => !c.ok && !c.optional).length;
  const rowsHTML = checks.map(c => `
    <div style="display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid rgba(204,204,220,0.05)">
      <span style="flex:none;width:16px;color:${c.ok ? '#73BF69' : c.optional ? 'rgba(204,204,220,0.4)' : '#F2495C'}">${c.ok ? '✓' : c.optional ? '○' : '✗'}</span>
      <span style="flex:none;min-width:220px">${c.label}</span>
      <span style="flex:1;color:rgba(204,204,220,0.5);font-size:12px">${c.detail}</span>
    </div>
    ${c.ok ? '' : `<pre style="margin:4px 0 8px 26px;font-family:var(--mono);font-size:11.5px;background:#0b0c0e;border:1px solid #23262b;border-radius:4px;padding:8px 10px;overflow-x:auto;color:#FADE2A">${c.fix}</pre>`}`).join('');

  root.innerHTML = `<div class="panel" style="margin-bottom:8px"><div class="panel-title">Telemetry setup
    <span class="desc">${missing === 0 ? 'everything wired — detected from live data, not from claimed config' : `${missing} piece${missing > 1 ? 's' : ''} missing — add to your shell profile, then start a new Claude Code session`}</span></div>
    <div class="panel-body" style="font-size:13px">${rowsHTML}</div></div>`;
}

function renderEvents() {
  const root = document.getElementById('events-root');
  if (!root) return;
  for (const p of evPlots) { destroyPlot(p); plots = plots.filter(x => x !== p); }
  evPlots = [];
  root.innerHTML = '';

  const evs = [...eventsCache].sort((a, b) => a.t - b.t);
  const reqs = evs.filter(e => e.name.includes('api_request'));
  if (reqs.length === 0) {
    root.innerHTML = `<div class="panel"><div class="panel-title">Per-prompt performance
      <span class="desc">needs the events stream — add <code>export OTEL_LOGS_EXPORTER=otlp</code> to your shell profile and restart your Claude Code session</span></div></div>`;
    return;
  }

  const ctxOf = (a: Record<string, string>) =>
    num(a, 'input_tokens') + num(a, 'cache_read_tokens') + num(a, 'cache_creation_tokens');

  // context build-up: tokens sent per API request — the staircase you pay for
  const recent = reqs.slice(-300);
  evPlots.push(chartPanel(root, 'Context sent per request',
    'input + cache tokens on each API call — how the context builds up',
    [recent.map(e => e.t / 1000), recent.map(e => ctxOf(e.attrs))] as uPlot.AlignedData,
    [{ label: 'context tokens', color: ORANGE, fill: true }], fmtTok, 180));

  // group api_requests + tool events under the user_prompt that caused them, per session
  interface Group {
    t: number; text: string; len: number; calls: number; cost: number; durMs: number;
    cr: number; cc: number; inp: number; out: number; tools: Map<string, number>;
  }
  const groups: Group[] = [];
  const current = new Map<string, Group>();
  for (const e of evs) {
    if (e.name.includes('user_prompt')) {
      const g: Group = {
        t: e.t, text: promptText(e.attrs), len: num(e.attrs, 'prompt_length'),
        calls: 0, cost: 0, durMs: 0, cr: 0, cc: 0, inp: 0, out: 0, tools: new Map(),
      };
      groups.push(g);
      current.set(e.session, g);
    } else {
      const g = current.get(e.session);
      if (!g) continue;
      if (e.name.includes('api_request')) {
        g.calls++;
        g.cr += num(e.attrs, 'cache_read_tokens');
        g.cc += num(e.attrs, 'cache_creation_tokens');
        g.inp += num(e.attrs, 'input_tokens');
        g.out += num(e.attrs, 'output_tokens');
        g.cost += num(e.attrs, 'cost_usd', 'cost');
        g.durMs += num(e.attrs, 'duration_ms');
      } else if (e.name.includes('tool_result') || e.name.includes('tool_decision')) {
        const tn = e.attrs['tool_name'] ?? e.attrs['name'] ?? 'tool';
        g.tools.set(tn, (g.tools.get(tn) ?? 0) + 1);
      }
    }
  }

  // stacked mini-bar: how one prompt's tokens split across the four types
  const distBar = (g: Group): string => {
    const parts: [string, number, string][] = [
      ['cacheRead', g.cr, BLUE], ['cacheCreation', g.cc, GREEN],
      ['output', g.out, YELLOW], ['input', g.inp, ORANGE],
    ];
    const total = g.cr + g.cc + g.out + g.inp;
    if (total <= 0) return '';
    const title = parts.map(([n, v]) => `${n}: ${fmtTok(v)} (${(v / total * 100).toFixed(1)}%)`).join('\n');
    const segs = parts.filter(([, v]) => v > 0).map(([, v, c]) =>
      `<div style="flex:${(v / total * 1000).toFixed(0)};background:${c}"></div>`).join('');
    return `<div class="dist" title="${esc(title)}">${segs}</div>`;
  };
  const toolsCell = (g: Group): string => {
    if (g.tools.size === 0) return '<span style="color:rgba(204,204,220,0.35)">–</span>';
    const items = [...g.tools.entries()].sort((a, b) => b[1] - a[1]);
    const shown = items.slice(0, 3).map(([n, c]) => c > 1 ? `${esc(n)}×${c}` : esc(n)).join(', ');
    const more = items.length > 3 ? ` +${items.length - 3}` : '';
    return `<span title="${esc(items.map(([n, c]) => `${n}×${c}`).join(', '))}">${shown}${more}</span>`;
  };

  const latest = groups.slice(-25).reverse();
  if (latest.length > 0) {
    const table = document.createElement('div');
    table.className = 'panel';
    table.innerHTML = `<div class="panel-title">Prompts <span class="desc">what each prompt actually cost, and where its tokens went (hover the bar for the split)</span></div>
      <div class="panel-body"><table>
      <tr><th>Time</th><th>Prompt</th><th class="num">API calls</th><th class="num">Tokens</th><th>Distribution</th><th>Tools</th><th class="num">Cost</th><th class="num">Duration</th></tr>
      ${latest.map(g => `<tr>
        <td>${hhmmss(g.t)}</td>
        <td>${g.text ? esc(g.text.slice(0, 60)) + (g.text.length > 60 ? '…' : '') : `<span style="color:rgba(204,204,220,0.4)">${g.len} chars</span>`}</td>
        <td class="num">${g.calls}</td>
        <td class="num">${fmtTok(g.cr + g.cc + g.inp + g.out)}</td>
        <td>${distBar(g)}</td>
        <td>${toolsCell(g)}</td>
        <td class="num">${g.cost >= 0.005 ? fmtUSD(g.cost) : '$' + g.cost.toFixed(3)}</td>
        <td class="num">${(g.durMs / 1000).toFixed(1)}s</td>
      </tr>`).join('')}
      </table></div>`;
    root.appendChild(table);
  }
}

function render(s: Summary) {
  lastSummary = s;
  const rows = s.rows ?? [];
  const live = s.lastReceived > 0 && s.now - s.lastReceived < 120;
  statusEl.className = live ? 'live' : '';
  statusText.textContent = s.lastReceived === 0 ? 'waiting for telemetry…'
    : `last data ${Math.max(0, s.now - s.lastReceived)}s ago`;

  for (const p of plots) destroyPlot(p);
  plots = [];
  tip.style.display = 'none';

  if (rows.length === 0) {
    app.innerHTML = `<div id="empty"><strong>No telemetry yet.</strong> Point Claude Code at lexometer and start a session:
<pre>export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
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

  feedLive(sum(rows, isTok), s.now); // realtime panel rides the same summary
  const model = (r: Row) => r.labels['model'] ?? 'unknown';
  const models = [...new Set(rows.filter(isCost).map(model))].sort();
  const modelColor = new Map(models.map((m, i) => [m, MODEL_PALETTE[i % MODEL_PALETTE.length]!]));

  const tMax = Math.ceil(s.now / HOUR) * HOUR;
  const tMin = Math.min(...rows.map(r => r.t));
  const inRange = rows;

  app.innerHTML = `<div class="row stats">`
    + statPanel(fmtUSD(sum(rows, isCost)), 'total cost recorded', 'green')
    + statPanel(fmtUSD(sum(rows, r => isCost(r) && day(r.t) === today)), 'cost today', 'blue')
    + statPanel(fmtTok(sum(rows, isTok)), 'total tokens')
    + statPanel(String(Math.round(sum(rows, isSession))), 'sessions')
    + statPanel(fmtDur(sum(rows, r => isActive(r) && day(r.t) === today)), 'active time today')
    + `</div><div id="setup-root"></div>`;
  renderSetup();

  chartPanel(app, 'Cost', 'USD per hour',
    hourly(inRange, tMin, tMax, [isCost]),
    [{ label: 'cost', color: GREEN, fill: true }], fmtUSD);

  // per-prompt views live here, filled from /api/events (survives async refresh)
  const evRoot = document.createElement('div');
  evRoot.id = 'events-root';
  app.appendChild(evRoot);
  renderEvents();
  void refreshEvents();

  // model breakdown: share donut + per-model series, Grafana-dashboard style
  const halfRow = document.createElement('div');
  halfRow.className = 'row half';
  app.appendChild(halfRow);
  donutPanel(halfRow, 'Cost by model', 'share of total recorded cost',
    models.map(m => [m, sum(rows, r => isCost(r) && model(r) === m), modelColor.get(m)!]), fmtUSD);
  donutPanel(halfRow, 'Tokens by type', 'share of all tokens recorded',
    TOKEN_TYPES.map(([n, c]) => [n, sum(rows, r => isTok(r) && r.labels['type'] === n), c]), fmtTok);

  if (models.length > 0) {
    chartPanel(app, 'Cost by model', 'USD per hour per model',
      hourly(inRange, tMin, tMax, models.map(m => (r: Row) => isCost(r) && model(r) === m)),
      models.map(m => ({ label: m, color: modelColor.get(m)!, fill: true })), fmtUSD, 180);
  }

  chartPanel(app, 'Token usage', 'tokens per hour by type',
    hourly(inRange, tMin, tMax, TOKEN_TYPES.map(([n]) => (r: Row) => isTok(r) && r.labels['type'] === n)),
    TOKEN_TYPES.map(([n, c]) => ({ label: n, color: c, fill: true })), fmtTok);

  chartPanel(app, 'Sessions', 'sessions started per hour',
    hourly(inRange, tMin, tMax, [isSession]),
    [{ label: 'sessions', color: BLUE, bars: true }], v => v == null ? '–' : String(Math.round(v)), 140);

  chartPanel(app, 'Active time', 'seconds of active Claude Code use per hour',
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

// ---- realtime panel: driven by the WebSocket, no polling ----
// The token total only changes when a telemetry batch arrives — which is
// exactly when the WS pushes a summary — so feedLive() is called from the
// summary handler. No /api/live, no per-second fetch. The line is the token
// rate (tokens since last batch ÷ elapsed) over a rolling ~200-point window.
const LIVE_POINTS = 200;
let plotsLive: uPlot | null = null;
let liveXs: number[] = [], liveYs: (number | null)[] = [];
let livePrev: { t: number; tokens: number } | null = null;
let liveRateEl: HTMLElement | null = null;

function initLive() {
  const liveRoot = document.getElementById('live')!;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="panel-title">Live <span class="desc">token rate · updates on each telemetry batch (pushed over WebSocket)</span>
    <span class="rate" id="live-rate"></span></div><div class="panel-body"></div>`;
  liveRoot.appendChild(panel);
  const body = panel.querySelector('.panel-body') as HTMLElement;
  liveRateEl = panel.querySelector('#live-rate') as HTMLElement;

  const u = new uPlot({
    width: contentWidth(body),
    height: 110,
    series: [
      {},
      { label: 'tokens/s', stroke: GREEN, width: 2, fill: GREEN + '2e', points: { show: liveXs.length <= 60, size: 5, fill: GREEN } },
    ],
    legend: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 6, width: 2 } },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, Math.max(max * 1.15, 10)] },
    },
    axes: axisDefaults(v => fmtTok(v)),
    plugins: [tooltipPlugin(v => v == null ? '–' : fmtTok(v) + '/s')],
  }, [liveXs, liveYs] as uPlot.AlignedData, body);
  plotsLive = u;
  autosize(u, body);
}

// Called with each summary (WS push or fallback fetch); derives the token rate
// from the change in cumulative tokens since the previous summary.
function feedLive(totalTokens: number, tSec: number) {
  if (!plotsLive) return;
  if (livePrev && tSec > livePrev.t) {
    const rate = Math.max(0, (totalTokens - livePrev.tokens) / (tSec - livePrev.t));
    liveXs.push(tSec);
    liveYs.push(rate);
    if (liveXs.length > LIVE_POINTS) { liveXs.shift(); liveYs.shift(); }
    plotsLive.setData([liveXs, liveYs] as uPlot.AlignedData);
    if (liveRateEl) {
      liveRateEl.textContent = rate > 0 ? `▲ ${fmtTok(rate)}/s` : 'idle';
      liveRateEl.style.color = rate > 0 ? GREEN : 'rgba(204,204,220,0.4)';
    }
  }
  livePrev = { t: tSec, tokens: totalTokens };
}

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
