# ARC-002: Preserve the experience of doing agent work

**Status:** FF — Future feature; outside MVP

Automatic provider-session discovery and capture are future features. The MVP provides storage, search, sync, and deployment without requiring this collection workflow.

## Why this matters

The final code does not explain every failed approach, correction, or decision that produced it. Losing that experience forces people to supply the same judgment again.

## Goal

Capture supported agent sessions through the local daemon and retain the available evidence needed to understand the work as it happened.

## Desired outcomes

- Existing agent workflows can contribute experience without requiring Foundry to have launched them.
- Captured experience retains available human feedback, agent responses, and relevant tool activity with their source context.
- Ongoing work and completed work can be captured without routine manual exports.
- Interruptions and restarts do not silently lose previously captured experience.

## Questions to resolve

What information must remain available for someone to understand a correction, and what limitations do the source histories impose?

## 2026-09-20 implementation update

Explicit Claude/Codex import and exact-working-directory collection now run in standalone Archive, with a 30-second watch mode. Changed source files are re-read and deduplicated into immutable revisions. Partial files retry without replacing stored evidence. Native Foundry journal capture remains an integration. Automatic universal discovery and byte-offset ingestion checkpoints remain future work.
