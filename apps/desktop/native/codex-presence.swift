import AppKit

// The only supported query is the fixed local application. Reject arguments before AppKit lookup.
guard CommandLine.arguments.count == 1 else { exit(64) }
let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
    .contains { !$0.isTerminated }
print(running ? "running" : "not-detected")
