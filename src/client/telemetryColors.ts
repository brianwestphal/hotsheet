/**
 * Shared color palettes for the telemetry surfaces (§67 / §68 / §69).
 *
 * Both the cross-project dashboard (`telemetryDashboard.tsx`) and the
 * shared cost-over-time chart (`telemetryCostOverTimeChart.tsx`) read
 * `MODEL_DONUT_COLORS` to color slices / bands by index. Extracted out
 * of `telemetryDashboard.tsx` under HS-8506 so the chart component
 * can reuse the same palette without back-importing the larger module
 * (which would risk circular imports once Phase 3 / 4 wire the chart
 * back into the dashboards).
 */

export const MODEL_DONUT_COLORS = [
  '#4f46e5', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
] as const;
