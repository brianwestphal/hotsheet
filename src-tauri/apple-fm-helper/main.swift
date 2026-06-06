// Apple Foundation Models helper for the Hot Sheet Announcer (HS-8790).
//
// The Node server can't call Apple's native `FoundationModels` framework, so it
// shells out to this tiny Swift CLI (see `src/announcer/appleFoundation.ts`).
// Because the *server* runs it, on-device summarization works in both the manual
// "Listen" path and the live-mode generator — no client round-trip needed.
//
// Protocol:
//   apple-fm-helper --probe       → prints "available" or "unavailable" (exit 0)
//   apple-fm-helper --summarize   → reads {"system","material"} JSON on stdin,
//                                    writes {"entries":[{title,script,emphasis}]}
//                                    JSON on stdout (exit 0)
//
// Uses **guided generation** (`@Generable`) so the model output is structurally
// guaranteed — the equivalent of the Anthropic path's `output_config` JSON schema
// — then re-encodes to the exact `{entries:[…]}` wire shape the server expects.
//
// Requires macOS 26+ with Apple Intelligence (FoundationModels). Build + sign via
// scripts/build-apple-fm-helper.sh; bundle it with the app and point the server
// at it with HOTSHEET_APPLE_FM_BIN (docs/tauri-architecture.md). NOT compiled by
// cargo — it's a standalone executable.
import Foundation
import FoundationModels

// MARK: - Guided-generation schema (what the model must produce)

@Generable
struct GeneratedEntry {
    @Guide(description: "A short title — a few words.")
    var title: String
    @Guide(description: "One or two short spoken sentences (under 30 words). Terse, plain, no markdown.")
    var script: String
    @Guide(description: "Zero to two short key phrases copied verbatim from the script; empty if nothing stands out.")
    var emphasis: [String]
}

@Generable
struct GeneratedReel {
    @Guide(description: "1 to 4 narrated entries; prefer fewer, broader entries. Empty if nothing meaningful happened.")
    var entries: [GeneratedEntry]
}

// MARK: - Wire types (stdin in / stdout out)

struct SummarizeInput: Decodable {
    let system: String
    let material: String
}

struct OutEntry: Encodable {
    let title: String
    let script: String
    let emphasis: [String]
}

struct OutReel: Encodable {
    let entries: [OutEntry]
}

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

/// Print on-device model availability and exit.
private func probe() -> Never {
    switch SystemLanguageModel.default.availability {
    case .available:
        print("available")
    default:
        print("unavailable")
    }
    exit(0)
}

/// Read {system, material} from stdin, run one guided on-device summarization,
/// print `{entries:[…]}` JSON to stdout.
private func summarize() async -> Never {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let input = try? JSONDecoder().decode(SummarizeInput.self, from: data) else {
        fail("invalid input: expected {\"system\",\"material\"} JSON on stdin", code: 2)
    }
    guard case .available = SystemLanguageModel.default.availability else {
        fail("Apple Foundation Models unavailable", code: 3)
    }
    do {
        let session = LanguageModelSession(instructions: input.system)
        let response = try await session.respond(to: input.material, generating: GeneratedReel.self)
        let reel = OutReel(entries: response.content.entries.map {
            OutEntry(title: $0.title, script: $0.script, emphasis: $0.emphasis)
        })
        let json = try JSONEncoder().encode(reel)
        print(String(decoding: json, as: UTF8.self))
        exit(0)
    } catch {
        fail("inference failed: \(error)", code: 4)
    }
}

let args = CommandLine.arguments
if args.contains("--probe") {
    probe()
} else if args.contains("--summarize") {
    // Run the async work, then park the main thread; `summarize()` calls exit()
    // when done, which terminates the process.
    Task { await summarize() }
    dispatchMain()
} else {
    fail("usage: apple-fm-helper --probe | --summarize", code: 64)
}
