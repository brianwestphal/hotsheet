// HS-7969 follow-up #2 — pure-helper tests for the ANSI-to-safe-HTML
// converter that paints the §37 quit-confirm master-detail preview pane.
import { describe, expect, it } from 'vitest';

import { type AnsiPalette, ansiToSafeHtml, escapeHtml } from './ansiSpans.js';

const PALETTE: AnsiPalette = {
  black: '#000', red: '#f00', green: '#0f0', yellow: '#ff0',
  blue: '#00f', magenta: '#f0f', cyan: '#0ff', white: '#fff',
  brightBlack: '#444', brightRed: '#f44', brightGreen: '#4f4', brightYellow: '#ff4',
  brightBlue: '#44f', brightMagenta: '#f4f', brightCyan: '#4ff', brightWhite: '#eee',
  defaultFg: '#aaa', defaultBg: '#222',
};

describe('escapeHtml (HS-7969 follow-up #2)', () => {
  it('escapes all four HTML special characters', () => {
    expect(escapeHtml('a < b > c & d "e"')).toBe('a &lt; b &gt; c &amp; d &quot;e&quot;');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('passes through unicode unchanged (no over-escaping)', () => {
    expect(escapeHtml('λ café 日本語')).toBe('λ café 日本語');
  });
});

describe('ansiToSafeHtml — plain text (HS-7969 follow-up #2)', () => {
  it('returns the empty string for empty input', () => {
    expect(ansiToSafeHtml('', PALETTE)).toBe('');
  });

  it('escapes HTML special characters in plain text', () => {
    expect(ansiToSafeHtml('<div>&"</div>', PALETTE)).toBe('&lt;div&gt;&amp;&quot;&lt;/div&gt;');
  });

  it('preserves newlines (the caller wraps in <pre>)', () => {
    expect(ansiToSafeHtml('line1\nline2\n', PALETTE)).toBe('line1\nline2\n');
  });
});

describe('ansiToSafeHtml — basic SGR colours', () => {
  it('renders red foreground with the palette colour', () => {
    const html = ansiToSafeHtml('\x1b[31merror\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00">error</span>');
  });

  it('renders green background', () => {
    const html = ansiToSafeHtml('\x1b[42mok\x1b[0m', PALETTE);
    expect(html).toBe('<span style="background:#0f0">ok</span>');
  });

  it('renders bright fg via 9x codes', () => {
    const html = ansiToSafeHtml('\x1b[91mhot\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f44">hot</span>');
  });

  it('combines multiple codes in one CSI', () => {
    const html = ansiToSafeHtml('\x1b[1;31mBOOM\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00;font-weight:bold">BOOM</span>');
  });

  it('handles bold + italic + underline together', () => {
    const html = ansiToSafeHtml('\x1b[1;3;4mfancy\x1b[0m', PALETTE);
    expect(html).toBe('<span style="font-weight:bold;font-style:italic;text-decoration:underline">fancy</span>');
  });
});

describe('ansiToSafeHtml — reset behaviour', () => {
  it('drops styling after reset code', () => {
    const html = ansiToSafeHtml('\x1b[31mred\x1b[0m plain', PALETTE);
    expect(html).toBe('<span style="color:#f00">red</span> plain');
  });

  it('treats empty CSI [m as reset (per ECMA-48)', () => {
    const html = ansiToSafeHtml('\x1b[31mred\x1b[m plain', PALETTE);
    expect(html).toBe('<span style="color:#f00">red</span> plain');
  });

  it('39 resets fg without touching bold', () => {
    const html = ansiToSafeHtml('\x1b[1;31mbold-red\x1b[39m bold-only\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00;font-weight:bold">bold-red</span><span style="font-weight:bold"> bold-only</span>');
  });
});

describe('ansiToSafeHtml — 256-colour + true-colour', () => {
  it('maps 256-colour fg to nearest basic-8 entry for low indices', () => {
    const html = ansiToSafeHtml('\x1b[38;5;1mred\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00">red</span>');
  });

  it('renders true-colour fg verbatim', () => {
    const html = ansiToSafeHtml('\x1b[38;2;128;200;50mlime\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:rgb(128,200,50)">lime</span>');
  });

  it('renders true-colour bg verbatim', () => {
    const html = ansiToSafeHtml('\x1b[48;2;1;2;3mbg\x1b[0m', PALETTE);
    expect(html).toBe('<span style="background:rgb(1,2,3)">bg</span>');
  });

  it('256-colour high index falls back to brightWhite', () => {
    const html = ansiToSafeHtml('\x1b[38;5;200mhi\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#eee">hi</span>');
  });
});

describe('ansiToSafeHtml — escapes inside coloured spans', () => {
  it('escapes < > & " inside a styled fragment', () => {
    const html = ansiToSafeHtml('\x1b[31m<a&"b>\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00">&lt;a&amp;&quot;b&gt;</span>');
  });
});

describe('ansiToSafeHtml — non-SGR sequences are dropped', () => {
  it('drops cursor-move CSI without affecting surrounding text', () => {
    const html = ansiToSafeHtml('before\x1b[2Aafter', PALETTE);
    expect(html).toBe('beforeafter');
  });

  it('drops OSC sequences (BEL terminator)', () => {
    const html = ansiToSafeHtml('start\x1b]0;title\x07end', PALETTE);
    expect(html).toBe('startend');
  });

  it('drops OSC sequences (ST terminator)', () => {
    const html = ansiToSafeHtml('start\x1b]0;title\x1b\\end', PALETTE);
    expect(html).toBe('startend');
  });

  it('drops bare ESC + single-char codes', () => {
    const html = ansiToSafeHtml('a\x1b=b', PALETTE);
    expect(html).toBe('ab');
  });
});

describe('ansiToSafeHtml — multi-fragment and mixed content', () => {
  it('emits multiple consecutive styled spans without flush gaps', () => {
    const html = ansiToSafeHtml('\x1b[31mR\x1b[32mG\x1b[34mB\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#f00">R</span><span style="color:#0f0">G</span><span style="color:#00f">B</span>');
  });

  it('does not wrap plain prefix in a useless span', () => {
    const html = ansiToSafeHtml('plain \x1b[31mred\x1b[0m', PALETTE);
    expect(html).toBe('plain <span style="color:#f00">red</span>');
  });

  it('preserves trailing plain text after a coloured span', () => {
    const html = ansiToSafeHtml('\x1b[1;33mWARN\x1b[0m: something happened', PALETTE);
    expect(html).toBe('<span style="color:#ff0;font-weight:bold">WARN</span>: something happened');
  });
});

describe('ansiToSafeHtml — reverse video', () => {
  it('swaps fg and bg under code 7', () => {
    const html = ansiToSafeHtml('\x1b[31;42;7mrev\x1b[0m', PALETTE);
    // red fg + green bg, reversed → green fg, red bg.
    expect(html).toBe('<span style="color:#0f0;background:#f00">rev</span>');
  });

  it('27 turns reverse off', () => {
    const html = ansiToSafeHtml('\x1b[31;42;7mrev\x1b[27m back\x1b[0m', PALETTE);
    expect(html).toBe('<span style="color:#0f0;background:#f00">rev</span><span style="color:#f00;background:#0f0"> back</span>');
  });
});
