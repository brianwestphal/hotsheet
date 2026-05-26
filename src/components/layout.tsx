import { raw } from '../jsx-runtime.js';

export function Layout({ title, children, demoMode }: { title: string; children?: unknown; demoMode?: boolean }) {
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
        <script src="/static/app.js"></script>
      </body>
    </html>
  );
}
