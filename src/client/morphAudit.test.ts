// @vitest-environment happy-dom
/**
 * HS-9538 — the morph redundancy audit.
 *
 * The failure this guards against is the one HS-9537 ran into: an instrument that
 * looks live and reports zero because it is not wired to what it claims to
 * measure. So these assert BOTH directions — that a redundant render is counted,
 * and that a genuine change is not.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  disableMorphAudit,
  enableMorphAudit,
  isMorphAuditEnabled,
  morphAuditReport,
  recordMorph,
  resetMorphAudit,
  serializeTemplate,
  targetLabel,
} from './morphAudit.js';

afterEach(() => { disableMorphAudit(); document.body.innerHTML = ''; });

const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as Element;
};

describe('opt-in', () => {
  it('is OFF by default — production must pay nothing', () => {
    // The comparison serializes the template, which is precisely the cost morph's
    // byte-equal fast path exists to avoid.
    expect(isMorphAuditEnabled()).toBe(false);
    const target = document.createElement('div');
    expect(recordMorph(target, '<p>x</p>')).toBe(false);
    expect(recordMorph(target, '<p>x</p>')).toBe(false); // identical, still not counted
    expect(morphAuditReport()).toEqual([]);
  });

  it('records once enabled', () => {
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, '<p>x</p>');
    expect(morphAuditReport()).toHaveLength(1);
  });
});

describe('reset', () => {
  it('does NOT switch the audit off — a "measure from here" reset must keep measuring', () => {
    // HS-9542. `reset()` used to set `enabled = false`, so the documented workflow
    // (enable → drive → reset → drive → report) reported zeros: the instrument was
    // silently off for the half being measured. That is the exact HS-9537 failure
    // this module exists to end, and it was found by a harness positive control
    // rather than by any test here.
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, '<p>x</p>');
    resetMorphAudit();

    expect(isMorphAuditEnabled()).toBe(true);
    recordMorph(target, '<p>y</p>');
    expect(morphAuditReport()).toHaveLength(1);
  });

  it('clears the counters and the last-template memory', () => {
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, '<p>same</p>');
    resetMorphAudit();

    expect(morphAuditReport()).toEqual([]);
    // Nothing to be redundant against yet — the identical template is the FIRST
    // render of this measurement window, not a repeat.
    expect(recordMorph(target, '<p>same</p>')).toBe(false);
  });
});

describe('redundancy detection', () => {
  it('does NOT count the first render — there is nothing to repeat yet', () => {
    enableMorphAudit();
    const target = document.createElement('div');
    expect(recordMorph(target, '<p>x</p>')).toBe(false);
    expect(morphAuditReport()[0]).toMatchObject({ redundant: 0, total: 1 });
  });

  it('counts a byte-identical re-render as redundant', () => {
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, '<p>x</p>');
    expect(recordMorph(target, '<p>x</p>')).toBe(true);
    expect(recordMorph(target, '<p>x</p>')).toBe(true);
    expect(morphAuditReport()[0]).toMatchObject({ redundant: 2, total: 3 });
  });

  it('does NOT count a render whose output actually changed', () => {
    // The half that makes a nonzero count mean something.
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, '<p>x</p>');
    expect(recordMorph(target, '<p>y</p>')).toBe(false);
    expect(morphAuditReport()[0]).toMatchObject({ redundant: 0, total: 2 });
  });

  it('re-arms after a change — A, A, B, B counts two redundants, not three', () => {
    enableMorphAudit();
    const target = document.createElement('div');
    for (const html of ['<p>a</p>', '<p>a</p>', '<p>b</p>', '<p>b</p>']) recordMorph(target, html);
    expect(morphAuditReport()[0]).toMatchObject({ redundant: 2, total: 4 });
  });

  it('tracks targets independently, so one busy surface cannot mask another', () => {
    enableMorphAudit();
    const a = el('<div id="a"></div>');
    const b = el('<div id="b"></div>');
    recordMorph(a, '<p>x</p>'); recordMorph(a, '<p>x</p>'); // 1 redundant
    recordMorph(b, '<p>1</p>'); recordMorph(b, '<p>2</p>'); // 0 redundant
    const report = morphAuditReport();
    expect(report.find(r => r.label.includes('#a'))).toMatchObject({ redundant: 1 });
    expect(report.find(r => r.label.includes('#b'))).toMatchObject({ redundant: 0 });
  });

  it('reports worst offenders first', () => {
    enableMorphAudit();
    const quiet = el('<div id="quiet"></div>');
    const busy = el('<div id="busy"></div>');
    recordMorph(quiet, '<p>x</p>'); recordMorph(quiet, '<p>x</p>');
    for (let i = 0; i < 6; i++) recordMorph(busy, '<p>same</p>');
    expect(morphAuditReport()[0].label).toContain('#busy');
  });
});

describe('serializeTemplate', () => {
  it('handles all three shapes morph accepts', () => {
    // A string, an Element, and a SafeHtml-like — normalizing them is what makes
    // the comparison meaningful across call sites that build trees differently.
    expect(serializeTemplate('<p>x</p>')).toBe('<p>x</p>');
    expect(serializeTemplate(el('<p>x</p>'))).toBe('<p>x</p>');
    expect(serializeTemplate({ toString: () => '<p>x</p>' })).toBe('<p>x</p>');
  });

  it('lets an Element and an equivalent string compare equal', () => {
    // The same surface may be morphed from JSX one time and a raw string the next;
    // treating those as different would invent redundancy that isn't there — or
    // hide it.
    enableMorphAudit();
    const target = document.createElement('div');
    recordMorph(target, el('<p>x</p>'));
    expect(recordMorph(target, '<p>x</p>')).toBe(true);
  });
});

describe('targetLabel', () => {
  it('prefers an id, then a class, and always names the tag', () => {
    expect(targetLabel(el('<ul id="ticket-list" class="list"></ul>'))).toBe('ul#ticket-list.list');
    expect(targetLabel(el('<ul class="list"></ul>'))).toBe('ul.list');
    expect(targetLabel(el('<ul></ul>'))).toBe('ul');
  });

  it('groups structurally, so a list\'s rows do not become hundreds of report rows', () => {
    const r1 = el('<div class="ticket-row" data-id="1"></div>');
    const r2 = el('<div class="ticket-row" data-id="2"></div>');
    expect(targetLabel(r1)).toBe(targetLabel(r2));
  });
});
