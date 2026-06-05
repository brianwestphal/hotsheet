// @vitest-environment happy-dom
/**
 * HS-8662 — paste files/images to create attachments.
 *
 * Pins the selection-driven target resolution: 1 selected → that ticket;
 * 0 selected → a new "Attachment"/"Attachments" ticket; 2+ selected → no-op +
 * a toast. Plus `extractClipboardFiles`'s `.files` → `.items` fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTicket, uploadAttachment } from '../api/index.js';
import { extractClipboardFiles, handlePastedFiles } from './pasteAttachments.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';
import { showToast } from './toast.js';

vi.mock('../api/index.js', () => ({
  createTicket: vi.fn(),
  uploadAttachment: vi.fn(),
}));
vi.mock('./ticketList.js', () => ({ loadTickets: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));

const createTicketMock = vi.mocked(createTicket);
const uploadAttachmentMock = vi.mocked(uploadAttachment);
const loadTicketsMock = vi.mocked(loadTickets);
const showToastMock = vi.mocked(showToast);

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

beforeEach(() => {
  createTicketMock.mockReset().mockResolvedValue({ id: 4242 } as unknown as Awaited<ReturnType<typeof createTicket>>);
  uploadAttachmentMock.mockReset().mockResolvedValue({} as unknown as Awaited<ReturnType<typeof uploadAttachment>>);
  loadTicketsMock.mockReset().mockResolvedValue(undefined);
  showToastMock.mockReset();
  state.selectedIds.clear();
});

describe('handlePastedFiles (HS-8662)', () => {
  it('1 ticket selected → attaches to that ticket, no new ticket created', async () => {
    state.selectedIds.add(7);
    const id = await handlePastedFiles([file('a.png')]);

    expect(id).toBe(7);
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).toHaveBeenCalledExactlyOnceWith(7, expect.any(File));
    expect(loadTicketsMock).toHaveBeenCalled();
  });

  it('0 selected → creates a new "Attachment" ticket (singular) and attaches', async () => {
    const id = await handlePastedFiles([file('a.png')]);

    expect(id).toBe(4242);
    expect(createTicketMock).toHaveBeenCalledExactlyOnceWith({ title: 'Attachment' });
    expect(uploadAttachmentMock).toHaveBeenCalledExactlyOnceWith(4242, expect.any(File));
  });

  it('0 selected, multiple files → new ticket titled "Attachments" (plural), one upload each', async () => {
    const id = await handlePastedFiles([file('a.png'), file('b.png')]);

    expect(id).toBe(4242);
    expect(createTicketMock).toHaveBeenCalledExactlyOnceWith({ title: 'Attachments' });
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentMock).toHaveBeenNthCalledWith(1, 4242, expect.any(File));
    expect(uploadAttachmentMock).toHaveBeenNthCalledWith(2, 4242, expect.any(File));
  });

  it('2+ selected → no-op + warning toast, nothing uploaded or created', async () => {
    state.selectedIds.add(1);
    state.selectedIds.add(2);
    const id = await handlePastedFiles([file('a.png')]);

    expect(id).toBeNull();
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      "Pasting attachments to multiple tickets at once isn't supported",
      { variant: 'warning' },
    );
  });

  it('empty file list → no-op', async () => {
    const id = await handlePastedFiles([]);
    expect(id).toBeNull();
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });
});

describe('extractClipboardFiles (HS-8662)', () => {
  it('reads from .files when present', () => {
    const f = file('a.png');
    const data = { files: [f], items: [] } as unknown as DataTransfer;
    expect(extractClipboardFiles(data)).toEqual([f]);
  });

  it('falls back to file-kind .items when .files is empty', () => {
    const f = file('shot.png');
    const data = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => f },
      ],
    } as unknown as DataTransfer;
    expect(extractClipboardFiles(data)).toEqual([f]);
  });

  it('returns [] for a null clipboard', () => {
    expect(extractClipboardFiles(null)).toEqual([]);
  });
});
