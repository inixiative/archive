# ARC-004: Sync local and remote Archives

**Status:** MVP

## Goal

Provide a sync service that keeps local and configured remote Archives synchronized according to the chosen destinations.

## Desired outcomes

- Sync supports multiple remote Archives.
- Local storage remains usable while a remote is unavailable; synchronization can resume when it returns.
- Interrupted or repeated synchronization does not silently lose stored content or create duplicate copies of the same record.
- Users can tell whether synchronization has completed or needs attention.
