# 130. Promised-file drops (unsaved macOS screen captures)

HS-9466. Status: **SHIPPED — the drag works.** Materializing the dropped file (a full
`arrayBuffer()` read) turned out to *fulfill* the promise, not merely detect that it was
unfulfilled, so an unsaved capture now attaches by dragging. The native route in §130.5 is
**not needed and was never built**; it is kept below as the record of an alternative that
the measurement ruled out.

This doc records why a drag that visibly works everywhere else failed here, and why the
fix landed a layer lower than everyone expected.

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

The web layer surfaces the promise as an ordinary `File` in `dataTransfer.files`. It has a
name, a MIME type, and often a plausible `size`. Nothing about it is distinguishable from a
real file **until something reads it**.

**The part that was assumed and turned out to be wrong:** that the web layer can never get
the bytes. It can — a full `arrayBuffer()` read fulfills the promise (§130.3.2). What
fails is `fetch`'s **lazy, streaming** read of the same `File`. There is no web API to
*explicitly* request fulfillment, which is what made "impossible without native code" a
reasonable-sounding conclusion; the read itself turns out to be enough.

That is why the failure was so confusing: it looked like a normal upload right up to the point
where `fetch` streamed the body, discovered the backing store was absent, and sent a truncated
multipart body. The server did the only correct thing and answered `400 Malformed upload body`
(the HS-9227 guard). The drop listener was `async` with no `catch`, so the rejection escaped as
an unhandled promise rejection and was picked up by the §HS-9455 global handler — which is
working as designed but can only report a generic crash.

**`size` is not a usable check.** On a promised file it is populated and plausible. Only a read
tells the truth.

## 130.3 What shipped — materialize, which also fulfills

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

### 130.3.2 The measurement — it works (HS-9466, maintainer-verified 2026-07-29)

The change above was built as a *better failure*: read the bytes so a truncated upload is
impossible, and refuse honestly when they aren't there. It did something else as well.

Dragging an unsaved capture onto a ticket now **attaches it**. Confirmed by the maintainer
on a real drag, which is the only instrument that could answer this.

The read is the fulfillment. `fetch` streams a `File` lazily and gets nothing; a full
`arrayBuffer()` is a different request to the OS and macOS honors it by delivering the
promised bytes. So the capability was there the whole time — the original failure was never
"the browser cannot get these bytes", it was "the one code path we used asks for them in the
way that doesn't work."

Two things worth keeping from this:

- **The reasoning that pointed at native code was sound and still wrong.** Every source
  agrees a browser has no API to fulfill an `NSFilePromise`, and that is true as stated —
  there is no *explicit* fulfillment call. It does not follow that the bytes are
  unreachable. A plan that would have cost days of Rust/Objective-C work was retired by a
  read call and one physical drag.
- **The fix was a byproduct of making the failure honest.** Materializing was adopted to
  stop uploading files we hadn't verified; that it also solved the problem was not the
  intent. Refusing to send data you haven't actually read is worth doing on its own terms.

## 130.4 The gate — settled, and how

Before the §130.5 native work, the open question was whether the drag carried any other
usable representation. `describeDragPayload` (`dropFiles.ts`) was added to answer it,
logged by the drop handler on **either** failure path — when screening rejects a file, and
when an upload fails after screening passed. (Its first version logged only the former,
i.e. only the failure that was expected; when the other one happened instead, the report
came back with no diagnostic at all.) Failure paths only, so it costs nothing in normal
use:

```
[hotsheet] drop had 1 unreadable file(s). Drag payload:
types: Files, …
items:
  [0] kind=file type=image/png
  …
```

**It never needed to fire.** The drag started succeeding, which answers the gate more
directly than any payload dump: the promised file itself delivers, so there is no need to
prefer another representation over it. The diagnostic stays — it is free unless a drop
fails, and it is the right first evidence for the next drag-and-drop failure of any kind.

<details>
<summary>The original gate, kept for the record</summary>

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

</details>

## 130.5 The native route — NOT BUILT, not needed

**Retired by §130.3.2.** The plan below was the expected shape of the fix right up until a
full read made it unnecessary. It is kept because the reasoning is worth having on record,
and because the same pasteboard question may come back for a drag type that genuinely
doesn't deliver.

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

That judgment never had to be made: the papercut is gone, and it stayed desktop-and-browser
both, which the native route could never have managed.

## 130.6 Cross-references

- [5-attachments.md](5-attachments.md) §5.1 (upload), §5.2 (drag-and-drop), §5.2.2 (the
  materialization).
- [77-paste-attachments.md](77-paste-attachments.md) — the clipboard path, which handled this
  case while the drag didn't, and which the failure message still points at.
- HS-9455 — the global client error handler whose generic popup this failure surfaced through;
  the fix is that the drop path no longer reaches it.
- HS-9227 — the `400 Malformed upload body` guard that correctly caught the truncated body.
