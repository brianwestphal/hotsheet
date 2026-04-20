# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.16.1] - 2026-04-20

- Fix right-click clearing multi-selection in list view

## [0.16.0] - 2026-04-20

- Add compact permission popup for non-active project tabs
- UX improvements for attachments, including quicklook previewing (use spacebar and arrow keys to select attachments)
- Add Claude Code hooks for accurate busy/idle detection, clarify feedback prefix instructions

## [0.16.0] - 2026-04-20

- Add compact permission popup for non-active project tabs
- UX improvements for attachments, including quicklook previewing (use spacebar and arrow keys to select attachments)
- Add Claude Code hooks for accurate busy/idle detection, clarify feedback prefix instructions

## [0.15.4] - 2026-04-18

- Better attachment drag and drop support
- Click ticket number in details panel to copy it
- Fixed a bug with the UI refresh loop

## [0.15.3] - 2026-04-17

- Fix column view arrow key navigation by moving to document-level handler
- Change feedback indicator dots from blue to purple, feedback takes priority over unread

## [0.15.2] - 2026-04-16

- Fixed production built-in plugin bundling

## [0.15.1] - 2026-04-16

- Removed Demo Plugin from production release

## [0.15.0] - 2026-04-16

- Made an e2e test more resiliant for GitHub actions environment

## [0.15.0] - 2026-04-16

- Made an e2e test more resiliant for GitHub actions environment

## [0.15.0] - 2026-04-16

- Made a few e2e tests more resiliant for GitHub actions environment

## [0.15.0] - 2026-04-15

- General UI/UX improvements
- Unread indicators / tracking
- AI tools can now request feedback on tickets
- Mode code clean up and testing
- Various bug fixes

BETA FEATURES:
- Support for plugins
  - Includes beta plugin for GitHub issues integration

## [0.14.1] - 2026-04-09

- Custom views now exclude deleted and archived tickets
  - Archived tickets can be re-included with an extra checkbox in the custom view's edit dialog if desired

## [0.14.0] - 2026-04-09

- We no longer auto-delete verified items after a time period, now we auto-archive them
- Various MCP / channel improvements
- Completed and verified items are now struckthru in column view mode, like they were in list view mode
- The detail panel is now closable (just tap the same segmented control option again)
- There's a new option in general settings to hide the verified column
- Cut, copy, and paste works on tickets now
- Tab order is now better preserved

## [0.13.1] - 2026-04-08

- Fix sidebar command button E2E test: use shell target and skip if container missing

## [0.13.0] - 2026-04-08

- Support for grouping custom commands (see experimental tab of settings)
- Column view now shows tags on tickets
- A few bug fixes

## [0.12.3] - 2026-04-08

- Fixed an issue with the CLI script when Hot Sheet is already running
- Add a Share Hot Sheet button and periodic prompt to share Hot Sheet with friends and colleagues

## [0.12.3] - 2026-04-08

- Fixed an issue with the CLI script when Hot Sheet is already running
- Add a Share Hot Sheet button and periodic prompt to share Hot Sheet with friends and colleagues

## [0.12.3] - 2026-04-08

- Fixed an issue with the CLI script when Hot Sheet is already running
- Add a Share Hot Sheet button and periodic prompt to share Hot Sheet with friends and colleagues

## [0.12.2] - 2026-04-07

- Fixed an issue with the CLI script

## [0.12.1] - 2026-04-07

- Improved permissions prompt handling

## [0.12.1] - 2026-04-07

- Improved permissions prompt handling

## [0.12.0] - 2026-04-07

- Multi-project support within a single app instance.  Tabbed interface.
- Custom ticket prefix
- Various usability improvements

## [0.12.0] - 2026-04-07

- Multi-project support within a single app instance.  Tabbed interface.
- Custom ticket prefix
- Various usability improvements

## [0.11.0] - 2026-04-03

- Added command log - accessible through new button on right side of bottom status bar
- Support for custom shell command buttons
- Various UI improvements

## [0.10.4] - 2026-04-03

- Fixed permissions on RC workflow

## [0.10.3] - 2026-04-03

- Making sure desktop apps get released after npm package release

## [0.10.2] - 2026-04-03

- Fixed RC GitHub Action production version numbering

## [0.10.1] - 2026-04-03

- Fixed RC GitHub action

## [0.10.1] - 2026-04-03

- Fix beta publish

## [0.10.1] - 2026-04-03

- Fix tauri build in RC workflow

## [0.10.1] - 2026-04-03

- Fix E2E smoke test isolation and strict mode violations

## [0.10.1] - 2026-04-03

- Using GitHub actions for more complex testing / release process

## [0.10.1] - 2026-04-03

- Updated release script
- Updated GitHub actions configuration

## [0.10.0] - 2026-04-02

- Added auto-prioritize option (enabled by default) -- if no items are in "up next" and this option is enabled, running /hotsheet (or clicking the play button when using Claude channels), automatically determines what should be worked on next
- Added sidebar icons and changed some icons
- Fixed a few item selection and race condition bugs
- Log-scale cycle time chart with sub-day precision
- Code cleanup and more testing

## [0.9.0] - 2026-03-27

- Security hardening: fix path traversal, CSRF bypass, and secret exposure

## [0.8.0] - 2026-03-27

- Dynamic app icon switching with 9 variants
- Drag-and-drop file attachments on detail panel and attach multiple files at once
- Improved Claude permissions prompt
- Exponential backoff for auto mode retries, fix category keyboard hints

## [0.7.0] - 2026-03-26

- Attention notifications: bounce dock icon (Tauri) or flash tab title (browser) on permission requests and Claude idle
- Auto-context prefix configuration per ticket category and per tag in settings dialog
- Server-side bracket tag extraction on ticket creation
- Search now includes tags
- Secret-based API validation and port recovery for multi-instance safety

When creating a new ticket, titles like "[my tag] [another tag] my title" get turned into a ticket title and extracted tags (ex. title: "my title" and tags: "my tag", and "another tag").

## [0.6.5] - 2026-03-26

- Tag custom views, case-insensitive tag normalization, bracket syntax for tag creation, and autocomplete improvements

## [0.6.4] - 2026-03-26

- Fixed data refresh disrupting text field editing
- Improved automatic mode debounce/retry logic (when using Claude channel support)

## [0.6.3] - 2026-03-25

- Custom command button styling, icon picker, color palette, drag reorder
- Redesigned search field with pill shape, icon, and animated expansion

## [0.6.2] - 2026-03-25

- Improved permission overlay detail
- Added empty worklist alert
- Fixed detail panel not auto-refreshing on external changes

## [0.6.1] - 2026-03-25

- Added permission relay overlay for Claude Channel integration

## [0.6.0] - 2026-03-25

- Users can now, when experimental Claude channels integration is enabled, add custom claude trigger buttons to the UI
- Moved Experimental settings to a new tab in the settings dialog

## [0.5.3] - 2026-03-24

- Fixed Tauri config for working with Claude channels

## [0.5.2] - 2026-03-24

- Fixed missing release artifact needed for Claude channels when using Tauri

## [0.5.1] - 2026-03-24

- Fixed incorrect path in generted .mcp.json files

## [0.5.0] - 2026-03-24

- Added experimental support for Claude channels
- Added support for using delete key to delete items 
- Fixed undo/redo support for notes

## [0.4.0] - 2026-03-23

- Tagging
- Custom views (smart search)
- Ticket reordering is now animated for better user feedback
- More powerful notes: allows multiple notes as well as editing / deleting
- Added stats dashboard
- Added support for printing (sort of)
- General UI improvements

## [0.3.0] - 2026-03-21

- Organized Settings dialog
- Added support for custom categories / different category presets (see Settings dialog)
- General UI improvements
- Code cleanup

## [0.2.14] - 2026-03-20

- Fixed release script

## [0.2.13] - 2026-03-20

- cli install script now creates /use/local/bin if needed
- Release script now gives installable artifacts more human-readable names

## [0.2.12] - 2026-03-19

- Added ... menu in selected items toolbar, with:
  - Duplicate
  - Archive
  - Move to Backlog

## [0.2.11] - 2026-03-18

- Fixed release script

## [0.2.10] - 2026-03-18

- Fixed an issue with using the shift key for multiple item selection in column mode
- No longer hiding the details panel when nothing or multiple items are selected

## [0.2.9] - 2026-03-16

### Fixed
- Fixed Windows build (cross-platform asset copying in tsup config)

## [0.2.8] - 2026-03-16

### Added
- Undo/redo support (Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z) for ticket field changes, deletion, batch operations, and drag-and-drop
- Glassbox integration — when Glassbox is detected, an icon appears in the header to launch it on the same project folder

## [0.2.7] - 2026-03-14

### Added
- Check for Updates option in settings panel

### Changed
- Generated AI tool skills files no longer include port number, which can change on each use

### Fixed
- Fixed automatic updates support

## [0.2.6] - 2026-03-13

### Added
- Backlog and Archive statuses for tickets

## [0.2.5] - 2026-03-13

### Added
- App name setting exposed in settings panel
- Navigate to folder containing attachments with a button click

### Fixed
- Fixed an issue where updating tickets caused columns/lists to scroll back to the top

## [0.2.4] - 2026-03-13

### Fixed
- Fixed issue where hotsheet-node process wasn't properly killed on exit
- Fixed random system changes popup caused by software update running in background — now prompts to install

## [0.2.3] - 2026-03-13

### Added
- Database backup and restore with configurable storage locations
- AI tool skills for creating tickets directly (e.g., `/hs-bug something isn't working`)
- Other usability improvements

## [0.2.2] - 2026-03-12

### Fixed
- Fixed release script not properly updating version numbers on native binaries
- Improved support for multiple instances of Hot Sheet running simultaneously, especially on macOS

## [0.2.1] - 2026-03-12

### Added
- Tauri desktop app — GitHub Actions now create native binaries for macOS, Linux, and Windows

## [0.2.0] - 2026-03-12

### Added
- Column (kanban) layout with drag-and-drop between status columns
- Detail panel position toggle (side or bottom) in the toolbar
- Drag-and-drop onto sidebar items to change category, priority, or status
- Non-Verified view

### Fixed
- Fixed issue where the wrong port could be listed in worklist.md when dynamically switching ports

## [0.1.2] - 2026-03-11

### Added
- Cmd/Ctrl+C copies ticket titles, descriptions, and notes — useful for commit messages

### Fixed
- Fixed issue where the wrong port number was listed in worklist.md when using a non-default port
- Improved ticket entry usability

## [0.1.1] - 2026-03-11

### Added
- Automatic software update checking

## [0.1.0] - 2026-03-11

Initial release.
