/**
 * HS-8648 — regression coverage for the per-ticket "Claude usage" stats block.
 *
 * The reported bug was twofold: the block rendered as an unstyled run of
 * label-then-value text mashed together ("Cost$10.98", "Tokens14.9K"), and it
 * sat at the very bottom of the detail panel. The styling fix lives in
 * `styles.scss` (CSS, not unit-testable here), but the DOM STRUCTURE the CSS
 * hangs off of is — these tests pin that each stat keeps its label and value in
 * SEPARATE elements with the expected classes, so a future refactor can't
 * collapse them back into one inline run. The placement (above Notes) is guarded
 * by the server-render test in `src/routes/pages.test.tsx`.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
  getPerTicketRollup: vi.fn(),
}));

// eslint-disable-next-line import/first
import { getPerTicketRollup, type TicketRollup } from '../api/index.js';
// eslint-disable-next-line import/first
import {
  _testing,
  clearTicketTelemetryStats,
  loadAndRenderTicketTelemetry,
} from './ticketTelemetryStats.js';

const mockRollup = (over: Partial<TicketRollup> = {}): TicketRollup => ({
  ticketNumber: 'HS-1',
  promptCount: 1,
  totalCost: 10.98,
  totalTokens: 14_900,
  totalDurationSeconds: 612,
  ...over,
});

const container = (): HTMLElement => {
  const el = document.getElementById('detail-telemetry-stats');
  if (el === null) throw new Error('test setup: container missing');
  return el;
};

beforeEach(() => {
  document.body.innerHTML = '<div id="detail-telemetry-stats"></div>';
  vi.clearAllMocks();
  // HS-9249 — the rollup cache is module-level; reset it so tests don't leak a
  // cached value into each other (e.g. a prior success hiding the reject case).
  _testing.resetCache();
});

describe('loadAndRenderTicketTelemetry (HS-8152 / HS-8648)', () => {
  it('renders the heading + exactly four stat cells', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup());
    await loadAndRenderTicketTelemetry('HS-1');

    expect(container().querySelector('.ticket-telemetry-label')?.textContent)
      .toBe('Claude Usage on This Ticket');
    expect(container().querySelectorAll('.ticket-telemetry-stat')).toHaveLength(4);
  });

  it('keeps each stat label and value in SEPARATE elements (the HS-8648 mash-up bug)', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup());
    await loadAndRenderTicketTelemetry('HS-1');

    for (const stat of container().querySelectorAll('.ticket-telemetry-stat')) {
      const label = stat.querySelector('.ticket-telemetry-stat-label');
      const value = stat.querySelector('.ticket-telemetry-stat-value');
      expect(label).not.toBeNull();
      expect(value).not.toBeNull();
      // Distinct nodes — not one concatenated text run like "Cost$10.98".
      expect(label).not.toBe(value);
      expect(label?.textContent).not.toBe('');
      expect(value?.textContent).not.toBe('');
    }
  });

  it('renders the expected labels + formatted values in order', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup());
    await loadAndRenderTicketTelemetry('HS-1');

    const labels = [...container().querySelectorAll('.ticket-telemetry-stat-label')]
      .map(e => e.textContent);
    const values = [...container().querySelectorAll('.ticket-telemetry-stat-value')]
      .map(e => e.textContent);
    expect(labels).toEqual(['Cost', 'Tokens', 'Prompts', 'Time spent']);
    expect(values).toEqual(['$10.98', '14.9K', '1', '10.2 min']);
  });

  it('renders nothing when the ticket has zero attributed prompts', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup({ promptCount: 0 }));
    await loadAndRenderTicketTelemetry('HS-1');
    expect(container().children).toHaveLength(0);
  });

  it('leaves the container empty when the rollup fetch rejects', async () => {
    vi.mocked(getPerTicketRollup).mockRejectedValue(new Error('network'));
    await loadAndRenderTicketTelemetry('HS-1');
    expect(container().children).toHaveLength(0);
  });

  it('is idempotent — a second render replaces rather than appends', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup());
    await loadAndRenderTicketTelemetry('HS-1');
    await loadAndRenderTicketTelemetry('HS-1');
    expect(container().querySelectorAll('.ticket-telemetry-block')).toHaveLength(1);
  });

  it('clearTicketTelemetryStats empties a populated container', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValue(mockRollup());
    await loadAndRenderTicketTelemetry('HS-1');
    expect(container().children.length).toBeGreaterThan(0);
    clearTicketTelemetryStats();
    expect(container().children).toHaveLength(0);
  });
});

describe('HS-9249 — cached re-render (no empty flash on reload)', () => {
  /** Resolve-controllable fetch: returns the promise + its resolver so a test can
   *  inspect the DOM while the fetch is still in flight. */
  function deferredRollup(): { resolve: (r: TicketRollup) => void } {
    // `resolve` is only bound when the mock is CALLED, so return a live box the
    // executor mutates (returning `{ resolve }` would snapshot the initial value).
    const box: { resolve: (r: TicketRollup) => void } = { resolve: () => { /* set on call */ } };
    vi.mocked(getPerTicketRollup).mockImplementationOnce(
      () => new Promise<TicketRollup>(res => { box.resolve = res; }),
    );
    return box;
  }

  it('keeps the last value on screen during a same-ticket reload instead of blanking', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValueOnce(mockRollup({ totalCost: 10.98 }));
    await loadAndRenderTicketTelemetry('HS-1'); // populates + caches
    expect(container().querySelectorAll('.ticket-telemetry-block')).toHaveLength(1);

    // Second load (e.g. an auto-save-triggered background reload) with an
    // in-flight fetch — the block must stay populated, NOT flash empty.
    const pending = deferredRollup();
    const reload = loadAndRenderTicketTelemetry('HS-1');
    expect(container().querySelectorAll('.ticket-telemetry-block')).toHaveLength(1);
    expect(container().querySelector('.ticket-telemetry-stat-value')?.textContent).toBe('$10.98');

    // When the fresh value lands it swaps in.
    pending.resolve(mockRollup({ totalCost: 20 }));
    await reload;
    expect(container().querySelector('.ticket-telemetry-stat-value')?.textContent).toBe('$20.00');
  });

  it('clears the previous ticket block when switching to a not-yet-cached ticket', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValueOnce(mockRollup({ ticketNumber: 'HS-1' }));
    await loadAndRenderTicketTelemetry('HS-1');
    expect(container().querySelectorAll('.ticket-telemetry-block')).toHaveLength(1);

    // Switch to HS-2 (never loaded) with an in-flight fetch — HS-1's stats must
    // not linger under HS-2.
    const pending = deferredRollup();
    const load = loadAndRenderTicketTelemetry('HS-2');
    expect(container().children).toHaveLength(0);

    pending.resolve(mockRollup({ ticketNumber: 'HS-2', promptCount: 2 }));
    await load;
    expect(container().querySelectorAll('.ticket-telemetry-block')).toHaveLength(1);
  });

  it('does not let a stale in-flight fetch clobber the ticket now on screen', async () => {
    // Cache HS-2 so switching to it later re-paints instantly.
    vi.mocked(getPerTicketRollup).mockResolvedValueOnce(mockRollup({ ticketNumber: 'HS-2', totalCost: 5 }));
    await loadAndRenderTicketTelemetry('HS-2');

    // Start a slow HS-1 load...
    const stale = deferredRollup();
    const hs1 = loadAndRenderTicketTelemetry('HS-1');

    // ...then switch back to HS-2 (cached → paints $5 synchronously).
    vi.mocked(getPerTicketRollup).mockResolvedValueOnce(mockRollup({ ticketNumber: 'HS-2', totalCost: 5 }));
    await loadAndRenderTicketTelemetry('HS-2');
    expect(container().querySelector('.ticket-telemetry-stat-value')?.textContent).toBe('$5.00');

    // The stale HS-1 fetch resolving must NOT repaint over HS-2.
    stale.resolve(mockRollup({ ticketNumber: 'HS-1', totalCost: 99 }));
    await hs1;
    expect(container().querySelector('.ticket-telemetry-stat-value')?.textContent).toBe('$5.00');
  });

  it('keeps the cached value visible when a reload fetch rejects', async () => {
    vi.mocked(getPerTicketRollup).mockResolvedValueOnce(mockRollup({ totalCost: 10.98 }));
    await loadAndRenderTicketTelemetry('HS-1');

    vi.mocked(getPerTicketRollup).mockRejectedValueOnce(new Error('network'));
    await loadAndRenderTicketTelemetry('HS-1');
    // The transient failure must not blank a good cached value.
    expect(container().querySelector('.ticket-telemetry-stat-value')?.textContent).toBe('$10.98');
  });
});

describe('telemetry value formatters (_testing)', () => {
  it('formatTokens — raw / K / M tiers', () => {
    expect(_testing.formatTokens(950)).toBe('950');
    expect(_testing.formatTokens(14_900)).toBe('14.9K');
    expect(_testing.formatTokens(2_500_000)).toBe('2.50M');
  });

  it('formatDuration — seconds / minutes / hours tiers', () => {
    expect(_testing.formatDuration(42.3)).toBe('42.3 s');
    expect(_testing.formatDuration(612)).toBe('10.2 min');
    expect(_testing.formatDuration(7200)).toBe('2.00 h');
  });

  it('formatCost — two-decimal dollars', () => {
    expect(_testing.formatCost(10.98)).toBe('$10.98');
  });
});
