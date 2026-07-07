# EventKit TCC Spike

30-minute feasibility spike (2026-04-28) for icloud-mcp v3's EventKit integration.

## Goal

Validate whether an ad-hoc-signed Swift CLI can get Reminders TCC permission on macOS — before committing weeks to M2 (the Swift EventKit CLI milestone).

## Result

**Negative.** Across all five tested configurations (CLI binary alone, CLI binary with embedded Info.plist via `-sectcreate`, .app bundle, .app bundle with explicit reminders + calendars entitlements, all of the above detached from the parent process), `EKEventStore.requestFullAccessToReminders` returned `granted=false` with no error and no TCC prompt presented to the user.

See `spike-result.json` for the structured artifact and the parent design doc's "TCC SPIKE RESULT" section.

## Implication

ad-hoc-signed binaries cannot get Reminders TCC permission on macOS 26.4 (and likely 14+). Any path forward for EventKit access requires a paid Apple Developer Program membership (currently $99/year) for Developer ID signing + notarytool notarization.

The v3 design dropped EventKit entirely (cloud-only path). v4 may revisit with a dev cert. See `TODOS.md` v4 entry for the full plan.

## Files

- `spike.swift` — minimal Swift program: `EKEventStore.requestFullAccessToReminders` + list reminders + JSON output
- `Info.plist` — embedded via `-sectcreate __TEXT __info_plist`. Contains `NSRemindersFullAccessUsageDescription`, `NSRemindersUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `CFBundleIdentifier`
- `entitlements.plist` — `com.apple.security.personal-information.reminders=true`, `com.apple.security.personal-information.calendars=true`, `app-sandbox=false`
- `spike-result.json` — structured findings

## Reproducing

```bash
cd eventkit-cli/spike

# Compile with embedded Info.plist
swiftc -o icloud-eventkit-spike spike.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist

# Build .app bundle
mkdir -p icloud-eventkit-spike.app/Contents/MacOS
cp icloud-eventkit-spike icloud-eventkit-spike.app/Contents/MacOS/
cp Info.plist icloud-eventkit-spike.app/Contents/

# Sign ad-hoc with entitlements
codesign --force --sign - --entitlements entitlements.plist --deep icloud-eventkit-spike.app

# Run
./icloud-eventkit-spike.app/Contents/MacOS/icloud-eventkit-spike
```

Expected output: `{"ok": false, "stage": "tcc_denied", ...}` exit code 4.

## Future use

If you ever pay for an Apple Developer cert, redo this spike with `codesign -s "Developer ID Application: <Your Name>"` instead of `-s -` and verify the prompt appears. That confirms the v4 path works before sinking weeks into the Swift CLI.
