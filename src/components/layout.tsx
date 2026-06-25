import { raw } from '../jsx-runtime.js';

export function Layout({ title, children, demoMode, scriptSrc }: { title: string; children?: unknown; demoMode?: boolean; scriptSrc?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/static/styles.css" />
        {/* HS-8612 — stamp the demo-mode flag synchronously, before `app.js`
            runs, so the terminal renderer decision (`shouldUseWebglRenderer`)
            sees it on the very first terminal mount. Same shape as the e2e
            `__HOTSHEET_DISABLE_WEBGL__` seam; both force the DOM renderer. */}
        {demoMode === true ? <script>{raw('window.__HOTSHEET_DEMO__=true;')}</script> : null}
      </head>
      <body>
        {children}
        {/* HS-9033 — a page can swap in its own entry bundle (e.g. the
            standalone `/pair` device-pairing surface loads `pair.js`, not the
            full app). Defaults to the main app bundle. */}
        <script src={scriptSrc ?? '/static/app.js'}></script>
      </body>
    </html>
  );
}
