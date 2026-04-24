import { describe, expect, it } from 'vitest';

import { combineQuotedResponse, type FeedbackBlock, parseFeedbackBlocks } from './feedbackParser.js';

describe('parseFeedbackBlocks (HS-6998)', () => {
  it('returns an empty array on empty or whitespace input', () => {
    expect(parseFeedbackBlocks('')).toEqual([]);
    expect(parseFeedbackBlocks('   \n  \n')).toEqual([]);
  });

  it('returns a single block for a single paragraph', () => {
    const blocks = parseFeedbackBlocks('Just one question?');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].markdown).toBe('Just one question?');
    expect(blocks[0].html).toContain('<p>');
    expect(blocks[0].html).toContain('Just one question?');
  });

  it('splits multi-paragraph input into one block per paragraph', () => {
    const blocks = parseFeedbackBlocks('First paragraph.\n\nSecond paragraph.\n\nThird.');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].markdown).toBe('First paragraph.');
    expect(blocks[1].markdown).toBe('Second paragraph.');
    expect(blocks[2].markdown).toBe('Third.');
  });

  it('treats a list as a single block (does NOT split list items)', () => {
    const blocks = parseFeedbackBlocks('Intro.\n\n- one\n- two\n- three\n\nOutro.');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].markdown).toBe('Intro.');
    expect(blocks[1].markdown).toMatch(/- one/);
    expect(blocks[1].markdown).toMatch(/- two/);
    expect(blocks[1].markdown).toMatch(/- three/);
    expect(blocks[2].markdown).toBe('Outro.');
  });

  it('treats a numbered list the same way (single block)', () => {
    const blocks = parseFeedbackBlocks('1. first\n2. second\n3. third');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].markdown).toMatch(/1\. first/);
    expect(blocks[0].markdown).toMatch(/3\. third/);
  });

  it('preserves headings, code blocks, and blockquotes as their own blocks', () => {
    const prompt = '# Heading\n\nSome prose.\n\n```\ncode\n```\n\n> a quote';
    const blocks = parseFeedbackBlocks(prompt);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    // Heading renders as <h1>
    expect(blocks[0].html).toMatch(/<h1/);
    // Code block renders as <pre><code>
    const codeBlock = blocks.find(b => b.html.includes('<pre>'));
    expect(codeBlock).toBeDefined();
    // Blockquote
    const quoteBlock = blocks.find(b => b.html.includes('<blockquote>'));
    expect(quoteBlock).toBeDefined();
  });

  it('pre-renders block HTML ready for raw() injection', () => {
    const blocks = parseFeedbackBlocks('Hello **world**!');
    expect(blocks[0].html).toContain('<strong>world</strong>');
  });

  it('skips blank space tokens so the caller doesn\'t see phantom blocks', () => {
    const blocks = parseFeedbackBlocks('A\n\n\n\n\nB');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].markdown).toBe('A');
    expect(blocks[1].markdown).toBe('B');
  });

  it('handles the reported problem prompt — paragraph, bullet list, question paragraph, options list', () => {
    const prompt = [
      'I closed this with the Arabic fix shipped, but my close note implicitly asked about extending the same pattern to CJK and symbol emoji.',
      '',
      '- CJK (kanji, hiragana, katakana, hangul, etc.)',
      '- Symbol emoji (U+2691 black flag and similar)',
      '- Hebrew, Thai, Devanagari, etc.',
      '',
      'Question: which subset do you want me to handle? Options:',
      '',
      '1. Just CJK',
      '2. CJK + symbol emoji',
      '3. comprehensive',
    ].join('\n');
    const blocks = parseFeedbackBlocks(prompt);
    // Expected: intro paragraph, bullet list (one block), question paragraph, options list (one block)
    expect(blocks).toHaveLength(4);
    expect(blocks[0].markdown).toMatch(/^I closed this/);
    expect(blocks[1].markdown).toMatch(/CJK \(kanji/);
    expect(blocks[2].markdown).toMatch(/^Question:/);
    expect(blocks[3].markdown).toMatch(/Just CJK/);
  });
});

describe('combineQuotedResponse (HS-6998)', () => {
  function mkBlocks(...mds: string[]): FeedbackBlock[] {
    return mds.map(md => ({ markdown: md, html: '' }));
  }

  it('returns the catch-all verbatim when there are no inline responses', () => {
    const blocks = mkBlocks('Hi', 'there');
    expect(combineQuotedResponse(blocks, [], '  Just a reply.  ')).toBe('Just a reply.');
  });

  it('returns an empty string when nothing is filled in', () => {
    const blocks = mkBlocks('Hi', 'there');
    expect(combineQuotedResponse(blocks, [], '')).toBe('');
    expect(combineQuotedResponse(blocks, [{ blockIndex: 0, text: '   ' }], '   ')).toBe('');
  });

  it('quotes prompt blocks and injects inline responses after the matching block', () => {
    const blocks = mkBlocks('Alpha question?', 'Beta question?');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 0, text: 'Answer to alpha' }],
      '',
    );
    // Expected shape:
    // > Alpha question?
    //
    // Answer to alpha
    //
    // > Beta question?
    expect(out).toContain('> Alpha question?');
    expect(out).toContain('Answer to alpha');
    expect(out).toContain('> Beta question?');
    // Answer appears between the two quoted blocks.
    const alphaIdx = out.indexOf('Alpha question?');
    const ansIdx = out.indexOf('Answer to alpha');
    const betaIdx = out.indexOf('Beta question?');
    expect(alphaIdx).toBeLessThan(ansIdx);
    expect(ansIdx).toBeLessThan(betaIdx);
  });

  it('appends the catch-all at the end when inline responses are also present', () => {
    const blocks = mkBlocks('Q1?', 'Q2?');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 0, text: 'ans1' }],
      'and also a general note',
    );
    expect(out.endsWith('and also a general note')).toBe(true);
    expect(out).toContain('ans1');
    expect(out).toContain('> Q1?');
    expect(out).toContain('> Q2?');
  });

  it('quotes multi-line markdown blocks correctly (every line prefixed with "> ")', () => {
    const blocks = mkBlocks('- item one\n- item two\n- item three');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 0, text: 'pick one' }],
      '',
    );
    expect(out).toContain('> - item one');
    expect(out).toContain('> - item two');
    expect(out).toContain('> - item three');
  });

  it('allows multiple inline responses attached to the same block', () => {
    const blocks = mkBlocks('Question?');
    const out = combineQuotedResponse(
      blocks,
      [
        { blockIndex: 0, text: 'first thought' },
        { blockIndex: 0, text: 'second thought' },
      ],
      '',
    );
    expect(out).toContain('first thought');
    expect(out).toContain('second thought');
    expect(out.indexOf('first thought')).toBeLessThan(out.indexOf('second thought'));
  });

  it('ignores inline responses whose text is empty or whitespace', () => {
    const blocks = mkBlocks('Q?');
    // Only-whitespace inline entries should be treated as "no inline response"
    // so we fall through to the catch-all-only path (no quoting).
    expect(combineQuotedResponse(blocks, [{ blockIndex: 0, text: '   ' }], 'plain')).toBe('plain');
  });

  it('trims inline response text but preserves internal structure', () => {
    const blocks = mkBlocks('Q?');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 0, text: '\n\n  yes, and also no  \n\n' }],
      '',
    );
    expect(out).toContain('yes, and also no');
    // No leading/trailing whitespace on the inline piece itself.
    expect(out).not.toMatch(/ {2,}yes/);
  });

  it('appends out-of-range blockIndex responses at the end so nothing silently disappears', () => {
    const blocks = mkBlocks('Q?');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 5, text: 'stray' }],
      '',
    );
    expect(out).toContain('stray');
  });

  it('emits quoted blocks separated by blank lines so markdown renderers group them cleanly', () => {
    const blocks = mkBlocks('Block A', 'Block B');
    const out = combineQuotedResponse(
      blocks,
      [{ blockIndex: 0, text: 'reply' }],
      '',
    );
    // Between each top-level piece we should have a blank line separator.
    expect(out).toMatch(/> Block A\n\nreply\n\n> Block B/);
  });
});
