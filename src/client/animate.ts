// FLIP animation for ticket list re-ordering.
// Captures element positions before render, then animates
// elements from their old position to their new position.

type Snapshot = Map<string, DOMRect>;

let suppressNext = false;

/** Call before a render that should NOT animate (drag-drop, view switch, etc.) */
export function suppressAnimation() {
  suppressNext = true;
}

/** Capture current positions of all ticket elements. Call before render. */
export function captureSnapshot(): Snapshot {
  const snapshot: Snapshot = new Map();
  document.querySelectorAll('.ticket-row[data-id], .column-card[data-id]').forEach(el => {
    const id = (el as HTMLElement).dataset.id!;
    snapshot.set(id, el.getBoundingClientRect());
  });
  return snapshot;
}

/** Animate elements from their snapshot positions to current positions. Call after render. */
export function flipAnimate(before: Snapshot) {
  if (suppressNext) {
    suppressNext = false;
    return;
  }
  if (before.size === 0) return;

  document.querySelectorAll('.ticket-row[data-id], .column-card[data-id]').forEach(el => {
    const htmlEl = el as HTMLElement;
    const id = htmlEl.dataset.id!;
    const oldRect = before.get(id);
    if (!oldRect) return;

    const newRect = htmlEl.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

    htmlEl.style.transform = `translate(${dx}px, ${dy}px)`;
    // Force reflow so the browser registers the starting position
    void htmlEl.offsetHeight;
    htmlEl.style.transition = 'transform 200ms ease-out';
    htmlEl.style.transform = '';

    const cleanup = () => { htmlEl.style.transition = ''; };
    htmlEl.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 250);
  });
}
