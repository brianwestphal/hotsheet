# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
