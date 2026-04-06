/**
 * Shared module-level state and callback registry for ticketList sub-modules.
 *
 * This breaks circular dependencies: sub-modules (columnView, draftRow, ticketRow)
 * need to call renderTicketList/loadTickets/etc from ticketList.tsx, but ticketList.tsx
 * imports those sub-modules. By registering callbacks here, sub-modules can invoke
 * them without importing ticketList.tsx directly.
 */

import { PRIORITY_ITEMS, state } from './state.js';

// --- Module-level mutable state ---

export let saveTimeout: ReturnType<typeof setTimeout> | null = null;
export function setSaveTimeout(t: ReturnType<typeof setTimeout> | null) { saveTimeout = t; }

export let suppressFocusSelect = false;
export function setSuppressFocusSelect(v: boolean) { suppressFocusSelect = v; }

export let draftCategory: string | null = null;
export function setDraftCategory(v: string | null) { draftCategory = v; }

export let draftTitle = '';
export function setDraftTitle(v: string) { draftTitle = v; }

export let draggedTicketIds: number[] = [];
export function setDraggedTicketIds(v: number[]) { draggedTicketIds = v; }

// --- Shared constants ---

export const PRIORITY_SHORTCUTS = PRIORITY_ITEMS;

export function getCategoryShortcuts(): { key: string; value: string; label: string }[] {
  return state.categories.map(c => ({ key: c.shortcutKey, value: c.id, label: c.label }));
}

// --- Callback registry ---
// ticketList.tsx registers these at module init time; sub-modules call them.

type VoidFn = () => void;
type AsyncVoidFn = () => Promise<void>;

const callbacks = {
  renderTicketList: null as VoidFn | null,
  loadTickets: null as AsyncVoidFn | null,
  updateSelectionClasses: null as VoidFn | null,
  updateBatchToolbar: null as VoidFn | null,
  updateColumnSelectionClasses: null as VoidFn | null,
  focusDraftInput: null as VoidFn | null,
};

export function registerCallbacks(cbs: {
  renderTicketList: VoidFn;
  loadTickets: AsyncVoidFn;
  updateSelectionClasses: VoidFn;
  updateBatchToolbar: VoidFn;
  updateColumnSelectionClasses: VoidFn;
  focusDraftInput: VoidFn;
}) {
  callbacks.renderTicketList = cbs.renderTicketList;
  callbacks.loadTickets = cbs.loadTickets;
  callbacks.updateSelectionClasses = cbs.updateSelectionClasses;
  callbacks.updateBatchToolbar = cbs.updateBatchToolbar;
  callbacks.updateColumnSelectionClasses = cbs.updateColumnSelectionClasses;
  callbacks.focusDraftInput = cbs.focusDraftInput;
}

export function callRenderTicketList() { callbacks.renderTicketList!(); }
export function callLoadTickets() { return callbacks.loadTickets!(); }
export function callUpdateSelectionClasses() { callbacks.updateSelectionClasses!(); }
export function callUpdateBatchToolbar() { callbacks.updateBatchToolbar!(); }
export function callUpdateColumnSelectionClasses() { callbacks.updateColumnSelectionClasses!(); }
export function callFocusDraftInput() { callbacks.focusDraftInput!(); }
