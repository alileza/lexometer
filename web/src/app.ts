// lexometer dashboard — fetches /api/summary and renders SVG charts.

interface Row { t: number; metric: string; labels: Record<string, string>; value: number }
interface Summary { rows: Row[]; metrics: string[]; lastReceived: number; now: number }

const BLUE = '#0057ff', RED = '#ff4034', INK = '#0a0d12', MUTE = '#6b7280', FAINT = '#9ca4ad',
      GRID = '#eceef1', AXIS = '#d3d7dd';
// token types, fixed order + fixed shades of the blue ramp (identity is labeled, not color-alone)
const TOKEN_TYPES: [string, string][] = [
  ['cacheRead', BLUE], ['cacheCreation', '#6b96ff'], ['output', '#a4bfff'], ['input', '#d4e0ff'],
];
const NS = 'http://www.w3.org/2000/svg';

const app = document.getElementById('app')!;
const tip = document.getElementById('tip')!;
const statusEl = document.getElementById('status')!;
const statusText = document.getElementById('status-text')!;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}
function txt(parent: Element, x: number, y: number, s: string, attrs: Record<string, string | number> = {}) {
  const e = el('text', { x, y, 'font-size': 11, fill: MUTE, ...attrs }, parent);
  e.textContent = s;
  return e;
}
function hover(target: Element, html: string) {
  target.addEventListener('mousemove', (ev) => {
    const m = ev as MouseEvent;
    tip.innerHTML = html;
    tip.style.opacity = '1';
    tip.style.left = Math.min(m.clientX + 14, window.innerWidth - tip.offsetWidth - 12) + 'px';
    tip.style.top = (m.clientY + 16) + 'px';
  });
  target.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
}
const fmtUSD = (v: number) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
const fmtTok = (v: number) =>
  v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' :
  v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

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

function stat(value: string, label: string): string {
  return `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function dailyBars(svg: SVGSVGElement, days: string[], series: { name: string; color: string; data: Map<string, number> }[], fmt: (v: number) => string) {
  const W = 1000, H = 240, m = { t: 14, r: 10, b: 30, l: 52 };
  svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H));
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = days.map(d => series.reduce((a, s) => a + (s.data.get(d) ?? 0), 0));
  const maxY = Math.max(...totals, 1e-9) * 1.15;
  const step = iw / Math.max(days.length, 1);
  const bw = Math.max(4, Math.min(38, step - 4));
  const y = (v: number) => m.t + ih - (v / maxY) * ih;

  for (let i = 0; i <= 3; i++) {
    const v = (maxY / 3) * i;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i === 0 ? AXIS : GRID }, svg);
    txt(svg, m.l - 8, y(v) + 4, fmt(v), { 'text-anchor': 'end', fill: FAINT });
  }
  days.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = m.t + ih;
    const parts = series.map(s => `${s.name}: ${fmt(s.data.get(d) ?? 0)}`).join('<br>');
    for (const s of series) {
      const v = s.data.get(d) ?? 0;
      if (v <= 0) continue;
      const h = (v / maxY) * ih;
      el('rect', { x, y: base - h, width: bw, height: Math.max(h - 1.5, 0.5), rx: 3, fill: s.color }, svg);
      base -= h;
    }
    if (days.length <= 21 || i % Math.ceil(days.length / 14) === 0)
      txt(svg, x + bw / 2, H - 10, d.slice(5), { 'text-anchor': 'middle', fill: FAINT });
    const hit = el('rect', { x: x - 2, y: m.t, width: bw + 4, height: ih, fill: 'transparent' }, svg);
    hover(hit, `<div class="t">${d}</div><div class="v">${series.length > 1 ? parts : fmt(totals[i])}</div>`);
  });
}

function render(s: Summary) {
  const rows = s.rows ?? [];
  const live = s.lastReceived > 0 && s.now - s.lastReceived < 120;
  statusEl.className = live ? 'live' : '';
  statusText.textContent = s.lastReceived === 0 ? 'waiting for telemetry…'
    : `last data ${Math.max(0, s.now - s.lastReceived)}s ago`;

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

  const totalCost = sum(rows, isCost);
  const costToday = sum(rows, r => isCost(r) && day(r.t) === today);
  const totalTok = sum(rows, isTok);
  const sessions = sum(rows, isSession);

  const days = [...new Set(rows.filter(r => isCost(r) || isTok(r)).map(r => day(r.t)))].sort();

  let html = '<div class="stats">'
    + stat(fmtUSD(totalCost), 'total cost recorded')
    + stat(fmtUSD(costToday), 'cost today')
    + stat(fmtTok(totalTok), 'total tokens')
    + stat(String(Math.round(sessions)), 'sessions')
    + '</div>';

  html += `<div class="card"><h3>Cost per day</h3><div class="sub">USD, from claude_code.cost.usage</div>
    <div class="chart-scroll"><svg id="c-cost"></svg></div></div>`;

  html += `<div class="card"><h3>Tokens per day, by type</h3>
    <div class="legend">${TOKEN_TYPES.map(([n, c]) =>
      `<span class="key"><span class="swatch" style="background:${c}"></span>${n}</span>`).join('')}</div>
    <div class="chart-scroll"><svg id="c-tok"></svg></div></div>`;

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
    html += `<div class="card"><h3>Before vs after — skills_enabled</h3>
      <div class="sub">average cost per active day in each phase; the honest number, not a vendor claim</div>
      <div class="stats" style="grid-template-columns:repeat(3,1fr)">
      ${stat(fmtUSD(before), 'avg $/day · skills_enabled=false')}
      ${stat(fmtUSD(after), 'avg $/day · skills_enabled=true')}
      ${stat((delta <= 0 ? '' : '+') + delta.toFixed(1) + '%', 'change (negative = saving)')}
      </div></div>`;
  }

  // everything received, so nothing is silently hidden
  html += `<div class="card"><h3>All metrics received</h3><div class="sub">totals across the whole recording window</div>
    <table><tr><th>Metric</th><th class="num">Total</th></tr>
    ${s.metrics.map(m => `<tr><td>${m}</td><td class="num">${fmtTok(sum(rows, r => r.metric === m))}</td></tr>`).join('')}
    </table></div>`;

  app.innerHTML = html;

  dailyBars(document.getElementById('c-cost') as unknown as SVGSVGElement, days,
    [{ name: 'cost', color: BLUE, data: byDay(rows, isCost) }], fmtUSD);
  dailyBars(document.getElementById('c-tok') as unknown as SVGSVGElement, days,
    TOKEN_TYPES.map(([n, c]) => ({ name: n, color: c, data: byDay(rows, r => isTok(r) && r.labels['type'] === n) })), fmtTok);
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
setInterval(() => { if (!wsOpen) tick(); }, 10_000);
setInterval(() => { if (wsOpen) tick(); }, 30_000); // refresh relative timestamps
