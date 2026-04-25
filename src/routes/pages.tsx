import { Hono } from 'hono';

import { Layout } from '../components/layout.js';
import { PLUGINS_ENABLED } from '../feature-flags.js';
import type { AppEnv } from '../types.js';

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/', (c) => {
  const html = (
    <Layout title="Hot Sheet">
      <div className="app">
        <header className="app-header">
          <button className="terminal-dashboard-toggle" id="terminal-dashboard-toggle" title="Terminal dashboard" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
          </button>
          <div className="app-title" id="app-title-area">
            <h1>Hot Sheet</h1>
          </div>
          {/* HS-7662 — Flow / Sectioned layout toggle for the dashboard.
              Sits between the dashboard toggle and the size slider per the
              §25.10.5 spec. Lucide `text-wrap` icon. Active state mirrors
              `#terminal-dashboard-toggle`. Visibility tracks the sizer —
              hidden when dashboard isn't active and during dedicated view. */}
          <button type="button" className="terminal-dashboard-layout-toggle" id="terminal-dashboard-layout-toggle" title="Toggle flow layout" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/></svg>
          </button>
          <div className="terminal-dashboard-sizer" id="terminal-dashboard-sizer" style="display:none" title="Tile size">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M14 15H9v-5"/><path d="M16 3h5v5"/><path d="M21 3 9 15"/></svg>
            <input type="range" id="terminal-dashboard-size-slider" min="0" max="100" step="1" value="33" aria-label="Dashboard tile size" />
          </div>
          {/* HS-7661 — Show / Hide Terminals dialog opener for the global
              dashboard. Sits to the right of the size slider per the user's
              feedback ("near the slider yes, probably to the right of it").
              Visibility tracks #terminal-dashboard-sizer; hidden when the
              dashboard isn't active or while in dedicated view. */}
          <button type="button" className="terminal-dashboard-hide-btn" id="terminal-dashboard-hide-btn" title="Show / hide terminals" style="display:none">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          {/* HS-7331 — terminal dashboard search slot. Lives in the same header
              region as the sizer above, mutually exclusive: the sizer is visible
              in the grid view and the search slot is visible in the full-screen
              dedicated view. `terminalDashboard.tsx`'s `enterDedicatedView` /
              `exitDedicatedView` toggles the `display` property in lockstep with
              the sizer. */}
          <div className="terminal-dashboard-search-slot" id="terminal-dashboard-search-slot" style="display:none"></div>
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
            <div className="sidebar-channel-play" id="channel-play-section" style="display:none">
              <button className="channel-play-btn" id="channel-play-btn" title="Run worklist (double-click for auto mode)">
                <span className="channel-play-icon" id="channel-play-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
                <span className="channel-auto-icon" id="channel-auto-icon" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"/><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"/></svg></span>
              </button>
            </div>
            <div id="channel-commands-container"></div>
            {PLUGINS_ENABLED ? <div id="plugin-sidebar-top" className="plugin-sidebar-actions"></div> : null}
            <div className="sidebar-copy-prompt" id="copy-prompt-section" style="display:none">
              <button className="copy-prompt-btn" id="copy-prompt-btn" title="Copy worklist prompt to clipboard">
                <span className="copy-prompt-icon" id="copy-prompt-icon"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
                <span id="copy-prompt-label">Copy AI prompt</span>
              </button>
            </div>
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
                  <input type="text" id="detail-title" />
                </div>
                <div className="detail-field detail-field-full">
                  <label>Details</label>
                  <textarea id="detail-details" rows={6} placeholder="Add details..."></textarea>
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
              <div className="drawer-grid-sizer" id="drawer-grid-sizer" style="display:none" title="Tile size">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M14 15H9v-5"/><path d="M16 3h5v5"/><path d="M21 3 9 15"/></svg>
                <input type="range" id="drawer-grid-size-slider" min="0" max="100" step="1" value="33" aria-label="Grid tile size" />
              </div>
              {/* HS-7661 — Show / Hide Terminals dialog opener for the
                  drawer-grid view. Visible only while drawer-grid mode is
                  active (toggled by drawerTerminalGrid.tsx alongside the
                  sizer). Sits to the right of the slider per the user's
                  feedback ("near the slider yes, probably to the right of it"). */}
              <button type="button" className="drawer-grid-hide-btn" id="drawer-grid-hide-btn" title="Show / hide terminals" style="display:none">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
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
                    <code id="settings-channel-cmd">claude --dangerously-load-development-channels server:hotsheet-channel</code>
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
                  <button type="button" id="settings-quit-confirm-reset" className="btn btn-sm" style="margin-top:6px">Reset exempt list to defaults</button>
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
