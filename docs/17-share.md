# 17. Share Prompt

## 17.1 Overview

Hot Sheet prompts users to share the app after they've used it for a meaningful amount of time. A persistent share button in the toolbar also allows sharing at any time.

## 17.2 Share Link

- A persistent share link appears in the footer status bar. The link text reads "Know someone who'd love this? Share Hot Sheet" and uses accent blue color. No icon.
- Clicking the link triggers the Web Share API (`navigator.share()`) with:
  - Title: "Hot Sheet"
  - Text: "A fast, local ticket tracker that feeds your AI coding tools."
  - URL: `https://www.npmjs.com/package/hotsheet`
- **Fallback**: If Web Share API is not available, copies the text + URL to the clipboard.

## 17.3 Share Prompt Banner

A banner prompts the user to share the app when all of the following criteria are met:

1. **Total accumulated time** across all sessions is at least **5 minutes** (300 seconds).
2. **Current session** has been running for at least **1 minute** (60 seconds).
3. The user has **not been prompted in the last 30 days** (or has never been prompted).
4. The user has **not previously shared** (i.e., `shareAccepted` is not `true`).

### Timing Mechanism

- Session start time is recorded on initialization.
- A 30-second interval accumulates elapsed time into `shareTotalSeconds` in the global config (`~/.hotsheet/config.json`).
- After accumulating, the prompt criteria are checked.

### Banner Behavior

- The banner appears at the top of the app (similar to the update/skills banners).
- Contains a "Share" button and a "Not now" dismiss button.
- **On "Share"**: Triggers the share action and records `shareAccepted: true` and `shareLastPrompted` timestamp in global config.
- **On "Not now"**: Records `shareLastPrompted` timestamp. The prompt will reappear after 30 days if criteria are still met.
- Once the user has shared (`shareAccepted: true`), the banner never appears again.

## 17.4 Global Config Fields

Stored in `~/.hotsheet/config.json` via the global config system:

| Field | Type | Description |
|-------|------|-------------|
| `shareTotalSeconds` | number | Accumulated usage time across all sessions (seconds) |
| `shareLastPrompted` | string | ISO timestamp of the last share prompt |
| `shareDismissedAt` | string | ISO timestamp when the user dismissed the prompt |
| `shareAccepted` | boolean | Whether the user has ever shared |

## 17.5 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/global-config` | Read global config (includes share fields) |
| PATCH | `/api/global-config` | Update global config fields |
