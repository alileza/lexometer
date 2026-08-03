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
let promptSort: 'cost' | 'recent' = 'cost';

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
  interface Req { cr: number; cc: number; inp: number; out: number; tools: string[] }
  interface Group {
    t: number; text: string; len: number; calls: number; durMs: number;
    cr: number; cc: number; inp: number; out: number; tools: Map<string, number>;
    reqs: Req[]; pendingTools: string[];
  }
  const groups: Group[] = [];
  const current = new Map<string, Group>();
  for (const e of evs) {
    if (e.name.includes('user_prompt')) {
      const g: Group = {
        t: e.t, text: promptText(e.attrs), len: num(e.attrs, 'prompt_length'),
        calls: 0, durMs: 0, cr: 0, cc: 0, inp: 0, out: 0, tools: new Map(),
        reqs: [], pendingTools: [],
      };
      groups.push(g);
      current.set(e.session, g);
    } else {
      const g = current.get(e.session);
      if (!g) continue;
      if (e.name.includes('api_request')) {
        g.calls++;
        const cr = num(e.attrs, 'cache_read_tokens'), cc = num(e.attrs, 'cache_creation_tokens');
        const inp = num(e.attrs, 'input_tokens'), out = num(e.attrs, 'output_tokens');
        g.cr += cr; g.cc += cc; g.inp += inp; g.out += out;
        g.durMs += num(e.attrs, 'duration_ms');
        // tools observed since the previous request produced this call's new context
        g.reqs.push({ cr, cc, inp, out, tools: g.pendingTools });
        g.pendingTools = [];
      } else if (e.name.includes('tool_result') || e.name.includes('tool_decision')) {
        const tn = e.attrs['tool_name'] ?? e.attrs['name'] ?? 'tool';
        g.tools.set(tn, (g.tools.get(tn) ?? 0) + 1);
        g.pendingTools.push(tn);
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

  const total = (g: Group) => g.cr + g.cc + g.inp + g.out;
  if (groups.length === 0) return;

  // per-prompt "why is this expensive" in plain language
  const reason = (g: Group): { text: string; color: string } => {
    const tot = total(g) || 1;
    const crShare = g.cr / tot, ccShare = g.cc / tot, outShare = g.out / tot;
    if (crShare > 0.85) return { text: 'mostly re-sent context — long session, lots of history carried each turn', color: BLUE };
    if (ccShare > 0.3) {
      const tools = [...g.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n).join(', ');
      return { text: `added a lot of new context${tools ? ' via ' + tools : ''} (files/tool output pulled in)`, color: GREEN };
    }
    if (outShare > 0.3) return { text: 'long generation — the model wrote a lot back', color: YELLOW };
    return { text: 're-sent context plus some new content', color: TEXT_DIM };
  };

  // the teaching signal: is spend concentrated in a few prompts? does it grow?
  const totals = groups.map(total);
  const grandTotal = totals.reduce((a, b) => a + b, 0) || 1;
  const maxTot = Math.max(...totals);
  const sortedDesc = [...groups].sort((a, b) => total(b) - total(a));
  const top = sortedDesc[0]!;
  const topShare = total(top) / grandTotal * 100;
  const nowSec = lastSummary?.now ?? Math.floor(Date.now() / 1000);
  const latestG = groups[groups.length - 1]!;
  const isLive = nowSec - Math.floor(latestG.t / 1000) < 120;

  const ordered = promptSort === 'cost' ? sortedDesc.slice(0, 30) : groups.slice(-30).reverse();
  const rankOf = new Map(sortedDesc.map((g, i) => [g, i + 1]));

  const panel = document.createElement('div');
  panel.className = 'panel';
  const legend = TOKEN_TYPES.map(([n, c]) =>
    `<span class="key" style="display:inline-flex;align-items:center;gap:5px;margin-right:12px"><span style="width:11px;height:4px;border-radius:1px;background:${c};display:inline-block"></span>${n}</span>`).join('');

  // headline lesson: name the single most expensive prompt and why
  const topLabel = top.text ? `“${esc(top.text.slice(0, 54))}${top.text.length > 54 ? '…' : ''}”` : `a ${top.len}-char prompt`;
  const headline = `<div style="background:rgba(242,73,92,0.08);border:1px solid rgba(242,73,92,0.25);border-radius:3px;padding:10px 12px;margin-bottom:10px;font-size:13px">
    <span style="color:${RED};font-weight:600">Most expensive prompt:</span> ${topLabel}
    — <span style="font-family:var(--mono)">${fmtTok(total(top))}</span> tokens (${topShare.toFixed(0)}% of all prompt spend).
    <span style="color:var(--text-dim)">${reason(top).text}.</span></div>`;

  const detailRow = (g: Group): string => {
    const rows = g.reqs.map((rq, i) => {
      const tot = rq.cr + rq.cc + rq.inp + rq.out;
      const tls = rq.tools.length ? rq.tools.join(', ') : '—';
      return `<tr style="background:rgba(204,204,220,0.02)">
        <td style="padding-left:24px;color:var(--text-faint)">call ${i + 1}</td>
        <td style="color:var(--text-dim)">after: ${esc(tls)}</td>
        <td class="num" title="total">${fmtTok(tot)}</td>
        <td class="num" style="color:${BLUE}">cR ${fmtTok(rq.cr)}</td>
        <td class="num" style="color:${GREEN}">cC ${fmtTok(rq.cc)}</td>
        <td class="num" style="color:${YELLOW}">out ${fmtTok(rq.out)}</td>
      </tr>`;
    }).join('');
    return `<tr class="detail" style="display:none"><td colspan="6" style="padding:0"><table style="width:100%">${rows}</table></td></tr>`;
  };

  const rowHTML = (g: Group): string => {
    const tot = total(g);
    const rank = rankOf.get(g)!;
    const expensive = tot > maxTot * 0.5 && rank <= 3;
    const rz = reason(g);
    const live = g === latestG && isLive;
    const barW = Math.max(2, tot / maxTot * 100);
    return `<tr class="prow" style="cursor:pointer;${expensive ? `box-shadow:inset 3px 0 0 ${RED}` : ''}">
      <td class="num" style="color:var(--text-faint)">#${rank}</td>
      <td style="white-space:nowrap">${live ? `<span style="color:${GREEN}">●</span> ` : ''}<span class="caret" style="color:var(--text-faint)">▸</span> ${hhmmss(g.t)}</td>
      <td>${g.text ? esc(g.text.slice(0, 52)) + (g.text.length > 52 ? '…' : '') : `<span style="color:rgba(204,204,220,0.4)">${g.len} chars</span>`}</td>
      <td style="min-width:150px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:14px;background:rgba(204,204,220,0.06);border-radius:2px;overflow:hidden;position:relative">
            <div style="position:absolute;inset:0;width:${barW}%;display:flex">${distBar(g).replace('<div class="dist"', '<div style="display:flex;width:100%"').replace(/max-width:180px|min-width:110px/g, '')}</div>
          </div>
          <span class="num" style="min-width:52px">${fmtTok(tot)}</span>
        </div>
        <div style="font-size:11px;color:${rz.color};margin-top:3px">${rz.text}</div>
      </td>
      <td>${toolsCell(g)}</td>
      <td class="num">${(g.durMs / 1000).toFixed(1)}s</td>
    </tr>${detailRow(g)}`;
  };

  panel.innerHTML = `<div class="panel-title">Prompt spend — which prompts cost the most
      <span class="desc">${isLive ? `<span style="color:${GREEN}">● live</span> · ` : ''}ranked; click a row for the per-call breakdown</span>
      <span style="margin-left:auto;display:flex;gap:0;border:1px solid var(--panel-border);border-radius:2px;overflow:hidden;font-size:11px">
        <button id="ps-cost" style="background:${promptSort === 'cost' ? '#3d71d9' : 'var(--panel)'};color:${promptSort === 'cost' ? '#fff' : 'var(--text-dim)'};border:none;padding:3px 9px;cursor:pointer;font-family:var(--font)">Most expensive</button>
        <button id="ps-recent" style="background:${promptSort === 'recent' ? '#3d71d9' : 'var(--panel)'};color:${promptSort === 'recent' ? '#fff' : 'var(--text-dim)'};border:none;padding:3px 9px;cursor:pointer;font-family:var(--font)">Recent</button>
      </span></div>
    <div class="panel-body">
      ${headline}
      <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:8px">${legend}</div>
      <table>
      <tr><th class="num">#</th><th>Time</th><th>Prompt</th><th>Tokens · why</th><th>Tools</th><th class="num">Duration</th></tr>
      ${ordered.map(rowHTML).join('')}
      </table></div>`;

  panel.querySelectorAll('tr.prow').forEach(row => {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling as HTMLElement | null;
      const caret = row.querySelector('.caret') as HTMLElement | null;
      if (detail && detail.classList.contains('detail')) {
        const open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : '';
        if (caret) caret.textContent = open ? '▸' : '▾';
      }
    });
  });
  panel.querySelector('#ps-cost')?.addEventListener('click', (e) => { e.stopPropagation(); promptSort = 'cost'; renderEvents(); });
  panel.querySelector('#ps-recent')?.addEventListener('click', (e) => { e.stopPropagation(); promptSort = 'recent'; renderEvents(); });
  root.appendChild(panel);
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

  const isTok = (r: Row) => r.metric === 'claude_code.token.usage';
  const isSession = (r: Row) => r.metric === 'claude_code.session.count';
  const isActive = (r: Row) => r.metric === 'claude_code.active_time.total';
  const today = day(s.now);
  const tokType = (t: string) => (r: Row) => isTok(r) && r.labels['type'] === t;

  feedLive(sum(rows, isTok), s.now); // realtime panel rides the same summary
  const model = (r: Row) => r.labels['model'] ?? 'unknown';
  const models = [...new Set(rows.filter(isTok).map(model))].sort();
  const modelColor = new Map(models.map((m, i) => [m, MODEL_PALETTE[i % MODEL_PALETTE.length]!]));

  const totalTok = sum(rows, isTok);
  const cacheRead = sum(rows, tokType('cacheRead'));
  const cachePct = totalTok > 0 ? (cacheRead / totalTok * 100) : 0;

  const tMax = Math.ceil(s.now / HOUR) * HOUR;
  const tMin = Math.min(...rows.map(r => r.t));
  const inRange = rows;

  app.innerHTML = `<div class="row stats">`
    + statPanel(fmtTok(totalTok), 'total tokens', 'blue')
    + statPanel(fmtTok(sum(rows, r => isTok(r) && day(r.t) === today)), 'tokens today')
    + statPanel(cachePct.toFixed(1) + '%', 'cache reads (re-sent context)', cachePct > 90 ? 'red' : '')
    + statPanel(String(Math.round(sum(rows, isSession))), 'sessions')
    + statPanel(fmtDur(sum(rows, r => isActive(r) && day(r.t) === today)), 'active time today')
    + `</div>`;
  renderSetup(); // setup panel lives in the Prompts tab (static #setup-root)

  chartPanel(app, 'Token usage', 'tokens per hour by type',
    hourly(inRange, tMin, tMax, TOKEN_TYPES.map(([n]) => tokType(n))),
    TOKEN_TYPES.map(([n, c]) => ({ label: n, color: c, fill: true })), fmtTok);

  // per-prompt views live in the Prompts tab (static #events-root), filled from
  // /api/events; re-render here so they refresh with each summary.
  renderEvents();
  void refreshEvents();

  // breakdown donuts: tokens by type and by model
  const halfRow = document.createElement('div');
  halfRow.className = 'row half';
  app.appendChild(halfRow);
  donutPanel(halfRow, 'Tokens by type', 'share of all tokens — cacheRead is re-sent context',
    TOKEN_TYPES.map(([n, c]) => [n, sum(rows, tokType(n)), c]), fmtTok);
  donutPanel(halfRow, 'Tokens by model', 'share of tokens across models',
    models.map(m => [m, sum(rows, r => isTok(r) && model(r) === m), modelColor.get(m)!]), fmtTok);

  if (models.length > 1) {
    chartPanel(app, 'Tokens by model', 'tokens per hour per model',
      hourly(inRange, tMin, tMax, models.map(m => (r: Row) => isTok(r) && model(r) === m)),
      models.map(m => ({ label: m, color: modelColor.get(m)!, fill: true })), fmtTok, 180);
  }

  chartPanel(app, 'Sessions', 'sessions started per hour',
    hourly(inRange, tMin, tMax, [isSession]),
    [{ label: 'sessions', color: BLUE, bars: true }], v => v == null ? '–' : String(Math.round(v)), 140);

  chartPanel(app, 'Active time', 'seconds of active Claude Code use per hour',
    hourly(inRange, tMin, tMax, [isActive]),
    [{ label: 'active', color: PURPLE, fill: true }], v => v == null ? '–' : fmtDur(v), 140);

  // before/after comparison when both phases have data — on tokens per active day
  const phases = [...new Set(rows.map(r => r.labels['skills_enabled']).filter(Boolean))];
  if (phases.length >= 2) {
    const avg = (phase: string) => {
      const m = byDay(rows, r => isTok(r) && r.labels['skills_enabled'] === phase);
      const vals = [...m.values()];
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const before = avg('false'), after = avg('true');
    const delta = before > 0 ? ((after - before) / before) * 100 : 0;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="panel-title">Before vs after <span class="desc">average tokens per active day, split on skills_enabled — your measured number, not a vendor claim</span></div>
      <div class="panel-body"><div class="row stats" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      ${statPanel(fmtTok(before), 'avg tokens/day · skills_enabled=false')}
      ${statPanel(fmtTok(after), 'avg tokens/day · skills_enabled=true')}
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

// ---- context attribution (from transcript files, not live telemetry) ----
interface AttrItem { key: string; tokens: number; count: number }
interface AttrData { files: AttrItem[]; tools: AttrItem[]; scanned: number; note: string }

async function loadAttribution() {
  const root = document.getElementById('attr')!;
  root.innerHTML = `<div class="panel"><div class="panel-title">Context attribution
    <span class="desc">scanning transcript files…</span></div></div>`;
  try {
    const a = await (await fetch('/api/attribution')).json() as AttrData;
    const maxF = Math.max(1, ...a.files.map(f => f.tokens));
    const maxT = Math.max(1, ...a.tools.map(t => t.tokens));
    const bar = (v: number, max: number, c: string) =>
      `<div style="height:5px;border-radius:2px;background:${c};width:${Math.max(2, v / max * 100)}%"></div>`;
    const fileRows = a.files.map(f => `<tr>
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.key)}">${esc(f.key)}</td>
      <td class="num">${fmtTok(f.tokens)}</td><td class="num">${f.count}×</td>
      <td style="width:130px">${bar(f.tokens, maxF, BLUE)}</td></tr>`).join('');
    const toolRows = a.tools.map(t => `<tr>
      <td>${esc(t.key)}</td><td class="num">${fmtTok(t.tokens)}</td><td class="num">${t.count}×</td>
      <td style="width:130px">${bar(t.tokens, maxT, GREEN)}</td></tr>`).join('');
    root.innerHTML = `<div class="row half">
      <div class="panel"><div class="panel-title">Top files by context <span class="desc">estimated tokens across ${a.scanned} transcripts — reads that fill the window</span></div>
        <div class="panel-body"><table><tr><th>File</th><th class="num">~Tokens</th><th class="num">Reads</th><th></th></tr>${fileRows}</table></div></div>
      <div class="panel"><div class="panel-title">By tool <span class="desc">estimated tokens produced per tool</span></div>
        <div class="panel-body"><table><tr><th>Tool</th><th class="num">~Tokens</th><th class="num">Calls</th><th></th></tr>${toolRows}</table></div></div>
      </div>
      <div style="font-size:11.5px;color:var(--text-faint);margin:-2px 2px 8px">${esc(a.note)} · <a href="#" id="attr-refresh" style="color:var(--blue)">refresh</a></div>`;
    document.getElementById('attr-refresh')?.addEventListener('click', (e) => { e.preventDefault(); loadAttribution(); });
  } catch {
    root.innerHTML = `<div class="panel"><div class="panel-title">Context attribution <span class="desc">could not read transcripts</span></div></div>`;
  }
}

// ---- session pruning (Sessions tab) ----
interface SessionInfo {
  path: string; project: string; id: string; sizeBytes: number;
  images: number; estTokenReads: number; turns: number;
  modifiedUnix: number; open: boolean; hasBackup: boolean;
}

const fmtBytes = (b: number) =>
  b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' :
  b >= 1e3 ? (b / 1e3).toFixed(0) + ' KB' : b + ' B';
const agoStr = (unix: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

let sessionsLoaded = false;

async function loadSessions() {
  const root = document.getElementById('sessions');
  if (!root) return;
  sessionsLoaded = true;
  root.innerHTML = `<div class="panel"><div class="panel-title">Prune session context
    <span class="desc">scanning transcripts…</span></div></div>`;
  let list: SessionInfo[];
  try {
    list = await (await fetch('/api/sessions')).json() as SessionInfo[];
  } catch {
    root.innerHTML = `<div class="panel"><div class="panel-title">Prune session context
      <span class="desc">could not read transcripts</span></div></div>`;
    return;
  }

  const badge = document.querySelector('#tabs button[data-pane="sessions"]');
  if (badge) badge.innerHTML = 'Sessions' + (list.length ? ` <span class="badge">${list.length}</span>` : '');

  // Plain-language explainer so the button's effect is never a mystery.
  const explain = `<div class="explain">
    <strong>What “Prune images” does:</strong> it rewrites this session’s saved transcript file on disk,
    replacing every pasted screenshot with a tiny <code>[image pruned]</code> placeholder. Images are the
    biggest thing a long session re-sends on every single turn.
    <ul>
      <li>⏱ <strong>Applies on resume, not now.</strong> It changes nothing about a running session — it takes effect the next time you open this one with <code>claude --resume</code>.</li>
      <li>💾 <strong>Reversible.</strong> Your original transcript is copied to a <code>.bak</code> first; <em>restore original</em> puts it straight back.</li>
      <li>🔒 <strong>Won’t touch an open session.</strong> Anything used in the last 2 minutes is locked.</li>
    </ul>
    It shrinks what every future turn re-sends. It does <em>not</em> refund tokens you’ve already spent.</div>`;

  if (list.length === 0) {
    root.innerHTML = `<div class="panel"><div class="panel-title">Prune session context
      <span class="desc">reclaim re-sent image tokens from saved sessions</span></div>
      <div class="panel-body">${explain}
      <div style="color:var(--text-dim);font-size:13px">✓ No pasted images are stuck in any transcript right now — nothing to prune.</div></div></div>`;
    return;
  }

  // The default action cell for a row (Prune, plus Restore if a backup exists).
  const actions = (i: number): string => {
    const s = list[i]!;
    if (s.open) return `<span style="color:var(--text-faint);font-size:11.5px">in use — close it in Claude Code to prune</span>`;
    const restore = s.hasBackup ? ` <button class="act restore" data-restore="${i}">restore original</button>` : '';
    return `<button class="act prune" data-prune="${i}">Prune images</button>${restore}`;
  };

  const rows = list.map((s, i) => `<tr data-row="${i}">
      <td><span title="${esc(s.path)}">${esc(s.project)}</span>
        <div style="color:var(--text-faint);font-size:11px;font-family:var(--mono)">${esc(s.id.slice(0, 8))}</div></td>
      <td class="num" data-size="${i}">${fmtBytes(s.sizeBytes)}</td>
      <td class="num">${s.images}</td>
      <td class="num" title="each image’s tokens × the turns it is re-sent after it appears">~${fmtTok(s.estTokenReads)}</td>
      <td class="num" style="color:${s.open ? 'var(--red)' : 'var(--text-dim)'}">${s.open ? 'open now' : agoStr(s.modifiedUnix)}</td>
      <td style="white-space:nowrap"><span class="cell-actions" data-cell="${i}">${actions(i)}</span></td>
    </tr>`).join('');

  root.innerHTML = `<div class="panel"><div class="panel-title">Prune session context
      <span class="desc">reclaim re-sent image tokens from saved sessions</span></div>
    <div class="panel-body">${explain}
      <table>
        <tr><th>Session</th><th class="num">Size</th><th class="num">Images</th>
          <th class="num">Saved / resume</th><th class="num">Last used</th><th>Action</th></tr>
        ${rows}
      </table>
      <div style="font-size:11.5px;color:var(--text-faint);margin-top:8px">
        “Saved / resume” = image tokens × the turns they’re re-sent — what you stop re-paying each time you resume that session.
        <a href="#" id="sess-refresh" style="color:var(--blue)">refresh</a></div></div></div>`;

  const setCell = (i: number, html: string) => {
    const cell = root.querySelector(`[data-cell="${i}"]`) as HTMLElement | null;
    if (cell) cell.innerHTML = html;
  };

  // One delegated handler — survives the innerHTML swaps we do inside cells.
  root.addEventListener('click', async (ev) => {
    const el = ev.target as HTMLElement;
    const prune = el.closest('[data-prune]') as HTMLElement | null;
    const doIt = el.closest('[data-confirm]') as HTMLElement | null;
    const cancel = el.closest('[data-cancel]') as HTMLElement | null;
    const restore = el.closest('[data-restore]') as HTMLElement | null;

    // step 1: clicking Prune reveals exactly what will happen, and asks to confirm
    if (prune) {
      const i = +prune.dataset.prune!;
      setCell(i, `<span class="q">Rewrite this transcript now? Keeps a <code style="font-family:var(--mono)">.bak</code>, takes effect on your next <code style="font-family:var(--mono)">--resume</code>.</span>
        <button class="act prune confirm" data-confirm="${i}">Yes, prune</button>
        <button class="act" data-cancel="${i}">Cancel</button>`);
      return;
    }
    if (cancel) { const i = +cancel.dataset.cancel!; setCell(i, actions(i)); return; }

    // step 2: confirmed — do the rewrite and report the concrete before → after
    if (doIt) {
      const i = +doIt.dataset.confirm!;
      setCell(i, `<span class="q">Pruning…</span>`);
      try {
        const r = await fetch('/api/prune', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: list[i]!.path }),
        });
        const res = await r.json();
        if (!r.ok) {
          setCell(i, `<span class="sess-note err">${esc(res.error ?? 'failed')}</span> <button class="act prune" data-prune="${i}">try again</button>`);
          return;
        }
        list[i]!.hasBackup = true; list[i]!.sizeBytes = res.bytesAfter;
        const sizeEl = root.querySelector(`[data-size="${i}"]`);
        if (sizeEl) sizeEl.textContent = fmtBytes(res.bytesAfter);
        setCell(i, `<span class="sess-note ok">✓ ${res.images} image${res.images === 1 ? '' : 's'} removed · ${fmtBytes(res.bytesBefore)} → ${fmtBytes(res.bytesAfter)} · <code style="font-family:var(--mono);color:inherit">.bak</code> saved · applies on next resume</span>
          <button class="act restore" data-restore="${i}">restore original</button>`);
      } catch {
        setCell(i, `<span class="sess-note err">request failed</span> <button class="act prune" data-prune="${i}">try again</button>`);
      }
      return;
    }

    if (restore) {
      const i = +restore.dataset.restore!;
      setCell(i, `<span class="q">Restoring…</span>`);
      try {
        const r = await fetch('/api/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: list[i]!.path }),
        });
        const res = await r.json();
        if (!r.ok) {
          setCell(i, `<span class="sess-note err">${esc(res.error ?? 'failed')}</span>`);
          return;
        }
        setCell(i, `<span class="sess-note ok">✓ original restored</span>`);
        loadSessions(); // pull accurate sizes back
      } catch {
        setCell(i, `<span class="sess-note err">request failed</span>`);
      }
      return;
    }
  });

  document.getElementById('sess-refresh')?.addEventListener('click', (e) => { e.preventDefault(); loadSessions(); });
}

// ---- tab switching ----
function initTabs() {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  tabs.querySelectorAll<HTMLButtonElement>('button[data-pane]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.pane!;
      tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll<HTMLElement>('section.pane').forEach(p => {
        p.hidden = p.dataset.pane !== target;
      });
      if (target === 'sessions' && !sessionsLoaded) loadSessions();
    });
  });
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

initTabs();
tick();
connect();
initLive();
loadAttribution();
setInterval(() => { if (!wsOpen) tick(); }, 10_000);
setInterval(() => { if (wsOpen) tick(); }, 30_000); // refresh relative timestamps
