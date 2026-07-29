# 130. Promised-file drops (unsaved macOS screen captures)

HS-9466. Status: **detection shipped (HS-9465); fulfillment not built, and gated on a
measurement that has not been taken.** This doc exists to record why a drag that visibly
works everywhere else fails here, what was done about it, and the one experiment that
decides whether to build the rest.

Companion to [5-attachments.md](5-attachments.md) §5.2.2 (the detection) and
[77-paste-attachments.md](77-paste-attachments.md) (the paste path that already works).

## 130.1 The report

> on macos, captured screenshots first show up in the corner and can be dragged and dropped,
> but they dont really have permanent file backings yet. i have to wait until its saved to
> disk before it works, otherwise it shows an error.

The error was `Something went wrong / Error: Malformed upload body (unhandled promise
rejection)` — a generic crash popup naming neither the file nor anything to do about it.

## 130.2 What is actually happening

macOS `screencapture` (⇧⌘4 and friends) shows the result as a floating thumbnail for a few
seconds before writing it to disk. During that window the capture **is not a file**. Dragging
the thumbnail puts an `NSFilePromise` on the dragging pasteboard: a commitment to produce bytes
when a receiver asks for them, at a destination the receiver names.

The web layer never gets to ask. A browser — and the WKWebView the Tauri build runs in —
surfaces the promise as an ordinary `File` in `dataTransfer.files`. It has a name, a MIME type,
and often a plausible `size`. Nothing about it is distinguishable from a real file **until
something reads it**, and there is no web API to request fulfillment.

That is why the failure was so confusing: it looked like a normal upload right up to the point
where `fetch` streamed the body, discovered the backing store was absent, and sent a truncated
multipart body. The server did the only correct thing and answered `400 Malformed upload body`
(the HS-9227 guard). The drop listener was `async` with no `catch`, so the rejection escaped as
an unhandled promise rejection and was picked up by the §HS-9455 global handler — which is
working as designed but can only report a generic crash.

**`size` is not a usable check.** On a promised file it is populated and plausible. Only a read
tells the truth.

## 130.3 What shipped (HS-9465) — detect, explain, don't crash

`src/client/dropFiles.ts::screenDroppedFiles` **materializes** every dropped file — reads its
bytes and hands back an in-memory copy — before anything is created or uploaded. A file whose
bytes aren't there is reported instead of uploaded.

### 130.3.1 The first attempt was too weak (HS-9466)

The original version only checked that reading one byte didn't *throw*. The reported failure got
straight past it and still produced `Malformed upload body` — this time surfaced as
"Could not attach the file", i.e. from the `catch`, proving screening had passed the file and the
upload truncated anyway. Two holes:

1. **`slice(0, 1).arrayBuffer()` can resolve with ZERO bytes.** Nothing throws, nothing is read,
   and a "did it throw?" check waves the file through.
2. **One readable byte proves nothing about the rest.** `fetch` streams a `File` lazily, so the
   body can still truncate mid-flight — the exact failure being detected, just moved later.

So it is no longer a check. We read the bytes and upload *those*, which makes truncation
structurally impossible: either the promise delivered and we hold a real file, or it didn't and we
say so before any request exists. A **short read** (fewer bytes than `size`) counts as failure
too — silently attaching a partial PNG is worse than refusing it.

Files over `MAX_MATERIALIZE_BYTES` (64 MB) are still streamed rather than buffered, after a
one-byte probe that now also requires the byte to actually arrive. A promised screen capture is a
few hundred KB, so the case this module exists for never approaches the cap; it is only there so
dropping a large video doesn't double its memory.

- The message names the file and states the two things that work: wait for the capture to land
  on the desktop, or press ⌘V.
- **Partial success**: a drop mixing a saved and an unsaved capture attaches the saved one and
  reports only what was skipped.
- **No litter**: the check runs before `resolveDropTicketId`, so a drop with nothing readable
  creates no ticket — otherwise every failed drag left an empty "Attachment" ticket behind.
- The drop listener now has a `catch`, so any other failure reports as "Could not attach the
  file" rather than as a crash.

This is honest but incomplete: it explains the failure, it does not remove it.

## 130.4 The gate — one drag settles it

Before any native work, the question is whether the drag carries **any other representation**
alongside the broken promised file. Nobody has looked. If it offers an `image/png` item with
real bytes, or a resolvable URL, the fix is a few lines of client code preferring that
representation and the native path is unjustified.

`describeDragPayload` (`dropFiles.ts`) is logged by the drop handler on **either** failure path —
when screening rejects a file, and when an upload fails after screening passed. The first version
logged only the former, i.e. only the failure that was expected; when the second one happened
instead, the report came back with no diagnostic attached at all. Failure paths only, so it costs
nothing in normal use:

```
[hotsheet] drop had 1 unreadable file(s). Drag payload:
types: Files, …
items:
  [0] kind=file type=image/png
  …
```

**The experiment:** take a screen capture, and while the thumbnail is still floating in the
corner, drag it onto a ticket. Read the console line. Repeat in the Tauri build, where the
answer may differ — and there, also record what the native drag-drop event reports.

- **If a representation with real bytes appears** → prefer it over the `files` entry, in the
  client. Done; close §130.5 as unnecessary.
- **If the only representation is the promised file** → that is the evidence that §130.5 is the
  only route, and the cost/benefit below applies.

## 130.5 The native route (Tauri only), if the gate says so

A native drag handler on the WKWebView inspects the dragging pasteboard, resolves the promise
via `NSFilePromiseReceiver` / `receivePromisedFiles(atDestination:)` into a temp directory, and
hands Hot Sheet the resulting path — surfaced to the client the way the existing Tauri
drag-drop events are.

Weigh honestly before building it:

- **Desktop only.** The browser build keeps today's behavior no matter what. Hot Sheet's rule
  is that a feature works in both (see the standing "web and Tauri" expectation), and this one
  structurally cannot.
- **⌘V already covers the case**, including a capture taken with Ctrl held, which goes straight
  to the clipboard and never becomes a file at all. The gap is "drag specifically", and the
  §130.3 message now points at the paste that works.
- It is real Rust/Objective-C work against a pasteboard API with no Tauri abstraction over it.

None of that makes it wrong to build — dragging is the natural gesture and being told to use a
different one is a papercut. It makes it a **judgment call that should be made with the §130.4
data in hand**, not before.

## 130.6 Cross-references

- [5-attachments.md](5-attachments.md) §5.1 (upload), §5.2 (drag-and-drop), §5.2.2 (this
  detection).
- [77-paste-attachments.md](77-paste-attachments.md) — the clipboard path, which handles this
  case today and is what the error message recommends.
- HS-9455 — the global client error handler whose generic popup this failure surfaced through;
  the fix is that the drop path no longer reaches it.
- HS-9227 — the `400 Malformed upload body` guard that correctly caught the truncated body.
