import { Hono } from 'hono';

import { Layout } from '../components/layout.js';
import type { AppEnv } from '../types.js';

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/', (c) => {
  const html = (
    <Layout title="Hot Sheet">
      <div className="app">
        <header className="app-header">
          <div className="app-title">
            <h1>Hot Sheet</h1>
          </div>
          <div className="header-controls">
            <div className="search-box">
              <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input type="text" id="search-input" placeholder="Search tickets..." />
            </div>
            <div className="layout-toggle" id="layout-toggle">
              <button className="layout-btn active" data-layout="list" title="List view"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
              <button className="layout-btn" data-layout="columns" title="Column view"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg></button>
            </div>
            <div className="sort-controls">
              <select id="sort-select">
                <option value="created:desc">Newest First</option>
                <option value="created:asc">Oldest First</option>
                <option value="priority:asc">Priority</option>
                <option value="category:asc">Category</option>
                <option value="status:asc">Status</option>
              </select>
            </div>
            <div className="layout-toggle" id="detail-position-toggle">
              <button className="layout-btn active" data-position="side" title="Detail panel on side"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg></button>
              <button className="layout-btn" data-position="bottom" title="Detail panel on bottom"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg></button>
            </div>
            <button className="glassbox-btn" id="glassbox-btn" title="Open Glassbox" style="display:none"><img id="glassbox-icon" alt="Glassbox" /></button>
            <button className="settings-btn print-btn" id="print-btn" title="Print"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg></button>
            <button className="settings-btn" id="settings-btn" title="Settings"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
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

        <div className="app-body">
          <nav className="sidebar">
            <div className="sidebar-channel-play" id="channel-play-section" style="display:none">
              <button className="channel-play-btn" id="channel-play-btn" title="Run worklist (double-click for auto mode)">
                <span className="channel-play-icon" id="channel-play-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
                <span className="channel-auto-icon" id="channel-auto-icon" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"/><path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"/></svg></span>
              </button>
            </div>
            <div id="channel-commands-container"></div>
            <div className="sidebar-copy-prompt" id="copy-prompt-section" style="display:none">
              <button className="copy-prompt-btn" id="copy-prompt-btn" title="Copy worklist prompt to clipboard">
                <span className="copy-prompt-icon" id="copy-prompt-icon"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
                <span id="copy-prompt-label">Copy AI prompt</span>
              </button>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-label">Views <button className="sidebar-add-view-btn" id="add-custom-view-btn" title="New custom view"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/></svg></button></div>
              <button className="sidebar-item active" data-view="all">All Tickets</button>
              <button className="sidebar-item" data-view="non-verified">Non-Verified</button>
              <button className="sidebar-item" data-view="up-next">Up Next</button>
              <button className="sidebar-item" data-view="open">Open</button>
              <button className="sidebar-item" data-view="completed">Completed</button>
              <button className="sidebar-item" data-view="verified">Verified</button>
              <div id="custom-views-container"></div>
              <div className="sidebar-divider"></div>
              <button className="sidebar-item" data-view="backlog">Backlog</button>
              <button className="sidebar-item" data-view="archive">Archive</button>
              <button className="sidebar-item" data-view="trash">Trash</button>
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
              <button className="sidebar-item" data-view="priority:highest">Highest</button>
              <button className="sidebar-item" data-view="priority:high">High</button>
              <button className="sidebar-item" data-view="priority:default">Default</button>
              <button className="sidebar-item" data-view="priority:low">Low</button>
              <button className="sidebar-item" data-view="priority:lowest">Lowest</button>
            </div>
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
                    <input type="file" id="detail-file-input" style="display:none" />
                  </label>
                </div>
                <div className="detail-field detail-field-full" id="detail-notes-section">
                  <div className="detail-notes-label"><span>Notes</span> <button className="sidebar-add-view-btn" id="detail-add-note-btn" title="Add note"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button></div>
                  <div id="detail-notes" className="detail-notes"></div>
                </div>
                <div className="detail-meta detail-field-full" id="detail-meta"></div>
              </div>
            </aside>
          </div>
        </div>

        <footer className="app-footer">
          <div className="keyboard-hints">
            <span><kbd>Enter</kbd> new ticket</span>
            <span><kbd>{'\u2318'}I/B/F/R/K/G</kbd> category</span>
            <span><kbd>Alt+1-5</kbd> priority</span>
            <span><kbd>{'\u2318'}D</kbd> up next</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
          <div className="status-bar-right">
            <div id="status-bar" className="status-bar"></div>
            <span id="channel-status-indicator" className="channel-status-indicator" style="display:none"></span>
          </div>
        </footer>
      </div>

      <div className="settings-overlay" id="settings-overlay" style="display:none">
        <div className="settings-dialog">
          <div className="settings-header">
            <h2>Settings</h2>
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
            <button className="settings-tab" data-tab="experimental" id="settings-tab-experimental" style="display:none">
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
                <label>App name</label>
                <input type="text" id="settings-app-name" placeholder="Hot Sheet" />
                <span className="settings-hint" id="settings-app-name-hint">Custom name shown in the title bar. Leave empty for default.</span>
              </div>
              <div className="settings-field">
                <label>Auto-clear trash after (days)</label>
                <input type="number" id="settings-trash-days" min="1" value="3" />
              </div>
              <div className="settings-field">
                <label>Auto-clear verified after (days)</label>
                <input type="number" id="settings-verified-days" min="1" value="30" />
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
            <div className="settings-tab-panel" data-panel="experimental" id="settings-experimental-panel" style="display:none">
              <div className="settings-field">
                <label className="settings-checkbox-label">
                  <input type="checkbox" id="settings-channel-enabled" />
                  Enable Claude Channel integration
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
                    <button className="btn btn-sm" id="settings-add-command-btn">Add Command</button>
                  </div>
                  <span className="settings-hint">Custom buttons that trigger actions in Claude. They appear below the play button in the sidebar.</span>
                  <div id="settings-commands-list" className="settings-commands-list" style="margin-top:8px"></div>
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
      <div className="permission-overlay" id="permission-overlay" style="display:none">
        <div className="permission-overlay-content">
          <div className="permission-overlay-text">Claude is waiting for permission</div>
          <div className="permission-overlay-detail" id="permission-overlay-detail"></div>
          <div className="permission-overlay-actions">
            <button className="permission-overlay-btn permission-allow" id="permission-allow-btn">Allow</button>
            <button className="permission-overlay-btn permission-deny" id="permission-deny-btn">Deny</button>
            <button className="permission-overlay-btn permission-dismiss" id="permission-dismiss-btn">Dismiss</button>
          </div>
        </div>
      </div>
    </Layout>
  );
  return c.html(html.toString());
});
