/**
 * Section 3 — Focus / cursor preservation across re-renders.
 *
 * The headline morphdom win: an `<input>` the user is typing into survives an
 * unrelated re-render. We use a 1 Hz tick signal that's read by the same
 * `morphBind` block that contains the input, so the entire region re-renders
 * every second. Without morphdom, the input would be destroyed and recreated
 * on each tick — the user would lose focus + cursor position mid-keystroke.
 * With morphdom, `onBeforeElUpdated` sees the focused element is the active
 * one, preserves its value + selection, and the user never notices.
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

export function mountFocusSurvival(root: HTMLElement): void {
  const name = signal('');
  const tick = signal(0);
  const showLetters = signal(true);

  // Force a re-render every second so the demo's "focus survives re-renders"
  // claim is observable. In real code, ticks would come from store actions or
  // server pushes; here we just want a steady visible re-render cadence.
  setInterval(() => { tick.value += 1; }, 1000);

  morphBind(root, () => (
    <div className="demo-card">
      <h2>3. Focus / cursor preservation <span className="demo-tag">morphdom in action</span></h2>

      <div className="demo-row">
        <label className="demo-label">
          Type your name:
          <input
            type="text"
            id="focus-name-input"
            value={name.value}
            placeholder="(focus stays put on every tick)"
            data-action="set-name"
            className="demo-input"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <button type="button" data-action="toggle-letters" className="demo-btn demo-btn-ghost">
          {showLetters.value ? 'hide' : 'show'} letter list
        </button>
      </div>

      <p className="demo-tick-line">
        Re-render tick: <strong>{tick.value}</strong>
        {' · '}
        Hello, <strong>{name.value === '' ? '<empty>' : name.value}</strong>
      </p>

      {showLetters.value && name.value !== '' ? (
        <ul className="demo-letter-list">
          {name.value.split('').map((ch, i) => (
            <li key={i} className="demo-letter">{ch}</li>
          ))}
        </ul>
      ) : null}

      <p className="demo-note">
        The <code>tick</code> signal increments every second, forcing this
        whole block to re-render. The input's <code>id</code> gives morphdom a
        stable diff key, and the focus-preservation hook copies the live
        value + selection range into the new template before applying it. Try:
        click into the input, type slowly — the cursor should never jump and
        the value should never reset, even though every visible piece of text
        in this card is re-rendered every second.
      </p>
    </div>
  ));

  delegate(root, 'input', '[data-action="set-name"]', (_e, target) => {
    name.value = (target as HTMLInputElement).value;
  });
  delegate(root, 'click', '[data-action="toggle-letters"]', () => {
    showLetters.value = !showLetters.value;
  });
}
