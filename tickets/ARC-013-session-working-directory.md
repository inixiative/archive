# ARC-013: Keep each session's working directory, and every branch it worked on

**Status:** FF — Future feature; outside MVP

## Why this matters

Oracle's harvest links a commit to the sessions that built it by the files they edited (PROSPECTOR-HARVEST §1, "How a session links"). A Codex `apply_patch` names its files relative to the session's working directory, and a snapshot doesn't keep that directory, so those edits can't be placed and Codex sessions link only by the commits they made or their branch. A long session also records only the branch it started on, so a session that moves into a worktree reads as `main`.

## Goal

Record, on each captured snapshot, the working directory the collector already reads (`sessionMetadata(...).cwd`) and, where the transcript shows them, the working directories and branches the session moved through, so a reader can resolve a relative path at the time it was written.

## Desired outcomes

- A relative tool-call path resolves against the directory in force when the call was made.
- Every branch a session worked on is a reference, not only the first.

## Questions to resolve

Per-entry working directory, or a list of (time, directory) changes on the snapshot?
