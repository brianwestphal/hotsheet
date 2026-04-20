# 19. Demo Plugin

The demo plugin is a bundled plugin that exercises all Hot Sheet plugin features for development and testing purposes. It does not connect to an external ticketing system — it exists purely to demonstrate and validate the plugin API surface.

## 19.1 Purpose

- Validate that all plugin UI integration points render correctly.
- Demonstrate all preference types for plugin developers building their own plugins.
- Exercise config layout features (groups, dividers, labels, buttons, colors).
- Provide a visual reference for the [Plugin Development Guide](plugin-development-guide.md).

## 19.2 Features Demonstrated

### Settings UI Types

All seven preference types are exercised:

| Type | Preference | Description |
|------|-----------|-------------|
| `string` (secret, global) | API Key | Global-scoped secret field with min-length validation |
| `string` (required) | Username | Required field with no-spaces and min-length validation |
| `boolean` | Auto-greet | Toggle checkbox |
| `number` | Max Items | Numeric input with range validation |
| `select` | Color Theme | Fixed dropdown with 4 options |
| `combo` | Region | Dropdown with custom-entry option |
| `dropdown` | Sync Mode | Alias for select (3 options) |

### Config Layout

The config dialog uses all layout item types:

- `preference` — renders each preference input
- `divider` — horizontal separator after API Key
- `spacer` — vertical gap before the test button
- `label` — dynamic "connection-status" label with color tones
- `button` — "Test Connection" triggers `test_connection` action
- `group` — three collapsible groups: Appearance (open), Sync Settings (collapsed), Advanced (collapsed)

### Label Colors

The connection-status label demonstrates all reachable color tones:
- `transient` — initial "Not tested" state
- `success` — valid API key + username
- `error` — API key too short
- `warning` — missing required fields

### Field Validation

Inline validation feedback for four fields:
- `api_key`: required, min 8 chars (warning), valid format (success)
- `username`: required, no spaces, min 3 chars (warning), greeting on success
- `webhook_url`: optional, validates URL format, warns if not HTTPS
- `max_items`: numeric, min 1, warns if > 1000

### UI Extension Locations

Registers a button at every supported location:
- `toolbar` — bolt icon in the header toolbar
- `status_bar` — shows "Demo: {username}" in the footer
- `detail_top` — info button above ticket fields
- `detail_bottom` — notify button below notes/meta (button element)
- `detail_bottom` — link element demonstrating the `link` type
- `context_menu` — "Demo Action" in the right-click menu
- `batch_menu` — "Demo Batch" in the batch toolbar menu
- `sidebar_actions_top` — button above sidebar actions
- `sidebar_actions_bottom` — button below sidebar actions

All buttons log their action to the plugin log and return a result.

## 19.3 Installation

The demo plugin is available in the source repository (`plugins/demo-plugin/`) but is not bundled for production builds. It can be installed manually via "Find Plugins > From Disk" by selecting the plugin directory.

## 19.4 Build

Built as part of the main `npm run build` via tsup. Entry point: `plugins/demo-plugin/src/index.ts` → `dist/plugins/demo-plugin/index.js`.
