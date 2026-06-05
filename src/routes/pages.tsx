import { Hono } from 'hono';

import { ANNOUNCER_MODELS } from '../announcer/models.js';
import { Layout } from '../components/layout.js';
import { isDemoMode } from '../demo-mode.js';
import { PLUGINS_ENABLED } from '../feature-flags.js';
import type { AppEnv } from '../types.js';

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/', (c) => {
  const html = (
    <Layout title="Hot Sheet" demoMode={isDemoMode()}>
      <div className="app">
        <header className="app-header">
          <button className="terminal-dashboard-toggle" id="terminal-dashboard-toggle" title="Terminal dashboard" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
          </button>
          {/* HS-8507 / §70.2 — Cross-project stats header button. Lucide
              `line-chart` glyph (mirrors the drawer Telemetry tab + the
              legacy sidebar Telemetry entry icons). Visibility is gated
              by `refreshTelemetrySidebarVisibility` in
              `telemetrySidebar.tsx`, which queries
              `GET /api/telemetry/enabled-anywhere` and toggles
              `display`. Click handler in the same module routes to
              `showCrossProjectStatsPage`. */}
          <button className="cross-project-stats-toggle" id="cross-project-stats-toggle" title="Cross-project stats" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          </button>
          <div className="app-title" id="app-title-area">
            <h1>Hot Sheet</h1>
          </div>
          {/* HS-7832 — the leading icon was visual noise; the slider thumb
              + native range affordance carry the meaning on their own. */}
          <div className="terminal-dashboard-sizer" id="terminal-dashboard-sizer" style="display:none" title="Tile size">
            {/* HS-8176 — integer slider, 1..10 with the spec's inverted
                visual mapping: leftmost = 10 columns (smallest tiles, most
                per row), rightmost = 1 column (one big tile filling the
                row). Slider value IS the LTR position; the JS converts to
                column count via `sliderPositionToPerRow` (`perRow = 11 -
                sliderPosition`). Default value 7 corresponds to perRow=4
                (the post-HS-8176 default). */}
            <input type="range" id="terminal-dashboard-size-slider" min="1" max="10" step="1" value="7" list="terminal-dashboard-size-ticks" aria-label="Dashboard tile columns" />
            <datalist id="terminal-dashboard-size-ticks">
              <option value="1"></option><option value="2"></option><option value="3"></option><option value="4"></option><option value="5"></option><option value="6"></option><option value="7"></option><option value="8"></option><option value="9"></option><option value="10"></option>
            </datalist>
          </div>
          {/* HS-7833 — Flow / Sectioned layout toggle for the dashboard,
              positioned RIGHT BEFORE the eye-icon hide button (was between
              the dashboard toggle and the slider). Lucide `text-wrap` icon.
              Active state mirrors `#terminal-dashboard-toggle`. */}
          <button type="button" className="terminal-dashboard-layout-toggle" id="terminal-dashboard-layout-toggle" title="Toggle flow layout" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/></svg>
          </button>
          {/* HS-7661 — Show / Hide Terminals dialog opener for the global
              dashboard. Sits to the right of the size slider + flow toggle
              (the toggle was moved here in HS-7833). Visibility tracks
              #terminal-dashboard-sizer; hidden when the dashboard isn't
              active or while in dedicated view. */}
          <button type="button" className="terminal-dashboard-hide-btn" id="terminal-dashboard-hide-btn" title="Show / hide terminals" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          {/* HS-7826 — visibility-grouping selector. Hidden when the project
              has only the Default grouping; populated by the dashboard
              module when groupings change. */}
          <select id="terminal-dashboard-grouping-select" className="terminal-dashboard-grouping-select" title="Visibility grouping" style="display:none"></select>
          <div className="header-controls">
            <div className="search-box">
              <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input type="text" id="search-input" placeholder="Search tickets..." />
              {/* HS-7360 — lucide circle-x clear button. Hidden by default via
                  the parent `.search-box` not having `.has-value`; revealed as
                  soon as the input has a query so the user can one-click-clear
                  instead of backspacing the whole string. */}
              <button type="button" className="search-clear-btn" title="Clear search" aria-label="Clear search">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
              </button>
            </div>
            <div className="layout-toggle" id="layout-toggle">
              <button className="layout-btn active" data-layout="list" title="List view"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
              <button className="layout-btn" data-layout="columns" title="Column view"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg></button>
            </div>
            <div className="sort-controls">
              <select id="sort-select">
                <option value="created:desc">Newest First</option>
                <option value="created:asc">Oldest First</option>
                <option value="modified:desc">Recently Modified</option>
                <option value="priority:asc">Priority</option>
                <option value="category:asc">Category</option>
                <option value="status:asc">Status</option>
              </select>
            </div>
            <div className="layout-toggle" id="detail-position-toggle">
              <button className="layout-btn" data-position="bottom" title="Detail panel on bottom"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg></button>
              <button className="layout-btn active" data-position="side" title="Detail panel on side"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg></button>
            </div>
            <button className="glassbox-btn" id="glassbox-btn" title="Open Glassbox" style="display:none"><img id="glassbox-icon" alt="Glassbox" /></button>
            {/* HS-8747 / §78 — Announcer "Listen" button. Hidden until the
                project opts in AND has an API key (refreshAnnouncerVisibility
                in announcer.tsx queries /api/announcer/status). Click →
                generate + play the reel through the transcript PIP. Lucide
                `audio-lines` glyph. */}
            <button className="settings-btn announcer-listen-btn" id="announcer-listen-btn" title="Listen to recent work" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg></button>
            <button className="settings-btn print-btn" id="print-btn" title="Print"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg></button>
            <button className="settings-btn" id="settings-btn" title="Project Settings"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </header>

        <div id="backup-preview-banner" className="backup-preview-banner" style="display:none">
          <span id="backup-preview-label">Previewing backup...</span>
          <div className="backup-preview-actions">
            <button id="backup-restore-btn" className="btn btn-sm btn-danger">Restore This Backup</button>
            <button id="backup-cancel-btn" className="btn btn-sm">Cancel Preview</button>
          </div>
        </div>

        <div id="db-recovery-banner" className="db-recovery-banner" style="display:none">
          <span id="db-recovery-banner-label">Database recovery occurred.</span>
          <div className="db-recovery-banner-actions">
            <button id="db-recovery-restore-btn" className="btn btn-sm btn-accent">Restore from backup…</button>
            <button id="db-recovery-dismiss-btn" className="btn btn-sm">Dismiss</button>
          </div>
        </div>

        <div id="skills-banner" className="skills-banner" style="display:none">
          <span>AI tool skills created. Restart your AI tool to use the new ticket creation skills (hs-bug, hs-feature, etc.).</span>
          <button id="skills-banner-dismiss" className="btn btn-sm">Dismiss</button>
        </div>

        <div id="update-banner" className="update-banner" style="display:none">
          <span id="update-banner-label">Update available</span>
          <div className="update-banner-actions">
            <button id="update-install-btn" className="btn btn-sm btn-accent">Install Update</button>
            <button id="update-banner-dismiss" className="btn btn-sm">Later</button>
          </div>
        </div>

        {/* HS-8226 — server-slow banner (replaces the HS-8175 corner chip).
            Mirrors the `.update-banner` layout-flow strip (`flex-shrink: 0`)
            but in amber + non-dismissable: lights up whenever any non-long-poll
            HTTP request has been in flight longer than the threshold. The chip
            is auto-shown / auto-hidden by `serverBusyChip.tsx`. */}
        <div id="server-slow-banner" className="server-slow-banner" style="display:none">
          <span className="server-slow-dot"></span>
          <span className="server-slow-label">Server slow — your request is still in flight</span>
        </div>

        <div id="share-banner" className="share-banner" style="display:none">
          <span>Enjoying Hot Sheet? Share it with others!</span>
          <div className="share-banner-actions">
            <button id="share-banner-share" className="btn btn-sm btn-share">Share</button>
            <button id="share-banner-dismiss" className="btn btn-sm">Not now</button>
          </div>
        </div>

        <div className="app-body">
          <nav className="sidebar">
            <div className="channel-disconnected-warning" id="channel-disconnected" style="display:none">Claude not connected</div>
            <div className="channel-version-warning" id="channel-version-warning" style="display:none">Channel outdated — run <code>/mcp</code> in Claude Code to reconnect</div>
            {/* HS-8460 — multi-connection warning. Shown when more than
                one channel-server is alive for this dataDir (each Claude
                Code instance spawns its own MCP child). Triggers route
                to the oldest connection by `startedAt`; when it
                disconnects, the next-oldest takes over within ~5 s. */}
            <div className="channel-multi-warning" id="channel-multi-warning" style="display:none"></div>
            {/* HS-7954 — git status chip. Hidden by default; populated +
                shown by `gitStatusChip.tsx` once the first /api/git/status
                resolves to a non-null GitStatus. HS-7975 — moved ABOVE the
                play button, restyled to a borderless full-width row with
                the count right-aligned and a hover highlight. */}
            <div id="sidebar-git-chip" className="sidebar-git-chip" style="display:none">
              <span className="sidebar-git-icon"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/></svg></span>
              <span className="sidebar-git-branch"></span>
              <span className="sidebar-git-counts"></span>
            </div>
            <div className="sidebar-channel-play" id="channel-play-section" style="display:none">
              <button className="channel-play-btn" id="channel-play-btn" title="Run worklist (double-click for auto mode)">
                <span className="channel-play-icon" id="channel-play-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
                <span className="channel-auto-icon" id="channel-auto-icon" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"/><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"/></svg></span>
              </button>
            </div>
            <div id="channel-commands-container"></div>
            {PLUGINS_ENABLED ? <div id="plugin-sidebar-top" className="plugin-sidebar-actions"></div> : null}
            {/* HS-8528 — "Copy AI prompt" sidebar button removed.
                AI tools consume the worklist via the `hotsheet_*` MCP
                tools / `.hotsheet/worklist.md` directly, so the
                one-shot copy-to-clipboard surface is no longer
                necessary. The skill-creation banner trigger that
                previously rode on the same endpoint fetch was
                preserved — moved to `initSkillsBanner` in
                `clipboardUtil.tsx`. */}
            <div className="sidebar-section">
              <div className="sidebar-label">Views <button className="sidebar-add-view-btn" id="add-custom-view-btn" title="New custom view"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/></svg></button></div>
              <button className="sidebar-item active" data-view="all"><span className="sidebar-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg></span> All Tickets</button>
              <button className="sidebar-item" data-view="non-verified"><span className="sidebar-icon">{'\u25D4'}</span> Non-Verified</button>
              <button className="sidebar-item" data-view="up-next"><span className="sidebar-icon">{'\u2605'}</span> Up Next</button>
              <button className="sidebar-item" data-view="open"><span className="sidebar-icon">{'\u25CB'}</span> Open</button>
              <button className="sidebar-item" data-view="completed"><span className="sidebar-icon">{'\u2713'}</span> Completed</button>
              <button className="sidebar-item" data-view="verified"><span className="sidebar-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg></span> Verified</button>
              <div id="custom-views-container"></div>
              <div className="sidebar-divider"></div>
              <button className="sidebar-item" data-view="backlog"><span className="sidebar-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span> Backlog</button>
              <button className="sidebar-item" data-view="archive"><span className="sidebar-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg></span> Archive</button>
              <button className="sidebar-item" data-view="trash"><span className="sidebar-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></span> Trash</button>
            </div>
            <div className="sidebar-section" id="sidebar-categories">
              <div className="sidebar-label">Category</div>
              <button className="sidebar-item" data-view="category:issue">
                <span className="cat-dot" style="background:#6b7280"></span> Issue
              </button>
              <button className="sidebar-item" data-view="category:bug">
                <span className="cat-dot" style="background:#ef4444"></span> Bug
              </button>
              <button className="sidebar-item" data-view="category:feature">
                <span className="cat-dot" style="background:#22c55e"></span> Feature
              </button>
              <button className="sidebar-item" data-view="category:requirement_change">
                <span className="cat-dot" style="background:#f97316"></span> Req Change
              </button>
              <button className="sidebar-item" data-view="category:task">
                <span className="cat-dot" style="background:#3b82f6"></span> Task
              </button>
              <button className="sidebar-item" data-view="category:investigation">
                <span className="cat-dot" style="background:#8b5cf6"></span> Investigation
              </button>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-label">Priority</div>
              <button className="sidebar-item" data-view="priority:highest"><span className="sidebar-icon" style="color:#ef4444"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 11 5-5 5 5"/><path d="m7 17 5-5 5 5"/></svg></span> Highest</button>
              <button className="sidebar-item" data-view="priority:high"><span className="sidebar-icon" style="color:#f97316"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg></span> High</button>
              <button className="sidebar-item" data-view="priority:default"><span className="sidebar-icon" style="color:#6b7280"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg></span> Default</button>
              <button className="sidebar-item" data-view="priority:low"><span className="sidebar-icon" style="color:#3b82f6"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></span> Low</button>
              <button className="sidebar-item" data-view="priority:lowest"><span className="sidebar-icon" style="color:#94a3b8"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 7 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg></span> Lowest</button>
            </div>
            {PLUGINS_ENABLED ? <div id="plugin-sidebar-bottom" className="plugin-sidebar-actions"></div> : null}
            <div className="sidebar-stats" id="stats-bar"></div>
          </nav>

          <div className="content-area detail-side" id="content-area">
            <main className="main-content">
              {/* HS-7756 — gray rows ("Include {N} backlog items" /
                  "Include {N} archive items") rendered between the
                  multi-select toolbar and the ticket list when a search
                  is active and there are matches in the buckets the
                  active view normally hides. Populated by ticketList.tsx
                  via `renderSearchExtraRows`. */}
              <div className="search-extra-rows" id="search-extra-rows"></div>
              <div className="batch-toolbar" id="batch-toolbar">
                <input type="checkbox" id="batch-select-all" className="batch-select-all" title="Select all / none" />
                <button id="batch-category" className="btn btn-sm batch-dropdown-btn" title="Set category" disabled>Category</button>
                <button id="batch-priority" className="btn btn-sm batch-dropdown-btn" title="Set priority" disabled>Priority</button>
                <button id="batch-status" className="btn btn-sm batch-dropdown-btn" title="Set status" disabled>Status</button>
                <button id="batch-upnext" className="batch-star-btn" title="Toggle Up Next" disabled><span className="batch-star-icon">{'\u2606'}</span></button>
                <button id="batch-delete" className="btn btn-sm btn-danger batch-delete-btn" title="Delete selected" disabled><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
                <button id="batch-more" className="btn btn-sm batch-more-btn" title="More actions" disabled><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg></button>
                <span className="batch-count" id="batch-count"></span>
              </div>

              <div className="ticket-list" id="ticket-list">
                <div className="ticket-list-loading">Loading...</div>
              </div>
            </main>

            <div className="detail-resize-handle" id="detail-resize-handle"></div>

            <aside className="detail-panel detail-disabled" id="detail-panel">
              <div className="detail-placeholder" id="detail-placeholder">
                <span className="detail-placeholder-text" id="detail-placeholder-text">Nothing selected</span>
              </div>
              <div className="detail-header" id="detail-header" style="display:none">
                <span className="detail-ticket-number" id="detail-ticket-number"></span>
                <button className="detail-close" id="detail-close" title="Close">{'\u00d7'}</button>
              </div>
              <div className="detail-body" id="detail-body" style="display:none">
                <div className="plugin-detail-top" id="plugin-detail-top"></div>
                <div className="detail-fields-row">
                  <div className="detail-field">
                    <label>Category</label>
                    <button id="detail-category" className="detail-dropdown-btn" data-value="issue">Issue</button>
                  </div>
                  <div className="detail-field">
                    <label>Priority</label>
                    <button id="detail-priority" className="detail-dropdown-btn" data-value="default">Default</button>
                  </div>
                  <div className="detail-field">
                    <label>Status</label>
                    <button id="detail-status" className="detail-dropdown-btn" data-value="not_started">Not Started</button>
                  </div>
                  <div className="detail-field">
                    <label>Up Next</label>
                    <button className="ticket-star detail-upnext-star" id="detail-upnext" type="button">{'\u2606'}</button>
                  </div>
                </div>
                <div className="detail-field detail-field-full">
                  <label>Title</label>
                  <input type="text" id="detail-title" spellCheck="true" />
                </div>
                <div className="detail-field detail-field-full">
                  {/* HS-7957 — Details label is a flex row so the right-side
                      reader-mode book button sits opposite the label text.
                      The button is disabled (greyed) when the textarea is
                      empty; bound in `bindDetailReaderButton` in
                      `src/client/detail.tsx`. */}
                  <label className="detail-details-label">
                    <span>Details</span>
                    <button id="detail-reader-btn" className="detail-reader-btn" type="button" title="Open in reader mode" disabled>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 8h2"/><path d="M6 12h2"/></svg>
                    </button>
                  </label>
                  {/* HS-8020 — when the user isn't editing, show a markdown-
                      rendered view of the details (mirrors how notes already
                      render). The two siblings sit on top of each other in
                      DOM order; CSS shows one based on the parent
                      `.detail-details-wrap.is-editing` class, which the
                      detail.tsx click+blur handlers toggle. Empty rendered
                      view falls through to a `:empty::before` placeholder
                      so a brand-new ticket still reads as click-to-edit. */}
                  <div className="detail-details-wrap">
                    <div id="detail-details-rendered" className="detail-details-rendered note-markdown" tabIndex={0}></div>
                    <textarea id="detail-details" rows={6} placeholder="Add details..." spellCheck="true"></textarea>
                  </div>
                </div>
                <div className="detail-field detail-field-full">
                  <label>Tags</label>
                  <div id="detail-tags" className="detail-tags"></div>
                  <input type="text" id="detail-tag-input" className="detail-tag-input" placeholder="Add tag..." />
                </div>
                <div className="detail-field detail-field-full">
                  <label>Attachments</label>
                  <div id="detail-attachments" className="detail-attachments"></div>
                  <label className="btn btn-sm upload-btn">
                    Attach File
                    <input type="file" id="detail-file-input" style="display:none" multiple />
                  </label>
                </div>
                {/* HS-8152 / HS-8648 — per-ticket Claude usage stats block (§67.10.7), positioned just above Notes. Populated by `loadAndRenderTicketTelemetry` from `src/client/ticketTelemetryStats.tsx` when the ticket has attributed prompts; `.detail-telemetry-stats:empty` collapses it to zero height otherwise. */}
                <div className="detail-telemetry-stats detail-field-full" id="detail-telemetry-stats"></div>
                <div className="detail-field detail-field-full" id="detail-notes-section">
                  <div className="detail-notes-label"><span>Notes</span> <button className="sidebar-add-view-btn" id="detail-add-note-btn" title="Add note"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button></div>
                  <div id="detail-notes" className="detail-notes"></div>
                </div>
                <div className="detail-meta detail-field-full" id="detail-meta"></div>
                <div className="plugin-detail-bottom" id="plugin-detail-bottom"></div>
              </div>
            </aside>
          </div>
        </div>

        <div id="terminal-dashboard-root" className="terminal-dashboard" style="display:none"></div>

        {/* HS-8524 — dedicated root for the cross-project stats page so
            it renders as a full-window surface (matching the terminal
            dashboard's takeover pattern) rather than as a subview that
            took over `#ticket-list` → `#dashboard-container`. Ticket-
            view controls + sidebar + content-area get hidden via
            `body.cross-project-stats-active`; the page's own internal
            toolbar (window selector, cost-over-time mode toggle) lives
            inside this root. Hidden via inline `display:none` at
            server-render time; `crossProjectStatsPage.tsx` reveals it
            on entry. */}
        <div id="cross-project-stats-root" className="cross-project-stats-root" style="display:none"></div>

        <div id="command-log-panel" className="command-log-panel" style="display:none">
          <div className="command-log-resize-handle" id="command-log-resize"></div>
          <div className="drawer-tabs">
            <button className="drawer-tab drawer-tab-icon active" data-drawer-tab="commands-log" id="drawer-tab-commands-log" title="Commands Log" aria-label="Commands Log">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>
            </button>
            <span className="drawer-tabs-divider" aria-hidden="true" style="display:none"></span>
            <div className="drawer-terminal-tabs-wrap" id="drawer-terminal-tabs-wrap" style="display:none">
              <div className="drawer-terminal-tabs-scroll">
                <div className="drawer-terminal-tabs" id="drawer-terminal-tabs"></div>
                <button className="drawer-tab drawer-tab-add" id="drawer-add-terminal-btn" title="New terminal (default shell)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                </button>
              </div>
            </div>
            <div className="drawer-tabs-end">
              {/* HS-6311 — tile-size slider for the drawer terminal grid view
                  (§36). Hidden unless grid mode is active; visibility toggled
                  by drawerTerminalGrid.tsx in lockstep with the grid. */}
              {/* HS-7832 — leading icon removed for visual quiet. */}
              <div className="drawer-grid-sizer" id="drawer-grid-sizer" style="display:none" title="Tile size">
                {/* HS-8176 — see the dashboard size-slider comment above
                    for the rationale. Same shape: integer 1..10, default 7
                    (= perRow 4). */}
                <input type="range" id="drawer-grid-size-slider" min="1" max="10" step="1" value="7" list="drawer-grid-size-ticks" aria-label="Grid tile columns" />
                <datalist id="drawer-grid-size-ticks">
                  <option value="1"></option><option value="2"></option><option value="3"></option><option value="4"></option><option value="5"></option><option value="6"></option><option value="7"></option><option value="8"></option><option value="9"></option><option value="10"></option>
                </datalist>
              </div>
              {/* HS-7661 — Show / Hide Terminals dialog opener for the
                  drawer-grid view. Visible only while drawer-grid mode is
                  active (toggled by drawerTerminalGrid.tsx alongside the
                  sizer). Sits to the right of the slider per the user's
                  feedback ("near the slider yes, probably to the right of it"). */}
              <button type="button" className="drawer-grid-hide-btn" id="drawer-grid-hide-btn" title="Show / hide terminals" style="display:none">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              {/* HS-7826 — drawer-grid visibility-grouping selector. Hidden
                  when the project has only the Default grouping. */}
              <select id="drawer-grid-grouping-select" className="drawer-grid-grouping-select" title="Visibility grouping" style="display:none"></select>
              {/* HS-6311 — toggle between drawer tabs and a grid view of every
                  terminal in the current project. Hidden in plain browsers
                  (Tauri-only per §36.8), disabled when ≤1 terminal exists.
                  Uses Lucide `layout-grid`. */}
              <button className="drawer-grid-toggle" id="drawer-grid-toggle" title="Terminal grid view (disabled: add a second terminal to enable)" style="display:none" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
              </button>
              <button className="drawer-expand-btn" id="drawer-expand-btn" title="Expand drawer to full height">
                <svg className="drawer-expand-icon-up" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3h16"/><path d="M12 21V7"/><path d="m6 13 6-6 6 6"/></svg>
                <svg className="drawer-expand-icon-down" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style="display:none"><path d="M4 21h16"/><path d="M12 3v14"/><path d="m6 11 6 6 6-6"/></svg>
              </button>
            </div>
          </div>
          <div className="drawer-tab-content" data-drawer-panel="commands-log" id="drawer-panel-commands-log">
            <div className="command-log-header">
              <div className="command-log-search-box">
                <svg className="command-log-search-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input type="text" id="command-log-search" placeholder="Search..." className="command-log-search" />
              </div>
              <button id="command-log-filter-btn" className="command-log-filter-btn" title="Filter by type">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                <span>All types</span>
              </button>
              <button id="command-log-clear" className="command-log-clear-btn" title="Clear log"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>
            <div id="command-log-entries" className="command-log-entries"></div>
          </div>
          <div id="drawer-terminal-panes" className="drawer-terminal-panes"></div>
          {/* HS-6311 — terminal grid view container. Hidden until the user
              toggles grid mode on via the drawer toolbar's #drawer-grid-toggle.
              Tiles are mounted by drawerTerminalGrid.tsx on each enter. See
              docs/36-drawer-terminal-grid.md. */}
          <div id="drawer-terminal-grid" className="drawer-terminal-grid" style="display:none"></div>
        </div>

        <footer className="app-footer">
          <div className="footer-left">
            {/* HS-8530 — Sponsor link, lucide `heart` icon. Opens
                https://github.com/sponsors/brianwestphal in a new tab
                via `openExternalUrl` (Tauri-safe; see CLAUDE.md
                "Tauri-unsafe browser APIs" — `window.open` no-ops in
                WKWebView). Sits to the left of the Share link with a
                comfortable gap between them. */}
            <a href="https://github.com/sponsors/brianwestphal" target="_blank" rel="noopener noreferrer" id="sponsor-link" className="sponsor-link" title="Support Hot Sheet">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
              <span>Sponsor</span>
            </a>
            <a href="#" id="share-link" className="share-link">Know someone who'd love this? Share Hot Sheet</a>
          </div>
          <div className="status-bar-right">
            <div id="status-bar" className="status-bar"></div>
            {PLUGINS_ENABLED ? <span id="plugin-busy-indicator" className="plugin-busy-indicator" style="display:none"></span> : null}
            {PLUGINS_ENABLED ? <span id="plugin-status-bar" className="plugin-status-bar"></span> : null}
            <span id="channel-status-indicator" className="channel-status-indicator" style="display:none"></span>
            <button id="command-log-btn" className="command-log-btn" title="Commands Log">
              <svg className="icon-open" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="m9 10 3-3 3 3"/></svg>
              <svg className="icon-close" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="m15 8-3 3-3-3"/></svg>
              <span id="command-log-badge" className="command-log-badge" style="display:none"></span>
            </button>
          </div>
        </footer>
      </div>

      <div className="settings-overlay" id="settings-overlay" style="display:none">
        <div className="settings-dialog">
          <div className="settings-header">
            <h2 id="settings-dialog-title">Settings</h2>
            <button className="detail-close" id="settings-close">{'\u00d7'}</button>
          </div>
          <div className="settings-tabs" id="settings-tabs">
            <button className="settings-tab active" data-tab="general">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>
              <span>General</span>
            </button>
            <button className="settings-tab" data-tab="categories">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>
              <span>Categories</span>
            </button>
            <button className="settings-tab" data-tab="backups">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>
              <span>Backups</span>
            </button>
            <button className="settings-tab" data-tab="context">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>
              <span>Context</span>
            </button>
            {PLUGINS_ENABLED ? <button className="settings-tab" data-tab="plugins" id="settings-tab-plugins">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>
              <span>Plugins</span>
            </button> : null}
            <button className="settings-tab" data-tab="terminal" id="settings-tab-terminal" style="display:none">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
              <span>Terminal</span>
            </button>
            <button className="settings-tab" data-tab="permissions" id="settings-tab-permissions">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>Permissions</span>
            </button>
            {/* HS-8751 — API Keys tab. Machine-global named-secret registry
                (Anthropic API keys) that projects select from. */}
            <button className="settings-tab" data-tab="keys" id="settings-tab-keys">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>
              <span>API Keys</span>
            </button>
            {/* HS-8146 — Telemetry tab. Master toggle + per-signal sub-toggles + retention picker for the §67 Claude Code telemetry integration. */}
            <button className="settings-tab" data-tab="telemetry" id="settings-tab-telemetry">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
              <span>Telemetry</span>
            </button>
            <button className="settings-tab" data-tab="experimental" id="settings-tab-experimental">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>
              <span>Experimental</span>
            </button>
            <button className="settings-tab" data-tab="updates" id="settings-tab-updates" style="display:none">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
              <span>Updates</span>
            </button>
          </div>
          <div className="settings-body">
            <div className="settings-tab-panel active" data-panel="general">
              <div className="settings-field">
                <label>Project name</label>
                <div className="settings-app-name-row">
                  <button className="app-icon-picker-btn" id="app-icon-picker-btn" title="Change app icon" style="display:none">
                    <img id="app-icon-preview" src="/static/assets/icon-default.png" width="28" height="28" />
                  </button>
                  <input type="text" id="settings-app-name" placeholder="Hot Sheet" />
                </div>
                <span className="settings-hint" id="settings-app-name-hint">Custom name shown in the title bar and project tab. Leave empty for default.</span>
              </div>
              <div className="settings-field">
                <label>Ticket prefix</label>
                <input type="text" id="settings-ticket-prefix" placeholder="HS" maxLength={10} style="width: 120px" />
                <span className="settings-hint" id="settings-ticket-prefix-hint">Prefix for ticket numbers (e.g. HS-1). Alphanumeric, hyphens, underscores. Max 10 characters.</span>
              </div>
              <div className="settings-field">
                <label>Auto-delete trash after (days)</label>
                <input type="number" id="settings-trash-days" min="1" value="3" />
              </div>
              <div className="settings-field">
                <label>Auto-archive verified after (days)</label>
                <input type="number" id="settings-verified-days" min="1" value="30" />
              </div>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-auto-order" checked /> Auto-prioritize tickets</label>
                <span className="settings-hint">When no Up Next items exist, the AI will evaluate open tickets and choose what to work on next.</span>
              </div>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-hide-verified-column" /> Hide Verified column in column view</label>
                <span className="settings-hint">Hides the Verified column in column view. Verified tickets will appear in the Completed column instead.</span>
              </div>
              {/* HS-8022 — removed the HS-7992 "Clear context on each
                  /hotsheet" checkbox. Skill bodies are loaded as Skill tool
                  output, not typed at the REPL prompt, so the `/clear`
                  prefix it injected was a no-op. Users who want a fresh
                  context per /hotsheet should type `/clear` themselves
                  before invoking the skill. */}
              <div className="settings-field">
                <label>When Claude needs permission</label>
                <select id="settings-notify-permission">
                  <option value="none">Don't notify</option>
                  <option value="once">Notify once</option>
                  <option value="persistent" selected>Notify until focused</option>
                </select>
              </div>
              <div className="settings-field">
                <label>When Claude finishes work</label>
                <select id="settings-notify-completed">
                  <option value="none">Don't notify</option>
                  <option value="once" selected>Notify once</option>
                  <option value="persistent">Notify until focused</option>
                </select>
              </div>
              <div id="cli-tool-section" style="display:none">
                <div className="settings-divider"></div>
                <div className="settings-field">
                  <label>CLI Tool <span className="global-setting-badge">Global Setting</span></label>
                  <div className="cli-status-row">
                    <span className="cli-status-dot" id="cli-status-dot"></span>
                    <span id="cli-status-text">Checking...</span>
                    <button className="btn btn-sm" id="cli-install-btn" style="display:none">Install CLI</button>
                  </div>
                  <span className="settings-hint" id="cli-install-hint">Installs the <code>hotsheet</code> command to /usr/local/bin.</span>
                </div>
              </div>
              {/* HS-8488 — terminal renderer opt-out. Hidden by default;
                  `bindGeneralTab` reveals it only when WebGL2 is available in
                  this browser (no point showing an inert toggle where the
                  renderer can't be used). */}
              <div id="terminal-webgl-section" style="display:none">
                <div className="settings-divider"></div>
                <div className="settings-field settings-field-checkbox">
                  <label><input type="checkbox" id="settings-terminal-webgl-opt-out" /> Use software rendering for terminals <span className="global-setting-badge">Global Setting</span></label>
                  <span className="settings-hint">Hot Sheet uses your GPU to render terminals for smoother output during heavy activity (long <code>claude</code> sessions, full-screen TUIs like <code>top</code>, fast log spam). Tick this if you see graphical glitches, dropped characters, or excessive battery use — Hot Sheet will fall back to slower CPU rendering. Takes effect on terminals you open afterward. Demo mode always uses CPU rendering regardless of this setting.</span>
                </div>
              </div>
            </div>
            <div className="settings-tab-panel" data-panel="categories">
              <div className="settings-section-header">
                <h3>Categories</h3>
                <div className="category-preset-controls">
                  <select id="category-preset-select" className="btn btn-sm">
                    <option value="">Load preset...</option>
                  </select>
                </div>
              </div>
              <div id="category-list" className="category-list"></div>
              <button id="category-add-btn" className="btn btn-sm" style="margin-top:8px">Add Category</button>
            </div>
            <div className="settings-tab-panel" data-panel="backups">
              <div className="settings-section-header">
                <h3>Database Backups</h3>
                <button className="btn btn-sm" id="backup-now-btn">Backup Now</button>
              </div>
              <div className="settings-field">
                <label>Backup storage location</label>
                <input type="text" id="settings-backup-dir" placeholder="Default: .hotsheet/backups" />
                <span className="settings-hint" id="settings-backup-dir-hint">Leave empty to use the default location inside the data directory.</span>
              </div>
              <div id="backup-list" className="backup-list">Loading backups...</div>
              {/* HS-8594 — Snapshot Protection subsection (docs/73-snapshot-protection.md §73.6).
                  Toggle is bound to the `db_snapshot_protection` file-setting (default on);
                  the status line is fed by GET /api/db/snapshot-status. */}
              <div className="settings-section-header" style="margin-top:24px">
                <h3>Snapshot protection</h3>
              </div>
              <p className="settings-hint">Keeps one atomically-written snapshot of this project's database and auto-restores it on startup if the live database is found corrupt. The snapshot is refreshed shortly after each change, on a periodic safety timer, and on a clean shutdown.</p>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-snapshot-protection" /> Protect this project's database with snapshots</label>
                <span className="settings-hint" id="settings-snapshot-status">Checking snapshot status…</span>
              </div>
              <div className="settings-section-header" style="margin-top:24px">
                <h3>Database Repair</h3>
              </div>
              <div id="db-repair-status" className="db-repair-status">Checking database health…</div>
              <div className="db-repair-actions">
                <button className="btn btn-sm" id="db-repair-find-working-btn">Find a working backup</button>
                <button className="btn btn-sm" id="db-repair-pg-resetwal-btn">Run pg_resetwal…</button>
              </div>
              <div id="db-repair-result" className="db-repair-result"></div>
            </div>
            <div className="settings-tab-panel" data-panel="context">
              <div className="settings-section-header">
                <h3>Auto-Context</h3>
                <button className="btn btn-sm" id="auto-context-add-btn">+ Add</button>
              </div>
              <span className="settings-hint" style="margin-bottom:12px;display:block">Automatically prepend instructions to ticket details in the worklist, based on category or tag. Category context appears first, then tag context in alphabetical order.</span>
              <div id="auto-context-list"></div>
            </div>
            {PLUGINS_ENABLED ? <div className="settings-tab-panel" data-panel="plugins" id="settings-plugins-panel">
              <div className="settings-section-header" style="margin-bottom:12px">
                <h3>Installed Plugins</h3>
                <button className="btn btn-sm" id="plugin-install-btn">Find Plugins...</button>
              </div>
              <div id="plugin-list" className="plugin-list">
                <div style="padding:12px 0;color:var(--text-muted);font-size:13px">No plugins installed. Place plugins in <code>~/.hotsheet/plugins/</code> and restart.</div>
              </div>
              <div id="plugin-conflicts-section" style="display:none">
                <div className="settings-section-header" style="margin-top:16px">
                  <h3>Sync Conflicts <span className="plugin-conflict-badge" id="plugin-conflict-count"></span></h3>
                </div>
                <div id="plugin-conflict-list"></div>
              </div>
            </div> : null}
            {/* HS-7953 — Permission allow-list management. Lists configured
                rules; +Add inline form; per-row delete. Populated by
                `permissionAllowListUI.tsx::loadAndRenderAllowList`. */}
            <div className="settings-tab-panel" data-panel="permissions" id="settings-permissions-panel">
              <div className="settings-section-header">
                <h3>Auto-allow rules</h3>
              </div>
              <p className="settings-hint">Permission requests that match a rule below are auto-allowed without showing the popup. Patterns are JS regex anchored with <code>^…$</code> so <code>git status</code> matches <code>git status</code> exactly, not <code>cd /tmp &amp;&amp; git status</code>. Edit / Write requests are never allow-listable — file path alone doesn't capture diff intent.</p>
              {/* HS-8026 — the inline +Add form was replaced by an
                  "Add rule" button rendered inside the list (mirrors the
                  custom-command + terminal settings rows). The button
                  opens the same modal editor used by the per-row pencil
                  affordance, so add / edit share one validation path. */}
              <div id="permission-allow-list" className="permission-allow-list">Loading rules…</div>
            </div>
            {/* HS-8146 — §67 Claude Code Telemetry settings panel.
                Per-project file-settings: telemetry_enabled (master),
                telemetry_metrics_enabled / telemetry_logs_enabled /
                telemetry_traces_enabled (sub-toggles), and
                telemetry_retention_days (retention window). Default off
                so no spawn-env injection happens until the user opts
                in. See docs/67-telemetry.md §67.9 for the contract. */}
            {/* HS-8751 — API Keys panel. A machine-global list of named secrets
                (Anthropic API keys). Metadata lives in
                `~/.hotsheet/config.json`; values live in the OS keychain and are
                write-only here. Projects select a key by name (e.g. the
                Announcer). The list rows are rendered by keysSettings.tsx. */}
            <div className="settings-tab-panel" data-panel="keys" id="settings-keys-panel">
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>API Keys <span className="global-setting-badge" title="These keys are shared across every project on this machine.">Global Setting</span></h3>
                </div>
                <span className="settings-hint">Named API keys shared across every project on this machine. <strong>Values are stored in your OS keychain</strong> — never in the database, config file, or git. Each project picks a key by name (for example, the Announcer's Anthropic key under Experimental); with no choice it defaults to the first key of that type.</span>
                <div id="settings-keys-list" className="settings-keys-list" style="margin-top:12px"></div>
                {/* HS-8761 — "Add a key" opens a dialog (full-width Name + Value);
                    the row dialog code lives in keysSettings.tsx. */}
                <div className="settings-field" style="margin-top:14px">
                  <button type="button" className="btn btn-sm" id="settings-key-add-btn">Add a key…</button>
                </div>
                <span className="settings-hint" id="settings-keys-status" role="status" aria-live="polite"></span>
              </div>
            </div>
            <div className="settings-tab-panel" data-panel="telemetry" id="settings-telemetry-panel">
              <div className="settings-section-header">
                <h3>Claude Code Telemetry</h3>
              </div>
              <p className="settings-hint">When enabled, Claude Code processes running inside Hot Sheet terminals export <a href="https://opentelemetry.io/" target="_blank" rel="noopener">OpenTelemetry</a> metrics + logs (+ optional traces) to a local receiver. Data stays on this machine. <a href="https://code.claude.com/docs/en/monitoring-usage.md" target="_blank" rel="noopener">Learn more</a>.</p>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-telemetry-enabled" /> Enable telemetry for this project</label>
                <span className="settings-hint">When off, no telemetry env vars are injected when spawning terminals — Claude Code runs without exporters. Default off.</span>
              </div>
              <div className="settings-section-header">
                <h3>Signals to collect</h3>
              </div>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-telemetry-metrics-enabled" /> Metrics</label>
                <span className="settings-hint">Token usage, cost, lines of code, commit/PR counts, code-edit decisions, active time. Cadence: every 60 s.</span>
              </div>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-telemetry-logs-enabled" /> Logs &amp; events</label>
                <span className="settings-hint">User prompts, API requests/errors, tool decisions, tool results. Cadence: every 5 s. Needed for the per-prompt timeline drilldown.</span>
              </div>
              <div className="settings-field settings-field-checkbox">
                <label><input type="checkbox" id="settings-telemetry-traces-enabled" /> Traces <span className="settings-beta-chip" title="Claude Code's enhanced-tracing surface is upstream-beta and may change without notice.">BETA</span></label>
                <span className="settings-hint">Turn-level + sub-span detail for the Chrome-style waterfall view inside the per-prompt drilldown. Format may shift between Claude Code releases.</span>
              </div>
              {/* HS-8497 — billing model for cost display. Stored
                  globally in ~/.hotsheet/config.json under
                  `telemetryCostMode` because the user's billing
                  relationship with Anthropic is identity-level, not
                  per-project. When set to `subscription`, the cost
                  surfaces (per-tab chip, drawer, dashboard) hide or
                  annotate dollar amounts so a Claude Pro/Max user
                  doesn't see misleading "real cost" numbers for
                  consumption they don't pay per-token for. */}
              <div className="settings-section-header">
                <h3>Billing</h3>
              </div>
              <div className="settings-field">
                <label>Billing model <span className="global-setting-badge">Global Setting</span></label>
                <select id="settings-telemetry-cost-mode" style="width: 320px">
                  <option value="api">Pay-per-token API key (default)</option>
                  <option value="subscription">Claude Pro / Max subscription</option>
                </select>
                <span className="settings-hint">Claude Code's telemetry reports an "API-equivalent" cost regardless of how you're billed. When you're on a flat-fee subscription, the dollar amounts shown across Hot Sheet's telemetry surfaces don't reflect what you actually pay. Switching to "Subscription" hides the per-tab cost chip and surfaces a clarifying notice on the drawer + dashboard.</span>
              </div>
              <div className="settings-section-header">
                <h3>Retention</h3>
              </div>
              <div className="settings-field">
                <label>Keep raw rows for (days)</label>
                <input type="number" id="settings-telemetry-retention-days" min="0" value="30" style="width: 120px" />
                <span className="settings-hint">Older rows are deleted automatically on every Hot Sheet startup. Use <code>0</code> to keep forever.</span>
              </div>
              {/* HS-8606 / §74 — manually clear all of this project's telemetry. */}
              <div className="settings-field">
                <label>Clear telemetry data</label>
                <div className="settings-inline-row">
                  <button type="button" className="btn btn-sm btn-danger" id="settings-telemetry-clear-btn">Clear telemetry data…</button>
                  <span className="settings-status" id="settings-telemetry-clear-status" role="status" aria-live="polite"></span>
                </div>
                <span className="settings-hint">Permanently deletes every metric, event, and trace recorded for <strong>this project</strong> (all time). Other projects are unaffected. This cannot be undone.</span>
              </div>
            </div>
            <div className="settings-tab-panel" data-panel="experimental" id="settings-experimental-panel">
              <div className="settings-field">
                <label className="settings-checkbox-label">
                  <input type="checkbox" id="settings-channel-enabled" />
                  Enable Claude Channel integration <span className="global-setting-badge">Global Setting</span>
                </label>
                <span className="settings-hint" id="settings-channel-hint">Push worklist events to a running Claude Code session via MCP channels.</span>
                <div id="settings-channel-instructions" style="display:none">
                  <div className="settings-hint" style="margin-top:8px">Launch Claude Code with channel support:</div>
                  <div className="settings-channel-command">
                    <code id="settings-channel-cmd">claude --dangerously-load-development-channels server:hotsheet-channel-…</code>
                    <button className="btn btn-sm" id="settings-channel-copy-btn" title="Copy command">Copy</button>
                  </div>
                </div>
              </div>
              <div id="settings-custom-commands-section" style="display:none">
                <div className="settings-section" style="margin-top:16px">
                  <div className="settings-section-header">
                    <h3>Custom Commands</h3>
                  </div>
                  <span className="settings-hint">Custom buttons that trigger actions in Claude. They appear below the play button in the sidebar.</span>
                  <div id="settings-commands-list" className="settings-commands-list" style="margin-top:8px"></div>
                  {/* HS-7984 — per-project toggle for the §53 streaming
                      shell-output behavior. When off, the server still
                      buffers (cheap; no point in conditional buffering
                      complexity) but the client gates rendering, so the
                      sidebar preview stays hidden and the Commands Log
                      entry stays at the pre-completion empty state until
                      the final detail lands. Default true — see §53.8. */}
                  <div className="settings-field settings-field-checkbox" style="margin-top:12px">
                    <label><input type="checkbox" id="settings-shell-streaming-enabled" defaultChecked /> Stream shell command output as it arrives</label>
                    <span className="settings-hint">When on, the sidebar shows the trailing 1–2 lines of output under a running custom shell command's button, and the Commands Log entry updates in place as chunks arrive. Turn off if the live trickle is distracting.</span>
                  </div>
                </div>
              </div>
              {/* HS-8747 / §78 — Announcer. Per-project opt-in narration of
                  recent work. The enable toggle + a resolvable Anthropic key
                  both gate the header Listen button (announcer.tsx). HS-8751 —
                  the key is no longer entered here: it's chosen from the global
                  "API Keys" registry via the selector below (or defaults to the
                  first Anthropic key). */}
              <div className="settings-section" style="margin-top:16px">
                <div className="settings-section-header">
                  <h3>Announcer <span className="settings-beta-chip" title="The Announcer is an experimental, opt-in feature.">BETA</span></h3>
                </div>
                <span className="settings-hint">Narrates recent work in this project aloud — a spoken summary of completion notes and activity since you last listened. <strong>Privacy &amp; cost:</strong> enabling sends this project's notes + activity log to Anthropic using your own API key (a departure from Hot Sheet's local-only default). Code and ticket details are never sent — only the notes you and your AI tools already write.</span>
                <div className="settings-field settings-field-checkbox" style="margin-top:12px">
                  <label><input type="checkbox" id="settings-announcer-enabled" /> Enable the Announcer for this project</label>
                  <span className="settings-hint">When on, a “Listen” button appears in the header toolbar (once an API key is set).</span>
                </div>
                <div className="settings-field" style="margin-top:12px">
                  <label>Anthropic API key</label>
                  <select id="settings-announcer-key-select" style="max-width:340px">
                    <option value="">Default — first Anthropic key</option>
                  </select>
                  <span className="settings-hint" id="settings-announcer-status" role="status" aria-live="polite">Manage keys in the “API Keys” tab, then pick one here.</span>
                </div>
                {/* HS-8754 — global playback speed; also adjustable live from the PIP. */}
                <div className="settings-field" style="margin-top:12px">
                  <label>Playback speed <span className="global-setting-badge">Global Setting</span></label>
                  <select id="settings-announcer-rate" style="max-width:160px">
                    <option value="0.75">0.75×</option>
                    <option value="1">1× (normal)</option>
                    <option value="1.25">1.25×</option>
                    <option value="1.5">1.5×</option>
                    <option value="1.75">1.75×</option>
                    <option value="2">2×</option>
                  </select>
                  <span className="settings-hint">Speed of the spoken narration. Also adjustable from the player while listening.</span>
                </div>
                {/* HS-8764 — global summarization model; defaults to the cheapest (Haiku). */}
                <div className="settings-field" style="margin-top:12px">
                  <label>Summarization model <span className="global-setting-badge">Global Setting</span></label>
                  <select id="settings-announcer-model" style="max-width:340px">
                    {ANNOUNCER_MODELS.map(m => <option value={m.id}>{m.label}</option>)}
                  </select>
                  <span className="settings-hint">Which Anthropic model writes the narration. Cheaper models cost less per listen; the default (Haiku) is plenty for short summaries.</span>
                </div>
                {/* HS-8769 — "uninteresting" topics: skipping an entry adds its title here,
                    and future narration omits similar material. Editable. */}
                <div className="settings-field" style="margin-top:12px">
                  <label>Uninteresting topics</label>
                  <textarea id="settings-announcer-dismissed" rows={3} placeholder="One topic per line — the Announcer skips these" autoComplete="off" style="width:100%;box-sizing:border-box;font-size:13px"></textarea>
                  <span className="settings-hint">When you skip an entry, its title is added here, and future narration omits similar topics. Edit freely (one per line); blank lines are ignored.</span>
                </div>
              </div>
              {/* HS-8162 — Diagnostics subsection. HS-8446 collapsed the
                  former per-project UI-hang-toast toggle into a single
                  GLOBAL "Enable diagnostic UI surfaces" checkbox that
                  also gates the slow-server banner. The flag lives in
                  `~/.hotsheet/config.json` under `diagnosticsEnabled`
                  so it applies across every project on this machine.
                  Future diagnostic opt-ins (server-event-loop heartbeat
                  surfaces, etc.) can land here without a new tab.
                  HS-8450 — unified the "Global Setting" pill style with
                  the CLI / Claude-channel rows above; previously this
                  section rendered a gray uppercase chip via the now-
                  removed `.settings-scope-badge` class. */}
              <div className="settings-section" style="margin-top:16px">
                <div className="settings-section-header">
                  <h3>Diagnostics <span className="global-setting-badge" title="This setting applies to every project on this machine.">Global Setting</span></h3>
                </div>
                <div className="settings-field settings-field-checkbox">
                  <label><input type="checkbox" id="settings-diagnostics-enabled" /> Enable diagnostic UI surfaces (slow-server banner + UI-hang toast)</label>
                  <span className="settings-hint">When on, the slow-server banner (HS-8175 / HS-8226) surfaces when an HTTP request stays in flight past 3 s, and the HS-8054 longtask observer emits a small toast for each ≥ 500 ms UI hang (rate-limited to once every 10 s). Off by default — both surfaces are primarily useful when actively investigating event-loop blocks. Freezes are always logged to <code>&lt;dataDir&gt;/freeze.log</code> for diagnostics regardless of this setting.</span>
                </div>
              </div>
            </div>
            <div className="settings-tab-panel" data-panel="terminal" id="settings-terminal-panel">
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>Embedded Terminal</h3>
                </div>
                <span className="settings-hint">Terminal tabs appear alongside the Commands Log in the bottom drawer. Each terminal's PTY is spawned lazily on first open unless you mark it eager (see docs/22-terminal.md). This feature is desktop-only.</span>
                {/* HS-6307 — project-default appearance applied to every
                    terminal in this project. Per-terminal overrides (set via
                    the gear popover on the toolbar) win on a field-by-field
                    basis. See docs/35-terminal-themes.md §35.6. */}
                <div className="settings-terminal-default-appearance" style="margin-top:12px">
                  <div className="settings-terminal-default-title">Default appearance</div>
                  <div className="settings-terminal-default-row">
                    <label htmlFor="settings-terminal-default-theme">Theme</label>
                    <select id="settings-terminal-default-theme"></select>
                  </div>
                  <div className="settings-terminal-default-row">
                    <label htmlFor="settings-terminal-default-font">Font</label>
                    <select id="settings-terminal-default-font"></select>
                  </div>
                  <div className="settings-terminal-default-row">
                    <label htmlFor="settings-terminal-default-size">Font size</label>
                    <input type="number" id="settings-terminal-default-size" min="8" max="32" step="1" />
                  </div>
                </div>
                <div className="settings-field" style="margin-top:12px">
                  <label>Default terminals</label>
                  <span className="settings-hint" style="margin-bottom:6px;display:block">Each row is a tab in the drawer. Edit to change the name, command, working directory, or launch mode. Drag rows to reorder. Projects start with no terminals — add one to get a tab.</span>
                  <div id="settings-terminals-list" className="settings-terminals-list"></div>
                  <button id="settings-terminals-add-btn" className="btn btn-sm" style="margin-top:8px">Add Terminal</button>
                </div>
                {/* HS-7830 — Reset visibility affordance. Clears the persisted
                    `hidden_terminals` for this project so every configured
                    terminal shows up in the dashboard / drawer-grid again
                    without needing to open the Show / Hide Terminals dialog
                    (§25.10.6). See docs/38-terminal-visibility.md §38.7. */}
                <div className="settings-field" style="margin-top:12px">
                  <label>Hidden terminals</label>
                  <span className="settings-hint" style="margin-bottom:6px;display:block" id="settings-hidden-terminals-status">No terminals hidden for this project.</span>
                  <button type="button" id="settings-hidden-terminals-reset" className="btn btn-sm" disabled>Reset visibility</button>
                </div>
                <div className="settings-field">
                  <label htmlFor="settings-terminal-scrollback">Scrollback (bytes)</label>
                  <input type="number" id="settings-terminal-scrollback" min="65536" max="16777216" placeholder="1048576" />
                  <span className="settings-hint">Server-side ring buffer for reattach replay. 65 536–16 777 216 bytes. Takes effect on next terminal restart.</span>
                </div>
                <div className="settings-field">
                  <label><input type="checkbox" id="settings-shell-integration-ui" defaultChecked /> Enable shell integration UI</label>
                  <span className="settings-hint">Shows OSC 133 gutter glyphs, the copy-last-output toolbar button, and Cmd/Ctrl+Arrow prompt navigation when your shell emits shell-integration escapes (Starship, VS Code's shell-integration rc, iTerm2 integration, etc.). The parser still runs when this is off — re-enabling reveals the UI without losing history.</span>
                </div>
                {/* HS-7596 / §37 — Quit confirmation. Three modes + editable
                    exempt list of process basenames. See docs/37-quit-confirm.md. */}
                <div className="settings-field" style="margin-top:12px">
                  <label>Quit confirmation</label>
                  <span className="settings-hint" style="margin-bottom:6px;display:block">Prompts when you quit Hot Sheet (⌘Q / Alt+F4 / red traffic-light close / `hotsheet --close`) and any terminal in this project is running a process the user would care about.</span>
                  <div className="settings-quit-confirm-modes" id="settings-quit-confirm-modes">
                    <label><input type="radio" name="settings-quit-confirm-mode" value="always" /> Always</label>
                    <label><input type="radio" name="settings-quit-confirm-mode" value="never" /> Never</label>
                    <label><input type="radio" name="settings-quit-confirm-mode" value="with-non-exempt-processes" defaultChecked /> Only if there are processes other than the login shell and not in the exempt list:</label>
                  </div>
                  <textarea id="settings-quit-confirm-exempt" className="settings-textarea settings-quit-confirm-exempt" rows={6} placeholder={'screen\ntmux\nless\nmore\nview\nmandoc\ntail\nlog\ntop\nhtop'}></textarea>
                  {/* HS-8023 — text-link-styled reset that flows BELOW the textarea
                      (was an outlined `btn btn-sm` floating to the right of the
                      <textarea>'s natural inline-block layout). Wrapped in a
                      block <div> so it always lands on its own line, and the
                      `settings-link-action` class drops the border + uses the
                      muted secondary text color. */}
                  <div className="settings-quit-confirm-reset-row">
                    <button type="button" id="settings-quit-confirm-reset" className="settings-link-action">Reset exempt list to defaults</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-tab-panel" data-panel="updates" id="settings-updates-section" style="display:none">
              <div className="settings-section-header">
                <h3>Software Updates</h3>
                <button className="btn btn-sm" id="check-updates-btn">Check for Updates</button>
              </div>
              <div className="settings-hint" id="check-updates-status"></div>
            </div>
          </div>
        </div>
      </div>

      <div className="open-folder-overlay" id="open-folder-overlay" style="display:none">
        <div className="open-folder-dialog">
          <div className="open-folder-header">
            <h2>Open Folder</h2>
            <button className="open-folder-close" id="open-folder-close">{'\u00d7'}</button>
          </div>
          <div className="open-folder-breadcrumb" id="open-folder-breadcrumb"></div>
          <div className="open-folder-list" id="open-folder-list"></div>
          <div className="open-folder-footer">
            <span className="open-folder-path" id="open-folder-path"></span>
            <button className="open-folder-select" id="open-folder-select-btn">Open</button>
          </div>
        </div>
      </div>

    </Layout>
  );
  return c.html(html.toString());
});

