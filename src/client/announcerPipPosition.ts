/**
 * §78 Announcer — pure geometry helpers for the transcript PIP's position
 * (HS-8756). DOM-free so they're unit-testable; `announcerPip.tsx` supplies the
 * real element/viewport rects and applies the result.
 */
export interface Point { left: number; top: number }
export interface Size { width: number; height: number }
export interface Rect { left: number; top: number; right: number; bottom: number }

/** Keep the panel fully on screen, with a small margin. */
export function clampPosition(pos: Point, panel: Size, viewport: Size, margin = 10): Point {
  const maxLeft = Math.max(margin, viewport.width - panel.width - margin);
  const maxTop = Math.max(margin, viewport.height - panel.height - margin);
  return {
    left: Math.min(Math.max(margin, pos.left), maxLeft),
    top: Math.min(Math.max(margin, pos.top), maxTop),
  };
}

/**
 * Initial position when the PIP first opens and the user hasn't dragged it yet:
 * anchored just below the Listen button, right edges roughly aligned, then
 * clamped on screen. This makes the panel visibly "belong" to the button it
 * launched from (HS-8756) rather than appearing in a detached corner.
 */
export function anchoredPosition(anchor: Rect, panel: Size, viewport: Size, margin = 10): Point {
  return clampPosition(
    { left: anchor.right - panel.width, top: anchor.bottom + 10 },
    panel,
    viewport,
    margin,
  );
}
