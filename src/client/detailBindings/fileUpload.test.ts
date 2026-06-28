// @vitest-environment happy-dom
/** HS-9143 — `bindDetailFileUpload` change + drag/drop handler branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailFileUpload } from './fileUpload.js';

const h = vi.hoisted(() => ({
  state: { activeTicketId: null as number | null },
  uploadAttachment: vi.fn(() => Promise.resolve()),
  openDetail: vi.fn(),
  loadTickets: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../api/index.js', () => ({ uploadAttachment: h.uploadAttachment }));
vi.mock('../detail.js', () => ({ openDetail: h.openDetail }));
vi.mock('../state.js', () => ({ state: h.state }));
vi.mock('../ticketList.js', () => ({ loadTickets: h.loadTickets }));

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const file = (): File => new File(['x'], 'a.txt', { type: 'text/plain' });

function input(): HTMLInputElement { return document.getElementById('detail-file-input') as HTMLInputElement; }
function body(): HTMLElement { return document.getElementById('detail-body')!; }
function setFiles(el: HTMLInputElement, files: File[]): void {
  Object.defineProperty(el, 'files', { configurable: true, value: files.length ? files : null });
}
function dragEvent(type: string, dt: { files?: File[]; types?: string[] } | undefined): Event {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  return ev;
}

beforeEach(() => {
  document.body.innerHTML = '<input id="detail-file-input" type="file"><div id="detail-body"></div>';
  h.state.activeTicketId = null;
  for (const k of ['uploadAttachment', 'openDetail', 'loadTickets'] as const) h[k].mockReset();
  h.uploadAttachment.mockResolvedValue(undefined); h.loadTickets.mockResolvedValue(undefined);
  bindDetailFileUpload();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('file input change', () => {
  it('uploads each selected file then reopens the detail', async () => {
    h.state.activeTicketId = 3;
    setFiles(input(), [file(), file()]);
    input().dispatchEvent(new Event('change'));
    await flush();
    expect(h.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(h.openDetail).toHaveBeenCalledWith(3);
    expect(h.loadTickets).toHaveBeenCalled();
  });

  it('no-ops with no files or no active ticket', async () => {
    h.state.activeTicketId = 3;
    setFiles(input(), []);
    input().dispatchEvent(new Event('change'));
    await flush();
    expect(h.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('drag-and-drop', () => {
  it('toggles .drop-active on dragenter (Files) and dragleave', () => {
    body().dispatchEvent(dragEvent('dragenter', { types: ['Files'] }));
    expect(body().classList.contains('drop-active')).toBe(true);
    body().dispatchEvent(dragEvent('dragleave', undefined));
    expect(body().classList.contains('drop-active')).toBe(false);
  });

  it('ignores a dragenter that does not carry Files', () => {
    body().dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }));
    expect(body().classList.contains('drop-active')).toBe(false);
  });

  it('uploads dropped files + clears the drop state', async () => {
    h.state.activeTicketId = 8;
    body().classList.add('drop-active');
    body().dispatchEvent(dragEvent('drop', { files: [file()] }));
    await flush();
    expect(h.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(h.openDetail).toHaveBeenCalledWith(8);
    expect(body().classList.contains('drop-active')).toBe(false);
  });

  it('drop with no active ticket does not upload', async () => {
    h.state.activeTicketId = null;
    body().dispatchEvent(dragEvent('drop', { files: [file()] }));
    await flush();
    expect(h.uploadAttachment).not.toHaveBeenCalled();
  });

  it('dragover sets the copy drop-effect (and tolerates no dataTransfer)', () => {
    const dt: { files?: File[]; types?: string[]; dropEffect?: string } = { types: ['Files'], dropEffect: '' };
    body().dispatchEvent(dragEvent('dragover', dt));
    expect(dt.dropEffect).toBe('copy');
    expect(() => body().dispatchEvent(dragEvent('dragover', undefined))).not.toThrow(); // no-dataTransfer branch
  });

  it('nested dragenter/dragleave balances the counter before clearing drop-active', () => {
    body().dispatchEvent(dragEvent('dragenter', { types: ['Files'] }));
    body().dispatchEvent(dragEvent('dragenter', { types: ['Files'] })); // counter = 2
    body().dispatchEvent(dragEvent('dragleave', undefined));
    expect(body().classList.contains('drop-active')).toBe(true); // counter 1, still active
    body().dispatchEvent(dragEvent('dragleave', undefined));
    expect(body().classList.contains('drop-active')).toBe(false); // counter 0
  });
});
