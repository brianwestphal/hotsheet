/**
 * HS-8952 — extract image references from a synced ticket body so the sync
 * engine can pull them down as Hot Sheet attachments.
 *
 * GitHub stores a pasted image in an issue body as either a raw HTML
 * `<img src="https://github.com/user-attachments/assets/…">` tag (the common
 * case — see the ticket screenshot) or a markdown `![alt](https://…)` image.
 * Pre-fix neither surfaced in the Hot Sheet attachments list. This is the pure
 * parsing half (no I/O); `imageAttachments.ts` does the download + storage.
 */

// `<img ... src="URL" ...>` — quote-delimited src (GitHub always quotes).
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
// `![alt](URL)` or `![alt](URL "title")` — capture the URL up to whitespace or `)`.
const MD_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * Return the distinct http(s) image URLs referenced in `body` (in first-seen
 * order). `data:` URIs and relative paths are skipped — only remotely-hosted
 * images can be downloaded + re-stored as attachments.
 */
export function extractImageRefs(body: string | null | undefined): string[] {
  if (body == null || body === '') return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const url = m[1].trim();
      if (!/^https?:\/\//i.test(url)) continue; // skip data: / relative
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  };
  collect(IMG_TAG_RE);
  collect(MD_IMG_RE);
  return urls;
}
