/**
 * FIFO byte-buffer capped at a max size. Oldest bytes are dropped when
 * the capacity is exceeded. Used by TerminalSession to keep the recent
 * PTY output available for reattach-replay.
 */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(private maxBytes: number) {
    if (maxBytes <= 0) throw new Error('RingBuffer maxBytes must be positive');
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const over = this.totalBytes - this.maxBytes;
      if (head.length <= over) {
        this.chunks.shift();
        this.totalBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.totalBytes -= over;
      }
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.totalBytes);
  }

  size(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
