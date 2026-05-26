/**
 * HS-8553 — extracted from `src/client/app.tsx` so the 16-binding
 * sibling-function block inside that file shrinks to its initial
 * orchestration. `bindDetailPositionToggle` wires the side / bottom /
 * close-detail tri-state toggle buttons in the header; second click on
 * the active position closes the detail panel entirely. Also exports
 * `updateDetailPositionToggle` so other bindings + `reloadAppState`
 * can re-sync the active class after a project switch.
 */
import { updateSettings } from '../../api/index.js';
import { applyDetailPosition, applyDetailSize } from '../detail.js';
import { byId, byIdOrNull } from '../dom.js';
import type { AppSettings } from '../state.js';
import { state } from '../state.js';

export function updateDetailPositionToggle(): void {
  const toggle = byId('detail-position-toggle');
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.position === state.settings.detail_position);
  });
}

export function bindDetailPositionToggle(): void {
  const toggle = byId('detail-position-toggle');
  toggle.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const position = (btn as HTMLElement).dataset.position as AppSettings['detail_position'];
      // If clicking the already-active position, toggle the detail panel off
      if (position === state.settings.detail_position && state.settings.detail_visible) {
        state.settings.detail_visible = false;
        const panel = byIdOrNull('detail-panel');
        const handle = byIdOrNull('detail-resize-handle');
        if (panel) panel.style.display = 'none';
        if (handle) handle.style.display = 'none';
        toggle.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
        void updateSettings({ detail_visible: 'false' });
        return;
      }
      // Switching position or re-enabling
      state.settings.detail_visible = true;
      state.settings.detail_position = position;
      const panel = byIdOrNull('detail-panel');
      const handle = byIdOrNull('detail-resize-handle');
      if (panel) panel.style.display = '';
      if (handle) handle.style.display = '';
      applyDetailPosition(position);
      applyDetailSize();
      updateDetailPositionToggle();
      void updateSettings({ detail_position: position, detail_visible: 'true' });
    });
  });
  updateDetailPositionToggle();
}
