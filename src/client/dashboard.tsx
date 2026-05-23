import type { SafeHtml } from '../jsx-runtime.js';
import { renderAnalyticsTelemetrySection } from './analyticsTelemetrySection.js';
import { api } from './api.js';
import { byIdOrNull, toElement } from './dom.js';
import { getCategoryColor, state } from './state.js';

interface DashboardData {
  throughput: { date: string; completed: number; created: number }[];
  cycleTime: { ticket_number: string; title: string; completed_at: string; hours: number }[];
  categoryBreakdown: { category: string; count: number }[];
  categoryPeriod: { category: string; count: number }[];
  snapshots: { date: string; data: { not_started: number; started: number; completed: number; verified: number } }[];
  kpi: {
    completedThisWeek: number;
    completedLastWeek: number;
    wipCount: number;
    createdThisWeek: number;
    medianCycleTimeDays: number | null;
  };
}

let currentDays = 30;

export async function renderDashboard(container: HTMLElement) {
  container.replaceChildren(toElement(<div className="dashboard-loading">Loading dashboard...</div>));
  try {
    const data = await api<DashboardData>(`/dashboard?days=${currentDays}`);
    container.replaceChildren(buildDashboard(data));
  } catch {
    container.replaceChildren(toElement(<div className="dashboard-loading">Failed to load dashboard data.</div>));
  }
}

function buildDashboard(data: DashboardData): HTMLElement {
  const el = toElement(<div className="dashboard"></div>);

  // Time range toggle
  const rangeBar = toElement(
    <div className="dashboard-range-bar">
      <button className={`btn btn-sm${currentDays === 7 ? ' active' : ''}`} data-days="7">7 days</button>
      <button className={`btn btn-sm${currentDays === 30 ? ' active' : ''}`} data-days="30">30 days</button>
      <button className={`btn btn-sm${currentDays === 90 ? ' active' : ''}`} data-days="90">90 days</button>
    </div>
  );
  rangeBar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDays = parseInt((btn as HTMLElement).dataset.days!, 10);
      const container = byIdOrNull('dashboard-container');
      if (container) void renderDashboard(container);
    });
  });
  el.appendChild(rangeBar);

  // HS-8565 — disclaimer slot sits above BOTH the ticket-stats KPI row
  // and the Claude-usage chips so the "estimate only for Pro / Max
  // subscribers" caveat is understood to apply to every cost the page
  // displays. The slot starts empty; `analyticsTelemetrySection.tsx`
  // populates it from the same fetch that drives the chips below the
  // KPI row. Stays empty when the project has no Claude usage yet.
  el.appendChild(toElement(<div id="dashboard-claude-disclaimer-slot" className="dashboard-claude-disclaimer-slot"></div>));

  // KPI cards
  const kpi = data.kpi;
  const throughputChange = kpi.completedLastWeek > 0
    ? Math.round(((kpi.completedThisWeek - kpi.completedLastWeek) / kpi.completedLastWeek) * 100)
    : 0;
  const throughputArrow = throughputChange > 0 ? '\u2191' : throughputChange < 0 ? '\u2193' : '';
  const backlogRatio = kpi.createdThisWeek > 0 ? (kpi.completedThisWeek / kpi.createdThisWeek).toFixed(1) : '\u2014';

  el.appendChild(toElement(
    <div className="dashboard-kpi-row">
      <div className="dashboard-kpi-card">
        <div className="kpi-value">{String(kpi.completedThisWeek)}</div>
        <div className="kpi-label">Completed this week</div>
        {throughputArrow ? <div className={`kpi-trend${throughputChange > 0 ? ' up' : ' down'}`}>{throughputArrow} {Math.abs(throughputChange)}%</div> : null}
      </div>
      <div className="dashboard-kpi-card">
        <div className="kpi-value">{kpi.medianCycleTimeDays !== null ? `${kpi.medianCycleTimeDays}d` : '\u2014'}</div>
        <div className="kpi-label">Median cycle time</div>
      </div>
      <div className="dashboard-kpi-card">
        <div className="kpi-value">{String(kpi.wipCount)}</div>
        <div className="kpi-label">In progress</div>
      </div>
      <div className="dashboard-kpi-card">
        <div className="kpi-value">{backlogRatio}</div>
        <div className="kpi-label">Completed / created</div>
      </div>
    </div>
  ));

  // HS-8565 — Claude usage chips slot sits directly below the ticket-
  // stats KPI row so the two overview rows read as a single block. The
  // chips are populated asynchronously by `analyticsTelemetrySection`'s
  // fetch flow; this slot stays empty until that fetch returns + only
  // gets populated when the project has telemetry data.
  el.appendChild(toElement(<div id="dashboard-claude-chips-slot" className="dashboard-claude-chips-slot"></div>));

  // Charts in a grid
  const grid = toElement(<div className="dashboard-grid"></div>);

  const throughputCard = chartCard('Throughput', 'Items completed per day. Shows your sustainable delivery pace.', renderBarChart(data.throughput));
  addChartHover(throughputCard, data.throughput.map(d => ({ date: d.date, lines: [{ label: 'Completed', color: '#3b82f6', value: d.completed }] })));
  grid.appendChild(throughputCard);

  const dualLineCard = chartCard('Created vs Completed',
    'Compares items created (orange) vs completed (green) over time. When created outpaces completed, the backlog grows.',
    renderDualLineChart(data.throughput));
  addChartHover(dualLineCard, data.throughput.map(d => ({ date: d.date, lines: [{ label: 'Completed', color: '#22c55e', value: d.completed }, { label: 'Created', color: '#f97316', value: d.created }] })));
  grid.appendChild(dualLineCard);

  const cfdCard = chartCard('Cumulative Flow',
    'Stacked area showing ticket counts by status over time. Widening bands indicate bottlenecks. A healthy flow has consistent band widths.',
    renderCFD(data.snapshots));
  addChartHover(cfdCard, data.snapshots.map(s => ({ date: s.date, lines: [
    { label: 'Not Started', color: '#6b7280', value: s.data.not_started },
    { label: 'Started', color: '#3b82f6', value: s.data.started },
    { label: 'Completed', color: '#22c55e', value: s.data.completed },
    { label: 'Verified', color: '#8b5cf6', value: s.data.verified },
  ] })));
  grid.appendChild(cfdCard);

  grid.appendChild(chartCard('Category Breakdown',
    'Distribution of tickets by category. Left: currently open. Right: all tickets active in the selected time period.',
    renderDonutCharts(data.categoryBreakdown, data.categoryPeriod)));
  grid.appendChild(chartCard('Cycle Time',
    'Each dot is a completed ticket plotted by completion date and time to complete (log scale). Dashed lines show 50th and 85th percentile delivery times.',
    renderScatterChart(data.cycleTime)));

  el.appendChild(grid);

  // HS-8508 / §71 — per-project telemetry sections appended below the
  // existing ticket-charts grid. The section is self-managing: it
  // kicks off its own `/api/telemetry/project-rollup` fetch on mount.
  // HS-8512 — telemetry window now reads from the dashboard's
  // top-level 7/30/90 day range bar (passed via `currentDays`); the
  // section no longer renders its own redundant window selector.
  el.appendChild(renderAnalyticsTelemetrySection(currentDays));

  return el;
}

function chartCard(title: string, info: string, content: SafeHtml): HTMLElement {
  const card = toElement(
    <div className="dashboard-chart-card">
      <div className="dashboard-chart-header">
        <span className="dashboard-chart-title">{title}</span>
        <button className="dashboard-info-btn" title="About this chart">{INFO_ICON}</button>
      </div>
      <div className="dashboard-chart-info" style="display:none">{info}</div>
      <div className="dashboard-chart-body">{content}</div>
    </div>
  );
  const infoBtn = card.querySelector('.dashboard-info-btn')!;
  const infoEl = card.querySelector('.dashboard-chart-info') as HTMLElement;
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    infoEl.style.display = infoEl.style.display === 'none' ? '' : 'none';
  });
  return card;
}

// --- Hover cursor for time-series charts ---

function addChartHover(card: HTMLElement, data: { date: string; lines: { label: string; color: string; value: number }[] }[]) {
  const bodyEl = card.querySelector('.dashboard-chart-body');
  if (bodyEl === null || data.length === 0) return;
  const body = bodyEl as HTMLElement;

  const cursor = toElement(<div className="chart-cursor" style="display:none"></div>);
  body.style.position = 'relative';
  body.appendChild(cursor);

  const tooltip = toElement(<div className="chart-tooltip" style="display:none"></div>);
  body.appendChild(tooltip);

  const svg = body.querySelector('svg');
  if (!svg) return;

  svg.addEventListener('mousemove', (e) => {
    const svgRect = svg.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const svgOffsetLeft = svgRect.left - bodyRect.left;
    const svgOffsetTop = svgRect.top - bodyRect.top;
    const scaleX = CHART_W / svgRect.width;
    const scaleY = CHART_H / svgRect.height;
    const mouseX = (e.clientX - svgRect.left) * scaleX;
    const w = CHART_W - PAD.left - PAD.right;

    const ratio = Math.max(0, Math.min(1, (mouseX - PAD.left) / w));
    const idx = Math.round(ratio * (data.length - 1));
    if (idx < 0 || idx >= data.length) return;

    // Position cursor in body-relative coordinates
    const dataX = PAD.left + (idx / Math.max(data.length - 1, 1)) * w;
    const cursorLeft = svgOffsetLeft + dataX / scaleX;
    const cursorTop = svgOffsetTop + PAD.top / scaleY;
    const cursorHeight = (CHART_H - PAD.top - PAD.bottom) / scaleY;

    cursor.style.display = '';
    cursor.style.left = `${cursorLeft}px`;
    cursor.style.top = `${cursorTop}px`;
    cursor.style.height = `${cursorHeight}px`;

    const d = data[idx];
    tooltip.style.display = '';
    const tooltipContent = toElement(
      <div>
        <div className="chart-tooltip-date">{fmtDate(d.date)}</div>
        {d.lines.map(l =>
          <div className="chart-tooltip-row"><span className="chart-legend-dot" style={`background:${l.color}`}></span>{l.label}: <b>{String(l.value)}</b></div>
        )}
      </div>
    );
    tooltip.innerHTML = '';
    // Append children from the wrapper div
    while (tooltipContent.firstChild) tooltip.appendChild(tooltipContent.firstChild);

    // Position tooltip relative to body
    const tooltipLeft = cursorLeft + 10;
    if (tooltipLeft + 120 > bodyRect.width) {
      tooltip.style.left = `${cursorLeft - 120}px`;
    } else {
      tooltip.style.left = `${tooltipLeft}px`;
    }
    tooltip.style.top = `${e.clientY - bodyRect.top - 10}px`;
  });

  svg.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
    tooltip.style.display = 'none';
  });
}

// --- SVG Chart Renderers ---

const CHART_W = 400;
const CHART_H = 180;
const PAD = { top: 10, right: 10, bottom: 25, left: 35 };

const INFO_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>;

function renderBarChart(data: { date: string; completed: number }[]): SafeHtml {
  if (data.length === 0) return <div className="chart-empty">No data</div>;
  const values = data.map(d => d.completed);
  const max = Math.max(...values, 1);
  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;
  const barW = Math.max(2, (w / data.length) - 2);

  const bars = data.map((d, i) => {
    const x = PAD.left + (i / data.length) * w;
    const barH = (values[i] / max) * h;
    const y = PAD.top + h - barH;
    return (
      <rect x={String(x)} y={String(y)} width={String(barW)} height={String(barH)} fill="#3b82f6" rx="1" opacity="0.8" className="chart-hover">
        <title>{`${fmtDate(d.date)}: ${String(values[i])} completed`}</title>
      </rect>
    );
  });

  return (
    <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="dashboard-svg">
      {yAxisLines(max, h)}
      {bars}
      {axisLabels(data.map(d => d.date))}
    </svg>
  );
}

function renderDualLineChart(data: { date: string; completed: number; created: number }[]): SafeHtml {
  if (data.length < 2) return <div className="chart-empty">Not enough data</div>;
  const max = Math.max(...data.map(d => Math.max(d.completed, d.created)), 1);
  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;

  return (
    <>
      <div className="chart-legend">
        <span className="chart-legend-item"><span className="chart-legend-dot" style="background:#22c55e"></span>Completed</span>
        <span className="chart-legend-item"><span className="chart-legend-dot" style="background:#f97316"></span>Created</span>
      </div>
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="dashboard-svg">
        {yAxisLines(max, h)}
        <path d={linePath(data.map(d => d.created), max, w, h)} fill="none" stroke="#f97316" stroke-width="2" opacity="0.7"/>
        <path d={linePath(data.map(d => d.completed), max, w, h)} fill="none" stroke="#22c55e" stroke-width="2"/>
        {axisLabels(data.map(d => d.date))}
      </svg>
    </>
  );
}

function renderCFD(snapshots: { date: string; data: { not_started: number; started: number; completed: number; verified: number } }[]): SafeHtml {
  if (snapshots.length < 2) return <div className="chart-empty">Not enough data</div>;
  const statuses = ['verified', 'completed', 'started', 'not_started'] as const;
  const colors = { not_started: '#6b7280', started: '#3b82f6', completed: '#22c55e', verified: '#8b5cf6' };
  const labels = { not_started: 'Not Started', started: 'Started', completed: 'Completed', verified: 'Verified' };

  const stacked: number[][] = snapshots.map(s => {
    let cumulative = 0;
    return statuses.map(st => {
      cumulative += s.data[st] || 0;
      return cumulative;
    });
  });

  const max = Math.max(...stacked.map(s => s[s.length - 1]), 1);
  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;
  const n = snapshots.length;

  const areas: SafeHtml[] = [];
  for (let si = statuses.length - 1; si >= 0; si--) {
    const topPoints = stacked.map((s, i) => {
      const x = PAD.left + (i / (n - 1)) * w;
      const y = PAD.top + h - (s[si] / max) * h;
      return `${String(x)},${String(y)}`;
    });
    const bottomPoints = si > 0
      ? stacked.map((s, i) => {
          const x = PAD.left + (i / (n - 1)) * w;
          const y = PAD.top + h - (s[si - 1] / max) * h;
          return `${String(x)},${String(y)}`;
        }).reverse()
      : [`${String(PAD.left + w)},${String(PAD.top + h)}`, `${String(PAD.left)},${String(PAD.top + h)}`];
    areas.push(
      <polygon points={`${topPoints.join(' ')} ${bottomPoints.join(' ')}`} fill={colors[statuses[si]]} opacity="0.6"/>
    );
  }

  return (
    <>
      <div className="chart-legend">
        {statuses.map(s =>
          <span className="chart-legend-item"><span className="chart-legend-dot" style={`background:${colors[s]}`}></span>{labels[s]}</span>
        )}
      </div>
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="dashboard-svg">
        {areas}
        {axisLabels(snapshots.map(s => s.date))}
      </svg>
    </>
  );
}

function renderDonutCharts(openData: { category: string; count: number }[], periodData: { category: string; count: number }[]): SafeHtml {
  // Merge all categories for legend
  const allCats = new Map<string, { color: string; label: string }>();
  for (const d of [...openData, ...periodData]) {
    if (!allCats.has(d.category)) {
      const cat = state.categories.find(c => c.id === d.category);
      allCats.set(d.category, { color: getCategoryColor(d.category), label: cat?.label ?? d.category });
    }
  }

  return (
    <>
      <div className="chart-legend">
        {Array.from(allCats.values()).map(c =>
          <span className="chart-legend-item"><span className="chart-legend-dot" style={`background:${c.color}`}></span>{c.label}</span>
        )}
      </div>
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="dashboard-svg">
        {singleDonut(openData, 'Open', 90)}
        {singleDonut(periodData, `${String(currentDays)}d active`, 290)}
      </svg>
    </>
  );
}

function singleDonut(data: { category: string; count: number }[], label: string, cx: number): SafeHtml {
  if (data.length === 0) return <text x={String(cx)} y="95" text-anchor="middle" fill="#9ca3af" font-size="11">No data</text>;
  const total = data.reduce((s, d) => s + d.count, 0);
  const cy = 95, r = 60, inner = 38;
  let angle = -Math.PI / 2;

  const paths: SafeHtml[] = [];
  for (const d of data) {
    const slice = (d.count / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle + slice);
    const y2 = cy + r * Math.sin(angle + slice);
    const ix1 = cx + inner * Math.cos(angle + slice);
    const iy1 = cy + inner * Math.sin(angle + slice);
    const ix2 = cx + inner * Math.cos(angle);
    const iy2 = cy + inner * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    const color = getCategoryColor(d.category);
    const cat = state.categories.find(c => c.id === d.category);
    const catLabel = cat?.label ?? d.category;

    paths.push(
      <path d={`M ${String(x1)} ${String(y1)} A ${String(r)} ${String(r)} 0 ${String(large)} 1 ${String(x2)} ${String(y2)} L ${String(ix1)} ${String(iy1)} A ${String(inner)} ${String(inner)} 0 ${String(large)} 0 ${String(ix2)} ${String(iy2)} Z`} fill={color} opacity="0.8" className="chart-hover">
        <title>{`${catLabel}: ${String(d.count)}`}</title>
      </path>
    );
    angle += slice;
  }

  return (
    <>
      {paths}
      <text x={String(cx)} y={String(cy + 4)} text-anchor="middle" fill="currentColor" font-size="16" font-weight="600">{String(total)}</text>
      <text x={String(cx)} y={String(cy + 17)} text-anchor="middle" fill="#6b7280" font-size="9">{label}</text>
    </>
  );
}

/** Format hours as a human-readable duration: "15m", "2.5h", "1.2d", "2w" */
function fmtDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days * 10) / 10}d`;
  return `${Math.round(days / 7 * 10) / 10}w`;
}

/** Map an hours value to a Y position using log scale. */
function logY(hours: number, minLog: number, logRange: number, h: number): number {
  const clamped = Math.max(hours, 1 / 60); // floor at 1 minute
  return PAD.top + h - ((Math.log10(clamped) - minLog) / logRange) * h;
}

function renderScatterChart(data: { ticket_number: string; title: string; completed_at: string; hours: number }[]): SafeHtml {
  if (data.length === 0) return <div className="chart-empty">No completed tickets</div>;
  const w = CHART_W - PAD.left - PAD.right;
  const h = CHART_H - PAD.top - PAD.bottom;

  // Log scale: compute range from data
  const allHours = data.map(d => Math.max(d.hours, 1 / 60));
  const minLog = Math.floor(Math.log10(Math.min(...allHours)));
  const maxLog = Math.ceil(Math.log10(Math.max(...allHours, 1)));
  const logRange = Math.max(maxLog - minLog, 1);

  const dates = data.map(d => new Date(d.completed_at).getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const dateRange = maxDate - minDate || 1;

  const dots = data.map(d => {
    const x = PAD.left + ((new Date(d.completed_at).getTime() - minDate) / dateRange) * w;
    const y = logY(d.hours, minLog, logRange, h);
    return (
      <circle cx={String(x)} cy={String(y)} r="4" fill="#3b82f6" opacity="0.5" className="chart-hover">
        <title>{`${d.ticket_number}: ${d.title}\n${fmtDuration(d.hours)}`}</title>
      </circle>
    );
  });

  // Percentile lines
  const sorted = data.map(d => d.hours).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p85 = sorted[Math.floor(sorted.length * 0.85)];
  const p50y = logY(p50, minLog, logRange, h);
  const p85y = logY(p85, minLog, logRange, h);

  const percentiles = (
    <>
      <line x1={String(PAD.left)} y1={String(p50y)} x2={String(PAD.left + w)} y2={String(p50y)} stroke="#22c55e" stroke-dasharray="4,4" opacity="0.6"/>
      <text x={String(PAD.left + w + 2)} y={String(p50y + 3)} fill="#22c55e" font-size="9">{`50% (${fmtDuration(p50)})`}</text>
      <line x1={String(PAD.left)} y1={String(p85y)} x2={String(PAD.left + w)} y2={String(p85y)} stroke="#f97316" stroke-dasharray="4,4" opacity="0.6"/>
      <text x={String(PAD.left + w + 2)} y={String(p85y + 3)} fill="#f97316" font-size="9">{`85% (${fmtDuration(p85)})`}</text>
    </>
  );

  // Log-scale Y axis: place ticks at powers of 10 and key durations
  const yLines: SafeHtml[] = [];
  // Candidate tick values in hours: 1min, 5min, 15min, 1h, 4h, 12h, 1d, 3d, 1w, 2w, 1mo
  const candidates = [1/60, 5/60, 0.25, 1, 4, 12, 24, 72, 168, 336, 720];
  for (const val of candidates) {
    if (val < Math.pow(10, minLog) * 0.5 || val > Math.pow(10, maxLog) * 2) continue;
    const y = logY(val, minLog, logRange, h);
    if (y < PAD.top - 5 || y > PAD.top + h + 5) continue;
    yLines.push(<line x1={String(PAD.left)} y1={String(y)} x2={String(CHART_W - PAD.right)} y2={String(y)} stroke="#e5e7eb" stroke-width="0.5"/>);
    yLines.push(<text x={String(PAD.left - 4)} y={String(y + 3)} text-anchor="end" fill="#9ca3af" font-size="9">{fmtDuration(val)}</text>);
  }

  return (
    <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="dashboard-svg">
      {yLines}
      {dots}
      {percentiles}
      {axisLabels(data.map(d => d.completed_at.slice(0, 10)))}
    </svg>
  );
}

// --- Helpers ---

function fmtDate(d: string): string {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function linePath(values: number[], max: number, w: number, h: number): string {
  return values.map((v, i) => {
    const x = PAD.left + (i / (values.length - 1)) * w;
    const y = PAD.top + h - (v / max) * h;
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
}

function yAxisLines(max: number, h: number, suffix = ''): SafeHtml[] {
  const ticks = 4;
  const out: SafeHtml[] = [];
  for (let i = 0; i <= ticks; i++) {
    const val = Math.round((max / ticks) * i);
    const y = PAD.top + h - (i / ticks) * h;
    out.push(<line x1={String(PAD.left)} y1={String(y)} x2={String(CHART_W - PAD.right)} y2={String(y)} stroke="#e5e7eb" stroke-width="0.5"/>);
    out.push(<text x={String(PAD.left - 4)} y={String(y + 3)} text-anchor="end" fill="#9ca3af" font-size="9">{`${String(val)}${suffix}`}</text>);
  }
  return out;
}

function axisLabels(dates: string[]): SafeHtml[] {
  if (dates.length === 0) return [];
  const h = CHART_H;
  const w = CHART_W - PAD.left - PAD.right;
  const out: SafeHtml[] = [];
  const positions = dates.length <= 7
    ? dates.map((_, i) => i)
    : [0, Math.floor(dates.length / 2), dates.length - 1];

  for (const i of positions) {
    const x = PAD.left + (i / Math.max(dates.length - 1, 1)) * w;
    out.push(<text x={String(x)} y={String(h - 4)} text-anchor="middle" fill="#9ca3af" font-size="9">{fmtDate(dates[i])}</text>);
  }
  return out;
}

// --- Sidebar Widget ---

export async function renderSidebarWidget(): Promise<HTMLElement> {
  const widget = toElement(<div className="sidebar-dashboard-widget" id="sidebar-dashboard-widget"></div>);
  try {
    const data = await api<DashboardData>('/dashboard?days=7');
    const kpi = data.kpi;
    const change = kpi.completedLastWeek > 0
      ? Math.round(((kpi.completedThisWeek - kpi.completedLastWeek) / kpi.completedLastWeek) * 100)
      : 0;
    const arrow = change > 0 ? '\u2191' : change < 0 ? '\u2193' : '';

    const last7 = data.throughput.slice(-7);
    const max = Math.max(...last7.map(d => d.completed), 1);
    const barRects = last7.map((d, i) => {
      const barH = (d.completed / max) * 20;
      return <rect x={String(i * 14)} y={String(20 - barH)} width="10" height={String(barH)} fill="#3b82f6" rx="1" opacity="0.7"/>;
    });

    const content = toElement(
      <div>
        <div className="sidebar-widget-spark"><svg viewBox="0 0 98 20" width="98" height="20">{barRects}</svg></div>
        <div className="sidebar-widget-stats">
          <span className="sidebar-widget-value">{kpi.completedThisWeek} completed</span>
          {arrow ? <span className={`sidebar-widget-trend ${change > 0 ? 'up' : 'down'}`}>{arrow}{Math.abs(change)}%</span> : null}
        </div>
        {/* HS-8527 — `.sidebar-widget-cost` shows the active project's
            today-cost (replaces the per-tab cost chip that lived in the
            project tab strip). Populated by `costPoll.tsx` via
            `updateSidebarWidgetCost` in `dashboardMode.tsx`. */}
        <div className="sidebar-widget-wip">
          <span>{kpi.wipCount} in progress</span>
          <span className="sidebar-widget-cost" title="Claude usage today (resets at local midnight)"></span>
        </div>
      </div>
    );
    widget.innerHTML = '';
    while (content.firstChild) widget.appendChild(content.firstChild);
  } catch {
    const fallback = toElement(<div className="sidebar-widget-stats">Dashboard</div>);
    widget.innerHTML = '';
    widget.appendChild(fallback);
  }
  return widget;
}
