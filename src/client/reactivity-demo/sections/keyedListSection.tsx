/**
 * Section 4 — Keyed list with identity preservation.
 *
 * Each row has a `data-key` attribute. morphdom matches rows across re-renders
 * by key, so an unrelated reorder/insert moves existing DOM nodes instead of
 * destroying and recreating them. The proof: every row contains an `<input>`.
 * Type into a row's input, then reorder the list — your typed value stays
 * with the same logical row because morphdom moved the existing `<input>`.
 *
 * If the diff were positional, reordering would shuffle the values to the
 * wrong rows.
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

interface Row { id: string; label: string }

let rowSeq = 0;
function makeRow(label: string): Row {
  rowSeq += 1;
  return { id: `row-${rowSeq}`, label };
}

export function mountKeyedList(root: HTMLElement): void {
  const rows = signal<Row[]>([
    makeRow('Alpha'),
    makeRow('Beta'),
    makeRow('Gamma'),
  ]);
  const renderTicks = signal(0);

  morphBind(root, () => {
    void renderTicks.value; // read so the counter forces re-renders we can observe
    return (
      <div className="demo-card">
        <h2>4. Keyed list <span className="demo-tag">data-key • identity preserved across reorders</span></h2>

        <div className="demo-row">
          <button type="button" data-action="add" className="demo-btn">+ add row</button>
          <button type="button" data-action="shuffle" className="demo-btn">shuffle</button>
          <button type="button" data-action="reverse" className="demo-btn">reverse</button>
          <button type="button" data-action="rerender" className="demo-btn demo-btn-ghost">force re-render</button>
        </div>

        <ul className="demo-keyed-list">
          {rows.value.map((row) => (
            <li className="demo-keyed-row" data-key={row.id}>
              <span className="demo-keyed-label">{row.label}</span>
              <input
                type="text"
                placeholder="type something..."
                className="demo-input demo-input-inline"
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" data-action="remove" data-id={row.id} className="demo-btn demo-btn-ghost demo-btn-tiny">×</button>
            </li>
          ))}
        </ul>

        <p className="demo-note">
          Type into the inputs. Then shuffle / reverse / add — your typed values
          travel with their row because the <code>data-key</code> tells morphdom
          to move the existing DOM node rather than rebuild a new one. "Force
          re-render" calls the same <code>morphBind</code> render function with
          no state change; the inputs aren't even cloned.
        </p>
      </div>
    );
  });

  delegate(root, 'click', '[data-action="add"]', () => {
    rows.value = [...rows.value, makeRow(`Row ${rows.value.length + 1}`)];
  });
  delegate(root, 'click', '[data-action="remove"]', (_e, btn) => {
    const id = (btn as HTMLElement).dataset.id;
    if (id !== undefined) rows.value = rows.value.filter((r) => r.id !== id);
  });
  delegate(root, 'click', '[data-action="shuffle"]', () => {
    rows.value = [...rows.value].sort(() => Math.random() - 0.5);
  });
  delegate(root, 'click', '[data-action="reverse"]', () => {
    rows.value = [...rows.value].reverse();
  });
  delegate(root, 'click', '[data-action="rerender"]', () => {
    renderTicks.value += 1;
  });
}
