// Envelope types for the triage flow (M4.2).
//
// triage(thread_id) returns a TriagePlan: a structured proposal that the LLM
// surfaces to the user. After confirmation, triage_commit(token) executes the
// per-leg writes with deterministic-UID idempotency. triage_commit_retry(spec)
// retries individual failed legs after the 10-min token window expires.
//
// The shape is locked by the M4.2 eng review (2026-04-30).

import type { ResolvedIdentity } from "../utils/identity.js";

// ── Proposal envelope (returned by `triage`) ──

export interface ProposedReminder {
  title: string;
  due?: string; // ISO local
  list?: string; // reminder list display name; default = primary
  idempotencyKey: string;
}

export interface ProposedEvent {
  title: string;
  start: string; // ISO local
  end: string; // ISO local
  attendees: string[]; // canonical emails
  calendar?: string; // calendar display name; default = primary
  idempotencyKey: string;
}

export interface ProposedDraft {
  to: string[]; // canonical emails (post-resolveIdentity)
  subject: string;
  body: string;
  idempotencyKey: string;
}

export type TriageConflict =
  | { kind: "calendar_overlap"; eventUid: string; summary: string; blocking: false }
  | { kind: "duplicate_reminder"; reminderUid: string; summary: string; blocking: false }
  | { kind: "unresolved_contact"; name: string; blocking: true };

export interface TriagePlan {
  thread: { uid: number; folder: string; subject: string; snippet: string };
  proposed: {
    reminder?: ProposedReminder;
    event?: ProposedEvent;
    draft?: ProposedDraft;
    contacts: ResolvedIdentity[];
  };
  /** Signed token; verify against the same proposal via confirm-token. */
  confirmToken: string;
  conflicts: TriageConflict[];
}

// ── Commit envelope (returned by `triage_commit` and `triage_commit_retry`) ──

export type CommitLegResult =
  | {
      leg: "reminder";
      status: "created" | "replayed_existing";
      uid: string;
      etag: string;
      idempotencyKey: string;
    }
  | {
      leg: "event";
      status: "created" | "replayed_existing";
      uid: string;
      etag: string;
      idempotencyKey: string;
    }
  | {
      leg: "draft";
      status: "appended" | "replayed_existing";
      /** Optional: only populated when iCloud IMAP UIDPLUS returned the UID. SEARCH-by-Message-Id is the load-bearing path. */
      uid?: number;
      messageId: string;
      idempotencyKey: string;
    }
  | {
      leg: "reminder" | "event" | "draft";
      status: "failed";
      error: string;
      idempotencyKey: string;
      /** True when the failure is safe to retry via triage_commit_retry. */
      retrySafe: true;
    };

export interface CommitResult {
  results: CommitLegResult[];
  /** True when at least one leg failed. The user should triage_commit_retry the failed legs. */
  partial: boolean;
}

// ── Retry input (for `triage_commit_retry`) ──

export interface RetrySpec {
  legs: ("reminder" | "event" | "draft")[];
  payload: {
    reminder?: ProposedReminder;
    event?: ProposedEvent;
    draft?: ProposedDraft;
  };
}
