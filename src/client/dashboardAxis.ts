/**
 * HS-9724 — nice integer y-axis ticks for the dashboard's count charts.
 *
 * The old `yAxisLines` drew a FIXED 4 intervals and rounded each label with
 * `Math.round((max/4) * i)`, so a small `max` produced duplicate labels
 * (max=1 → 0,0,1,1,1; max=3 → 0,1,2,2,3) AND gridlines that didn't sit on
 * integer values. This picks a nice integer step off a 1/2/5×10ⁿ ladder so the
 * ticks are DISTINCT integers spanning [0, niceMax], where niceMax ≥ max — and
 * the caller scales its bars/lines to `niceMax` so bars line up with gridlines.
 */
export function integerAxis(max: number, maxTicks = 5): { niceMax: number; ticks: number[] } {
  const top = Math.max(1, Math.ceil(max));
  // Candidate integer steps: 1,2,5,10,20,50,100,… up to `top`.
  const steps: number[] = [];
  for (let p = 1; p <= top; p *= 10) steps.push(p, 2 * p, 5 * p);
  steps.push(top); // guarantee at least one step covers the range
  // Smallest step whose interval count doesn't exceed `maxTicks`.
  const step = Math.max(1, Math.round(steps.find(s => Math.ceil(top / s) <= maxTicks) ?? top));
  const niceMax = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax; v += step) ticks.push(v);
  return { niceMax, ticks };
}
