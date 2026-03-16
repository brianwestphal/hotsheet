import { Hono } from 'hono';

import { Layout } from '../components/layout.js';
import { raw } from '../jsx-runtime.js';
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
              <input type="text" id="search-input" placeholder="Search tickets..." />
            </div>
            <div className="layout-toggle" id="layout-toggle">
              <button className="layout-btn active" data-layout="list" title="List view">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>')}</button>
              <button className="layout-btn" data-layout="columns" title="Column view">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>')}</button>
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
              <button className="layout-btn active" data-position="side" title="Detail panel on side">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>')}</button>
              <button className="layout-btn" data-position="bottom" title="Detail panel on bottom">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>')}</button>
            </div>
            <button className="glassbox-btn" id="glassbox-btn" title="Open Glassbox" style="display:none">{raw('<img id="glassbox-icon" alt="Glassbox" />')}</button>
            <button className="settings-btn" id="settings-btn" title="Settings">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>')}</button>
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
            <div className="sidebar-copy-prompt" id="copy-prompt-section" style="display:none">
              <button className="copy-prompt-btn" id="copy-prompt-btn" title="Copy worklist prompt to clipboard">
                <span className="copy-prompt-icon" id="copy-prompt-icon">{raw('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>')}</span>
                <span id="copy-prompt-label">Copy AI prompt</span>
              </button>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-label">Views</div>
              <button className="sidebar-item active" data-view="all">All Tickets</button>
              <button className="sidebar-item" data-view="non-verified">Non-Verified</button>
              <button className="sidebar-item" data-view="up-next">Up Next</button>
              <button className="sidebar-item" data-view="open">Open</button>
              <button className="sidebar-item" data-view="completed">Completed</button>
              <button className="sidebar-item" data-view="verified">Verified</button>
              <div className="sidebar-divider"></div>
              <button className="sidebar-item" data-view="backlog">Backlog</button>
              <button className="sidebar-item" data-view="archive">Archive</button>
              <button className="sidebar-item" data-view="trash">Trash</button>
            </div>
            <div className="sidebar-section">
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
                <select id="batch-category" title="Set category" disabled>
                  <option value="">Category...</option>
                  <option value="issue">Issue</option>
                  <option value="bug">Bug</option>
                  <option value="feature">Feature</option>
                  <option value="requirement_change">Req Change</option>
                  <option value="task">Task</option>
                  <option value="investigation">Investigation</option>
                </select>
                <select id="batch-priority" title="Set priority" disabled>
                  <option value="">Priority...</option>
                  <option value="highest">Highest</option>
                  <option value="high">High</option>
                  <option value="default">Default</option>
                  <option value="low">Low</option>
                  <option value="lowest">Lowest</option>
                </select>
                <select id="batch-status" title="Set status" disabled>
                  <option value="">Status...</option>
                  <option value="not_started">Not Started</option>
                  <option value="started">Started</option>
                  <option value="completed">Completed</option>
                  <option value="verified">Verified</option>
                  <option value="backlog">Backlog</option>
                  <option value="archive">Archive</option>
                </select>
                <button id="batch-upnext" className="batch-star-btn" title="Toggle Up Next" disabled>{raw('<span class="batch-star-icon">&#9734;</span>')}</button>
                <button id="batch-delete" className="btn btn-sm btn-danger batch-delete-btn" title="Delete selected" disabled>{raw('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>')}</button>
                <span className="batch-count" id="batch-count"></span>
              </div>

              <div className="ticket-list" id="ticket-list">
                {raw('<div class="ticket-list-loading">Loading...</div>')}
              </div>
            </main>

            <div className="detail-resize-handle" id="detail-resize-handle" style="display:none"></div>

            <aside className="detail-panel" id="detail-panel" style="display:none">
              <div className="detail-header">
                <span className="detail-ticket-number" id="detail-ticket-number"></span>
                <button className="detail-close" id="detail-close" title="Close">{raw('&times;')}</button>
              </div>
              <div className="detail-body">
                <div className="detail-fields-row">
                  <div className="detail-field">
                    <label>Category</label>
                    <select id="detail-category">
                      <option value="issue">Issue</option>
                      <option value="bug">Bug</option>
                      <option value="feature">Feature</option>
                      <option value="requirement_change">Req Change</option>
                      <option value="task">Task</option>
                      <option value="investigation">Investigation</option>
                    </select>
                  </div>
                  <div className="detail-field">
                    <label>Priority</label>
                    <select id="detail-priority">
                      <option value="highest">Highest</option>
                      <option value="high">High</option>
                      <option value="default">Default</option>
                      <option value="low">Low</option>
                      <option value="lowest">Lowest</option>
                    </select>
                  </div>
                  <div className="detail-field">
                    <label>Status</label>
                    <select id="detail-status">
                      <option value="not_started">Not Started</option>
                      <option value="started">Started</option>
                      <option value="completed">Completed</option>
                      <option value="verified">Verified</option>
                      <option value="backlog">Backlog</option>
                      <option value="archive">Archive</option>
                    </select>
                  </div>
                  <div className="detail-field">
                    <label className="detail-upnext-label">
                      <input type="checkbox" id="detail-upnext" />
                      Up Next
                    </label>
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
                  <label>Attachments</label>
                  <div id="detail-attachments" className="detail-attachments"></div>
                  <label className="btn btn-sm upload-btn">
                    Attach File
                    <input type="file" id="detail-file-input" style="display:none" />
                  </label>
                </div>
                <div className="detail-field detail-field-full" id="detail-notes-section" style="display:none">
                  <label>Notes</label>
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
            <span><kbd>{raw('&#8984;')}I/B/F/R/K/G</kbd> category</span>
            <span><kbd>Alt+1-5</kbd> priority</span>
            <span><kbd>{raw('&#8984;')}D</kbd> up next</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
          <div id="status-bar" className="status-bar"></div>
        </footer>
      </div>

      <div className="settings-overlay" id="settings-overlay" style="display:none">
        <div className="settings-dialog">
          <div className="settings-header">
            <h2>Settings</h2>
            <button className="detail-close" id="settings-close">{raw('&times;')}</button>
          </div>
          <div className="settings-body">
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
            <div className="settings-section">
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
            <div className="settings-section" id="settings-updates-section" style="display:none">
              <div className="settings-section-header">
                <h3>Software Updates</h3>
                <button className="btn btn-sm" id="check-updates-btn">Check for Updates</button>
              </div>
              <div className="settings-hint" id="check-updates-status"></div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
  return c.html(html.toString());
});
