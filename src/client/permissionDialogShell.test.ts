/**
 * HS-8066 — unit tests for the shared dialog-shell chrome that
 * underlies §47's permission popup and §52's terminal-prompt overlay.
 * The shell owns the header / footer / anchor positioning / lifecycle
 * — body / actions / always-affordance are pluggable slots passed by
 * the consumer.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { openPermissionDialogShell } from './permissionDialogShell.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openPermissionDialogShell — header (HS-8066)', () => {
  it('renders the title with no chip when toolChip is omitted', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell',
      ariaLabel: 'Test',
      title: 'Run command',
    });
    const overlay = document.querySelector('.test-shell');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('.dialog-shell-tool')).toBeNull();
    expect(overlay?.querySelector('.dialog-shell-title')?.textContent).toBe('Run command');
  });

  it('renders the chip + title when toolChip is provided', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell',
      ariaLabel: 'Test',
      toolChip: 'Bash',
      title: 'Run `ls`',
    });
    const overlay = document.querySelector('.test-shell');
    expect(overlay?.querySelector('.dialog-shell-tool')?.textContent).toBe('Bash');
    expect(overlay?.querySelector('.dialog-shell-title')?.textContent).toBe('Run `ls`');
  });

  it('always renders a close X button', () => {
    openPermissionDialogShell({ rootClassName: 'test-shell', ariaLabel: 'T', title: 't' });
    expect(document.querySelector('.dialog-shell-close')).not.toBeNull();
  });
});

describe('openPermissionDialogShell — long title handling (HS-8156)', () => {
  function longTitle(chars: number): string {
    const sentence = 'This permission request has an unusually long description. ';
    let out = '';
    while (out.length < chars) out += sentence;
    return out.slice(0, chars);
  }

  it('renders short single-line titles verbatim with no overflow block + no tooltip', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: 'Run `ls`',
    });
    const titleEl = document.querySelector('.dialog-shell-title');
    expect(titleEl?.textContent).toBe('Run `ls`');
    expect(titleEl?.getAttribute('title')).toBeNull();
    expect(document.querySelector('.dialog-shell-title-overflow')).toBeNull();
  });

  it('truncates titles longer than the long-threshold to a single-line summary in the header', () => {
    const big = longTitle(800);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: big,
    });
    const headerText = document.querySelector('.dialog-shell-title')?.textContent ?? '';
    expect(headerText.endsWith('…')).toBe(true);
    // Header should be substantially shorter than the full title.
    expect(headerText.length).toBeLessThan(big.length);
    expect(headerText.length).toBeLessThanOrEqual(122); // 120 + ellipsis + slack
  });

  it('exposes the full long title via the `title` attribute (browser tooltip)', () => {
    const big = longTitle(800);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: big,
    });
    expect(document.querySelector('.dialog-shell-title')?.getAttribute('title')).toBe(big);
  });

  it('moves the full long title into a scroll-bounded overflow block at the top of the body', () => {
    const big = longTitle(800);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: big,
    });
    const overflow = document.querySelector('.dialog-shell-title-overflow');
    expect(overflow).not.toBeNull();
    expect(overflow?.textContent).toBe(big);
    // Lives inside the body slot so it scrolls / collapses with the body.
    expect(overflow?.parentElement?.getAttribute('data-role')).toBe('body');
  });

  it('overflow block is the FIRST child of the body slot, ahead of consumer body content', () => {
    const consumerBody = document.createElement('div');
    consumerBody.id = 'consumer-body';
    consumerBody.textContent = 'preview content';
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: longTitle(500),
      bodyElement: consumerBody,
    });
    const bodySlot = document.querySelector('[data-role="body"]');
    expect(bodySlot?.children[0].className).toBe('dialog-shell-title-overflow');
    expect(bodySlot?.children[1].id).toBe('consumer-body');
  });

  it('treats a multi-line title as long even when its character count is under the threshold', () => {
    const multi = 'first line\nsecond line\nthird line';
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: multi,
    });
    expect(document.querySelector('.dialog-shell-title-overflow')?.textContent).toBe(multi);
    expect(document.querySelector('.dialog-shell-title')?.getAttribute('title')).toBe(multi);
  });

  it('header summary collapses internal whitespace runs to single spaces', () => {
    const messy = 'word1' + '\n\n\n' + ' '.repeat(50) + 'word2 ' + 'x'.repeat(300);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: messy,
    });
    const header = document.querySelector('.dialog-shell-title')?.textContent ?? '';
    expect(header).not.toContain('\n');
    expect(header).not.toMatch(/ {2,}/);
    expect(header.startsWith('word1 word2 ')).toBe(true);
  });

  it('still mounts the overflow block when no consumer body is provided', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: longTitle(500),
    });
    const bodySlot = document.querySelector('[data-role="body"]');
    expect(bodySlot?.children.length).toBe(1);
    expect(bodySlot?.children[0].className).toBe('dialog-shell-title-overflow');
  });

  it('is title-attribute-only for short titles (no spurious tooltip)', () => {
    // 199 chars on one line → just under the threshold, no overflow.
    const justUnder = 'a'.repeat(199);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T',
      title: justUnder,
    });
    expect(document.querySelector('.dialog-shell-title-overflow')).toBeNull();
    expect(document.querySelector('.dialog-shell-title')?.getAttribute('title')).toBeNull();
  });
});

describe('openPermissionDialogShell — body slot (HS-8066)', () => {
  it('mounts a pre-built bodyElement DOM tree', () => {
    const body = document.createElement('div');
    body.id = 'my-body';
    body.textContent = 'preview content';
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      bodyElement: body,
    });
    expect(document.getElementById('my-body')).not.toBeNull();
    expect(document.getElementById('my-body')?.textContent).toBe('preview content');
  });

  it('mounts pre-rendered bodyHtml when bodyElement is omitted', async () => {
    const { raw } = await import('../jsx-runtime.js');
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      bodyHtml: raw('<pre class="my-preview">cmd output</pre>'),
    });
    expect(document.querySelector('.my-preview')).not.toBeNull();
    expect(document.querySelector('.my-preview')?.textContent).toBe('cmd output');
  });

  it('leaves body slot empty when neither bodyElement nor bodyHtml is provided', () => {
    openPermissionDialogShell({ rootClassName: 'test-shell', ariaLabel: 'T', title: 't' });
    const slot = document.querySelector('[data-role="body"]');
    expect(slot).not.toBeNull();
    expect(slot?.children.length).toBe(0);
    expect(slot?.textContent).toBe('');
  });
});

describe('openPermissionDialogShell — actions + affordance slots (HS-8066)', () => {
  it('mounts the actions DOM tree in the actions slot', () => {
    const actions = document.createElement('div');
    actions.className = 'my-actions';
    actions.appendChild(document.createElement('button'));
    actions.appendChild(document.createElement('button'));
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      actions,
    });
    expect(document.querySelector('.my-actions')).not.toBeNull();
    expect(document.querySelector('.my-actions')?.children.length).toBe(2);
  });

  it('mounts the alwaysAffordance DOM tree in the affordance slot', () => {
    const affordance = document.createElement('label');
    affordance.id = 'my-affordance';
    affordance.textContent = 'Always allow';
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      alwaysAffordance: affordance,
    });
    expect(document.getElementById('my-affordance')).not.toBeNull();
  });

  it('null alwaysAffordance is safely omitted (no slot content)', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      alwaysAffordance: null,
    });
    const slot = document.querySelector('[data-role="affordance"]');
    expect(slot?.children.length).toBe(0);
  });
});

describe('openPermissionDialogShell — footer links (HS-8066)', () => {
  it('omits the entire link row when neither callback is provided', () => {
    openPermissionDialogShell({ rootClassName: 'test-shell', ariaLabel: 'T', title: 't' });
    expect(document.querySelector('.dialog-shell-links')).toBeNull();
  });

  it('renders both links + separator when both callbacks are provided', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onMinimize: () => { /* */ },
      onNoResponseNeeded: () => { /* */ },
    });
    expect(document.querySelector('.dialog-shell-minimize-link')).not.toBeNull();
    expect(document.querySelector('.dialog-shell-dismiss-link')).not.toBeNull();
    expect(document.querySelector('.dialog-shell-links-sep')).not.toBeNull();
  });

  it('omits the separator when only one link is rendered', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onMinimize: () => { /* */ },
    });
    expect(document.querySelector('.dialog-shell-minimize-link')).not.toBeNull();
    expect(document.querySelector('.dialog-shell-dismiss-link')).toBeNull();
    expect(document.querySelector('.dialog-shell-links-sep')).toBeNull();
  });

  it('Minimize link tears down DOM and fires onMinimize, NOT onClose', () => {
    let minimizeCalls = 0;
    let closeCalls = 0;
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onMinimize: () => { minimizeCalls += 1; },
      onClose: () => { closeCalls += 1; },
    });
    document.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link')?.click();
    expect(minimizeCalls).toBe(1);
    expect(closeCalls).toBe(0);
    expect(document.querySelector('.test-shell')).toBeNull();
  });

  it('No-response-needed link tears down DOM and fires onNoResponseNeeded, NOT onClose', () => {
    let dismissCalls = 0;
    let closeCalls = 0;
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onNoResponseNeeded: () => { dismissCalls += 1; },
      onClose: () => { closeCalls += 1; },
    });
    document.querySelector<HTMLAnchorElement>('.dialog-shell-dismiss-link')?.click();
    expect(dismissCalls).toBe(1);
    expect(closeCalls).toBe(0);
    expect(document.querySelector('.test-shell')).toBeNull();
  });
});

describe('openPermissionDialogShell — close button + Esc + lifecycle (HS-8066)', () => {
  it('close button tears down DOM and fires onClose', () => {
    let closeCalls = 0;
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
    });
    document.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();
    expect(closeCalls).toBe(1);
    expect(document.querySelector('.test-shell')).toBeNull();
  });

  it('Esc closes the overlay when escClosesOverlay=true', () => {
    let closeCalls = 0;
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
      escClosesOverlay: true,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closeCalls).toBe(1);
    expect(document.querySelector('.test-shell')).toBeNull();
  });

  it('Esc is unhandled when escClosesOverlay is false (default)', () => {
    let closeCalls = 0;
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closeCalls).toBe(0);
    expect(document.querySelector('.test-shell')).not.toBeNull();
  });

  it('handle.tearDownDom does NOT fire onClose', () => {
    let closeCalls = 0;
    const handle = openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
    });
    handle.tearDownDom();
    expect(closeCalls).toBe(0);
    expect(document.querySelector('.test-shell')).toBeNull();
  });

  it('handle.close fires onClose AND tears down DOM (idempotent on double call)', () => {
    let closeCalls = 0;
    const handle = openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
    });
    handle.close();
    handle.close();
    expect(closeCalls).toBe(1);
    expect(document.querySelector('.test-shell')).toBeNull();
  });

  it('Esc keydown listener is removed after teardown so subsequent Esc presses do nothing', () => {
    let closeCalls = 0;
    const handle = openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      onClose: () => { closeCalls += 1; },
      escClosesOverlay: true,
    });
    handle.close();
    expect(closeCalls).toBe(1);
    // Subsequent Esc should not increment the count (handler disposed).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closeCalls).toBe(1);
  });
});

describe('openPermissionDialogShell — anchor positioning (HS-8066)', () => {
  it('positions the overlay below the .project-tab[data-secret=...] when projectSecret is provided + tab exists', () => {
    const tab = document.createElement('div');
    tab.className = 'project-tab';
    tab.dataset.secret = 'secret-x';
    // happy-dom doesn't lay out elements automatically, but
    // getBoundingClientRect returns synthetic values we can stub.
    Object.defineProperty(tab, 'getBoundingClientRect', {
      value: () => ({ top: 50, bottom: 80, left: 100, right: 200, width: 100, height: 30, x: 100, y: 50, toJSON: () => ({}) }),
    });
    document.body.appendChild(tab);
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      projectSecret: 'secret-x',
    });
    const overlay = document.querySelector<HTMLElement>('.test-shell');
    expect(overlay?.style.top).toBe('84px'); // tabRect.bottom + 4
    expect(overlay?.style.transform).toBe('none');
  });

  it('falls back to SCSS-default position when the tab is not in the DOM', () => {
    openPermissionDialogShell({
      rootClassName: 'test-shell', ariaLabel: 'T', title: 't',
      projectSecret: 'no-such-tab',
    });
    const overlay = document.querySelector<HTMLElement>('.test-shell');
    expect(overlay?.style.top).toBe('');
    expect(overlay?.style.transform).toBe('');
  });
});
