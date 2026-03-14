# Markdown Sync Testing

**Risk Level: Medium**

The markdown sync system generates `worklist.md` and `open-tickets.md` files that are consumed by AI tools. Incorrect output can confuse AI agents, give them wrong ticket data, or provide stale API instructions.

## Worklist Generation

**What to test:** Content accuracy and format correctness.

- Only Up Next tickets appear in the worklist.
- Tickets are sorted by priority (highest first).
- Each ticket entry includes: ID, type, priority, status, title, details, and notes with timestamps.
- The API port in curl examples matches the actual running port.
- Workflow instructions are present and include correct curl commands for status updates.
- Category descriptions reference section is included.
- An empty Up Next list produces a valid file (with workflow section but no tickets).

## Open Tickets Generation

**What to test:** Grouping and completeness.

- Only open tickets (not_started and started) appear.
- Tickets are grouped by status: "Started" section first, then "Not Started."
- The total count at the top matches the actual number of open tickets.
- Per-ticket format matches the worklist format.
- An empty open tickets list produces a valid file.

## Debouncing

**What to test:** Multiple rapid changes coalesce into a single file write.

- Multiple calls to `scheduleWorklistSync()` within 500ms result in only one file write.
- Multiple calls to `scheduleOpenTicketsSync()` within 5 seconds result in only one file write.
- The written content reflects the final state, not an intermediate state.

## Notes Formatting

**What to test:** Notes render correctly in markdown.

- JSON array notes are formatted with timestamps and text.
- Legacy plain-text notes are displayed without a timestamp.
- Empty notes are omitted entirely.
- Timestamps are formatted in a human-readable way.

## Attachment Listing

**What to test:** Attachments are listed in the ticket's markdown section.

- Tickets with attachments include a list of filenames.
- Tickets without attachments omit the attachments section.

## Trigger Coverage

**What to test:** All mutation operations trigger a sync.

- Ticket create, update, delete, restore, batch operations, attachment changes, and settings updates all trigger `scheduleAllSync()`.
- This ensures the markdown files are never stale after a data change.
