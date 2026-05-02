// Pure proposer helpers for the triage verb (M4.2).
//
// Triage analyzes the last message in a mail thread and decides what cross-
// service actions to propose. The decision logic lives here as pure functions
// so it's testable without spinning up the full verb context.
//
// Three signals drive the proposer:
//   - Action verb in last message  → propose a Reminder
//   - Explicit datetime in last message → propose an Event
//   - Question or request from a known correspondent → propose a Draft reply
//
// Both reminder + event allowed when both signals are present. Draft is
// independent of the other two: it's a "do you want to reply?" suggestion.

import * as chrono from "chrono-node";

// ── Action-verb detection ──

/**
 * Action verbs and phrases that signal "the sender wants you to do something."
 * Conservative list; expand based on dogfooding miss reports. Multi-word
 * phrases match as substrings (case-insensitive); single words match on word
 * boundaries to avoid "send" matching "sender".
 */
const ACTION_PHRASES: readonly string[] = [
  "please send",
  "please share",
  "please review",
  "please confirm",
  "please respond",
  "please reply",
  "please let me know",
  "please advise",
  "follow up",
  "ping me",
  "let me know",
  "looking forward",
  "circle back",
  "any update",
  "any updates",
  "could you",
  "can you",
  "would you",
  "send me",
  "send over",
  "share with me",
  "get back to me",
  "remind me",
  "don't forget",
  "make sure",
];

/**
 * True if the message body contains any action phrase. Case-insensitive
 * substring match. Returns false on empty input.
 */
export function detectActionVerb(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const phrase of ACTION_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

// ── Datetime detection (chrono-node + sanity bounds) ──

export interface ParsedDate {
  /** ISO 8601 string (local time, no Z suffix). */
  start: string;
  /** ISO 8601 string. Optional; chrono returns end only when explicit ("from 2pm to 3pm"). */
  end?: string;
  /** Verbatim slice of the input that was parsed. Useful for surfacing in the proposal. */
  matchedText: string;
}

/**
 * Parse natural-language datetime out of a message body using chrono-node.
 * Drops dates that are >365 days in the future or in the past — those are
 * usually misparses (e.g. "see you next Tuesday" with no year context).
 *
 * Returns null when no parseable datetime, or all candidates are out-of-bounds.
 */
export function detectDatetime(text: string, now: Date = new Date()): ParsedDate | null {
  if (!text) return null;
  const results = chrono.parse(text, now);
  if (results.length === 0) return null;

  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const earliest = now.getTime() - 60 * 60 * 1000; // tolerate "1h ago" wording in past
  const latest = now.getTime() + oneYearMs;

  for (const r of results) {
    const start = r.start?.date();
    if (!start) continue;
    const startMs = start.getTime();
    if (startMs < earliest || startMs > latest) continue;

    const end = r.end?.date();
    return {
      start: toLocalIso(start),
      end: end ? toLocalIso(end) : undefined,
      matchedText: r.text,
    };
  }
  return null;
}

/**
 * True if the message looks like a question or a request. Triggers on:
 *   - presence of '?'
 *   - any action phrase (covers "could you", "can you", "please ...")
 */
export function detectQuestionOrRequest(text: string): boolean {
  if (!text) return false;
  if (text.includes("?")) return true;
  return detectActionVerb(text);
}

// ── Helpers ──

/**
 * Convert a Date to a local-time ISO string (no Z suffix). Uses the system
 * timezone. Triage's downstream consumer (caldav) interprets this against the
 * timezone parameter passed to schedule/event, so emitting a system-local
 * string here is the right shape.
 */
function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
