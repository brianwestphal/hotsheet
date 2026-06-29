// @vitest-environment happy-dom
/** HS-9162 — editor focus/caret capture + restore across a permission popup. */
import { afterEach, describe, expect, it } from 'vitest';

import { captureEditorFocus, isEditableElement, restoreEditorFocus } from './editorFocusRestore.js';

afterEach(() => { document.body.innerHTML = ''; });

function textarea(value: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

describe('isEditableElement', () => {
  it('recognizes input, textarea, and contenteditable; rejects others + null', () => {
    const input = document.createElement('input');
    const ta = document.createElement('textarea');
    const ce = document.createElement('div'); ce.contentEditable = 'true';
    const div = document.createElement('div');
    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(ta)).toBe(true);
    expect(isEditableElement(ce)).toBe(true);
    expect(isEditableElement(div)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe('captureEditorFocus', () => {
  it('captures a textarea caret/selection', () => {
    const ta = textarea('hello world');
    ta.focus();
    ta.setSelectionRange(2, 5);
    const saved = captureEditorFocus(document.activeElement, window.getSelection());
    expect(saved).not.toBeNull();
    expect(saved?.el).toBe(ta);
    expect(saved?.start).toBe(2);
    expect(saved?.end).toBe(5);
    expect(saved?.range).toBeNull();
  });

  it('returns null when nothing editable is focused', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(captureEditorFocus(div, window.getSelection())).toBeNull();
    expect(captureEditorFocus(null, window.getSelection())).toBeNull();
  });
});

describe('restoreEditorFocus', () => {
  it('re-focuses the textarea and restores the caret/selection', () => {
    const ta = textarea('hello world');
    const saved = { el: ta, start: 3, end: 7, range: null };
    // Move focus elsewhere first (simulate the popup stealing it).
    const other = document.createElement('input'); document.body.appendChild(other); other.focus();
    expect(document.activeElement).toBe(other);

    restoreEditorFocus(saved, window.getSelection());

    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(3);
    expect(ta.selectionEnd).toBe(7);
  });

  it('is a no-op for a null snapshot', () => {
    const other = document.createElement('input'); document.body.appendChild(other); other.focus();
    expect(() => restoreEditorFocus(null, window.getSelection())).not.toThrow();
    expect(document.activeElement).toBe(other);
  });

  it('does nothing when the saved element has left the DOM', () => {
    const ta = textarea('gone');
    const saved = { el: ta, start: 1, end: 1, range: null };
    ta.remove(); // detached
    const other = document.createElement('input'); document.body.appendChild(other); other.focus();
    restoreEditorFocus(saved, window.getSelection());
    expect(document.activeElement).toBe(other); // focus not moved to the detached editor
  });

  it('round-trips capture → restore for a collapsed caret', () => {
    const ta = textarea('abcdef');
    ta.focus();
    ta.setSelectionRange(4, 4);
    const saved = captureEditorFocus(document.activeElement, window.getSelection());
    const other = document.createElement('input'); document.body.appendChild(other); other.focus();
    restoreEditorFocus(saved, window.getSelection());
    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(4);
    expect(ta.selectionEnd).toBe(4);
  });
});
