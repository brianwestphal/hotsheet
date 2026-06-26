/**
 * HS-9097 — generate a Y4M video file whose luma plane IS a QR code, so
 * Chromium's fake video-capture device (`--use-file-for-fake-video-capture`) can
 * feed a real, decodable QR into the `/pair` page's `@zxing/browser` scanner. The
 * end-to-end pairing camera path (getUserMedia → ZXing decode → enroll) then runs
 * for real in Playwright with no physical camera.
 *
 * We build the frame straight from `QRCode.create()`'s module matrix (1 = dark,
 * 0 = light) — no PNG encode/decode needed: dark modules become luma 0, light
 * modules luma 255, and the chroma planes are constant 128 (gray), giving a clean
 * black-on-white QR. Output is a single `C420jpeg` frame (Chromium loops it).
 */
import { writeFileSync } from 'node:fs';

import QRCode from 'qrcode';

/** Round up to the next even number (C420 chroma subsampling needs even dims). */
function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Render `text` as a QR code into a Y4M file at `filePath`.
 *
 * @param scale  pixels per QR module (bigger = easier for the decoder)
 * @param quiet  quiet-zone width in modules around the symbol (QR spec wants ≥4)
 */
export function writeQrY4m(
  text: string,
  filePath: string,
  { scale = 12, quiet = 4 }: { scale?: number; quiet?: number } = {},
): { width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data; // length size*size, 1 = dark module

  const modules = size + quiet * 2;
  const dim = even(modules * scale);
  const width = dim;
  const height = dim;

  // Luma plane: white (255) background, dark modules painted black (0).
  const y = new Uint8Array(width * height).fill(255);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (data[row * size + col] === 0) continue; // light module — leave white
      const x0 = (col + quiet) * scale;
      const y0 = (row + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const base = (y0 + dy) * width + x0;
        y.fill(0, base, base + scale);
      }
    }
  }

  // Chroma planes: constant gray (128) at half resolution.
  const chroma = new Uint8Array((width / 2) * (height / 2)).fill(128);

  const header = `YUV4MPEG2 W${String(width)} H${String(height)} F25:1 Ip A1:1 C420jpeg\n`;
  const frame = Buffer.concat([
    Buffer.from('FRAME\n', 'ascii'),
    Buffer.from(y),
    Buffer.from(chroma),
    Buffer.from(chroma),
  ]);
  writeFileSync(filePath, Buffer.concat([Buffer.from(header, 'ascii'), frame]));
  return { width, height };
}
