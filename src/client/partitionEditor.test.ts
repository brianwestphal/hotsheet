// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PartitionInput } from './partitionEdit.js';
import { closePartitionEditor, openPartitionEditor } from './partitionEditor.js';

const INPUT: PartitionInput[] = [
  { worker: 'w1', label: 'Worker 1', ticketIds: [1, 2], ticketNumbers: ['HS-1', 'HS-2'] },
  { worker: 'w2', label: 'Worker 2', ticketIds: [3], ticketNumbers: ['HS-3'] },
];

afterEach(() => { closePartitionEditor(); document.body.innerHTML = ''; });

function cols() {
  return [...document.querySelectorAll('.partition-worker-col')];
}
function selectFor(ticketNum: string): HTMLSelectElement {
  const rows = [...document.querySelectorAll('.partition-ticket-row')];
  const row = rows.find(r => r.querySelector('.partition-ticket-num')?.textContent === ticketNum)!;
  return row.querySelector<HTMLSelectElement>('.partition-move-select')!;
}

describe('openPartitionEditor', () => {
  it('renders a column per worker with its tickets', () => {
    openPartitionEditor(INPUT, () => {});
    expect(cols()).toHaveLength(2);
    expect(document.querySelectorAll('.partition-ticket-row')).toHaveLength(3);
    // w1 column has HS-1 + HS-2.
    expect(cols()[0].textContent).toContain('HS-1');
    expect(cols()[0].textContent).toContain('HS-2');
    expect(cols()[1].textContent).toContain('HS-3');
  });

  it('reassigning a ticket via its select moves it to the other column', () => {
    openPartitionEditor(INPUT, () => {});
    const sel = selectFor('HS-2');
    sel.value = 'w2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // After the re-render, HS-2 lives under w2 (its column now has HS-2 + HS-3).
    expect(cols()[0].textContent).not.toContain('HS-2');
    expect(cols()[1].textContent).toContain('HS-2');
    expect(cols()[1].textContent).toContain('HS-3');
  });

  it('Apply calls onApply with the edited non-empty chunks and closes', () => {
    const onApply = vi.fn();
    openPartitionEditor(INPUT, onApply);
    // Move every ticket to w1 → w2 becomes empty.
    const sel = selectFor('HS-3');
    sel.value = 'w1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));

    document.querySelector<HTMLButtonElement>('.partition-editor-apply')!.click();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual([
      { worker: 'w1', label: 'Worker 1', ticketIds: [1, 2, 3] },
    ]);
    // Overlay is gone.
    expect(document.querySelector('.worker-pool-overlay')).toBeNull();
  });

  it('dragging a row onto another column reassigns it (HS-8988)', () => {
    openPartitionEditor(INPUT, () => {});
    const rows = [...document.querySelectorAll('.partition-ticket-row')];
    const row = rows.find(r => r.querySelector('.partition-ticket-num')?.textContent === 'HS-2')!;
    const w2col = document.querySelectorAll('.partition-worker-col')[1];
    // Simulate drag HS-2 (w1) → the w2 column.
    row.dispatchEvent(new Event('dragstart', { bubbles: true }));
    w2col.dispatchEvent(new Event('dragover', { bubbles: true }));
    w2col.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(cols()[0].textContent).not.toContain('HS-2');
    expect(cols()[1].textContent).toContain('HS-2');
  });

  it('Cancel closes without calling onApply', () => {
    const onApply = vi.fn();
    openPartitionEditor(INPUT, onApply);
    document.querySelector<HTMLButtonElement>('.partition-editor-cancel')!.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector('.worker-pool-overlay')).toBeNull();
  });
});
