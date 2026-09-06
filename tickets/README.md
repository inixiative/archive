# Archive goals and tickets

These tickets describe the high-level goals for Archive's first work deployment at UserEvidence. They capture problems, intended outcomes, and unresolved product questions. They are not implementation specifications, and their numbering does not prescribe a build sequence.

## Purpose

Human corrections should become usable experience for future agent work. The first release should make real sessions available locally and to authorized teammates, connect that experience to the work it concerns, and support a simple retrospective with traceable evidence.

## Initial goals

| Ticket | Goal | Status |
| --- | --- | --- |
| [ARC-001](ARC-001-source-coverage.md) | Understand where the useful experience lives | Proposed |
| [ARC-002](ARC-002-session-capture.md) | Preserve the experience of doing agent work | Proposed |
| [ARC-003](ARC-003-local-retrieval.md) | Make local experience directly useful | Proposed |
| [ARC-004](ARC-004-shared-sync.md) | Carry selected experience across machines and teammates | Proposed |
| [ARC-005](ARC-005-work-context.md) | Connect sessions to the work they concern | Proposed |
| [ARC-006](ARC-006-sharing-and-access.md) | Make sharing intentional and access scoped | Proposed |
| [ARC-007](ARC-007-self-hosted-operation.md) | Make the work deployment usable and maintainable | Proposed |
| [ARC-008](ARC-008-retrospective-proof.md) | Demonstrate that captured experience supports learning | Proposed |

## First complete demonstration

A real work session is captured and can be retrieved locally. Selected experience becomes available to an authorized teammate after an offline/reconnect cycle. A retrospective can then cite an actual human correction and relate it to the available task and outcome context.

That demonstrates a useful evidence path. Whether later agents require fewer repeated corrections remains the broader outcome to establish.

## Scope boundary

The work deployment centers on the daemon, a self-hosted shared service distributed through Docker Compose, and programmatic access. The long-term direction includes a Template-based hosted experience within Kastle, with Archive independently useful.

Billing, the hosted management site, multiple storage backends, advanced enrichment, multiple Archive routing, and automated application of lessons are outside this initial goal set. The first deployment does not depend on completing Foundry or Kastle.

Storage technologies, schemas, API contracts, synchronization protocols, and implementation sequencing remain undecided. These tickets should be refined through product discussion before implementation guidance is added.
