/**
 * HS-8508 — Shared per-tool latency histogram renderer (originally
 * extracted from the HS-8150 drawer Telemetry tab's
 * `renderHistogramRow`; the drawer was retired in HS-8509 and this
 * module is now the canonical home). Consumed by the
 * analytics-dashboard telemetry section (HS-8508 / §71).
 *
 * Pure: takes one `ToolLatencyHistogramRow` and returns a self-
 * contained `HTMLElement`. Inline `<svg>` bars sized proportionally
 * to the max bucket count + p50 / p90 / p99 markers in the header.
 * `currentColor` so SCSS theme drives the accent.
 */

import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

export interface ToolLatencyHistogramRow {
  readonly tool: string;
  readonly count: number;
  readonly totalMs: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly buckets: readonly number[];
}

export const HISTOGRAM_BUCKET_LABELS = ['<10ms', '10-50ms', '50-100ms', '100-500ms', '500ms-1s', '1-5s', '5-10s', '10s+'];

function defaultFormatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export interface RenderToolHistogramRowOpts {
  readonly formatDuration?: (ms: number | null) => string;
}

export function renderToolHistogramRow(
  row: ToolLatencyHistogramRow,
  opts: RenderToolHistogramRowOpts = {},
): HTMLElement {
  const formatDuration = opts.formatDuration ?? defaultFormatDuration;

  const maxCount = Math.max(1, ...row.buckets);
  const barWidth = 30;
  const barGap = 4;
  const chartHeight = 40;
  const labelHeight = 12;
  const width = row.buckets.length * (barWidth + barGap);
  const height = chartHeight + labelHeight;

  const bars = row.buckets.map((c, i) => {
    const barHeight = c === 0 ? 0 : Math.max(2, (c / maxCount) * chartHeight);
    const x = i * (barWidth + barGap);
    const y = chartHeight - barHeight;
    return `<rect x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="${String(barHeight)}" fill="currentColor" opacity="${c === 0 ? '0.15' : '0.7'}"><title>${HISTOGRAM_BUCKET_LABELS[i]}: ${String(c)}</title></rect>`;
  }).join('');

  return toElement(
    <div className="telemetry-histogram-row">
      <div className="telemetry-histogram-header">
        <span className="telemetry-histogram-tool">{row.tool}</span>
        <span className="telemetry-histogram-meta">
          {String(row.count)} calls · {formatDuration(row.totalMs)} total
          {row.p50 !== null ? <> · p50 <strong>{formatDuration(row.p50)}</strong></> : null}
          {row.p90 !== null ? <> · p90 <strong>{formatDuration(row.p90)}</strong></> : null}
          {row.p99 !== null ? <> · p99 <strong>{formatDuration(row.p99)}</strong></> : null}
        </span>
      </div>
      <svg className="telemetry-histogram-svg" width={String(width)} height={String(height)} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={`${row.tool} latency histogram`}>
        {raw(bars)}
      </svg>
    </div>
  );
}
