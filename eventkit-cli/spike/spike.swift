import EventKit
import Foundation

// TCC + EventKit feasibility spike for icloud-mcp v3.
// Goal: prove an ad-hoc-built Swift CLI can get Reminders permission and read a smart list.
// Run: swift spike.swift
// Expected first run: macOS shows TCC prompt for Reminders. Approve.
// Expected subsequent runs: no prompt, returns JSON with reminder lists + sample.

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
var accessError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, err in
        granted = ok
        accessError = err
        sema.signal()
    }
} else {
    store.requestAccess(to: .reminder) { ok, err in
        granted = ok
        accessError = err
        sema.signal()
    }
}

// Timeout after 30s in case TCC never prompts (e.g. binary not entitled at all).
let waited = sema.wait(timeout: .now() + 30)

func emit(_ obj: [String: Any], exit code: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(code)
}

if waited == .timedOut {
    emit([
        "ok": false,
        "stage": "tcc_prompt",
        "error": "TCC request timed out after 30s. Likely cause: ad-hoc-signed CLI cannot present TCC prompt. May need .app bundle wrapper or developer signing.",
        "macosVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    ], exit: 2)
}

if let e = accessError {
    emit([
        "ok": false,
        "stage": "tcc_request",
        "error": "\(e)",
        "errorType": String(describing: type(of: e)),
    ], exit: 3)
}

if !granted {
    emit([
        "ok": false,
        "stage": "tcc_denied",
        "error": "User denied Reminders access OR TCC silently rejected without prompt. Check: System Settings > Privacy & Security > Reminders.",
    ], exit: 4)
}

// Access granted — try to actually read reminder lists and reminders.
let calendars = store.calendars(for: .reminder)
let predicate = store.predicateForIncompleteReminders(
    withDueDateStarting: nil,
    ending: nil,
    calendars: nil
)

var reminders: [EKReminder] = []
let fetchSema = DispatchSemaphore(value: 0)
store.fetchReminders(matching: predicate) { results in
    reminders = results ?? []
    fetchSema.signal()
}
let fetchWaited = fetchSema.wait(timeout: .now() + 10)

if fetchWaited == .timedOut {
    emit([
        "ok": false,
        "stage": "fetch_reminders",
        "error": "fetchReminders timed out after 10s",
    ], exit: 5)
}

let listsOut = calendars.map { cal -> [String: Any] in
    [
        "title": cal.title,
        "id": cal.calendarIdentifier,
        "type": "\(cal.type.rawValue)",
        "source": cal.source.title,
    ]
}

let samples = reminders.prefix(3).map { r -> [String: Any] in
    var due: String? = nil
    if let comp = r.dueDateComponents, let date = Calendar.current.date(from: comp) {
        due = ISO8601DateFormatter().string(from: date)
    }
    return [
        "title": r.title ?? "(untitled)",
        "completed": r.isCompleted,
        "list": r.calendar?.title ?? "(no list)",
        "due": due ?? NSNull(),
        "hasSubtasks": (r.value(forKey: "subtasks") as? [Any])?.isEmpty == false,
    ] as [String: Any]
}

let swiftAPI: String
if #available(macOS 14.0, *) {
    swiftAPI = "requestFullAccessToReminders"
} else {
    swiftAPI = "requestAccess(.reminder)"
}

emit([
    "ok": true,
    "stage": "complete",
    "macosVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    "swiftAPI": swiftAPI,
    "reminderListCount": calendars.count,
    "lists": listsOut,
    "incompleteReminderCount": reminders.count,
    "samples": samples,
])
