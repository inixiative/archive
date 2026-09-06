# Archive goals and tickets

These tickets describe product goals and desired outcomes. They do not specify implementation, storage technologies, API contracts, synchronization protocols, or a build sequence.

## MVP

The initial scope is storage locally and in multiple remote Archives, local search, search across all configured remotes, a sync service, and deployment locally and to a cloud resource.

**Access model:** Possession of a remote Archive URL grants access for MVP. Accounts, memberships, scoped permissions, and device credential management are future features.

| Ticket | Goal | Status |
| --- | --- | --- |
| [ARC-009](ARC-009-local-storage.md) | Store information locally | MVP |
| [ARC-010](ARC-010-remote-storage.md) | Store information in multiple remote Archives | MVP |
| [ARC-003](ARC-003-local-retrieval.md) | Search the local Archive | MVP |
| [ARC-011](ARC-011-remote-search.md) | Search across all configured remotes | MVP |
| [ARC-004](ARC-004-shared-sync.md) | Sync local and remote Archives | MVP |
| [ARC-007](ARC-007-self-hosted-operation.md) | Deploy locally and to a cloud resource | MVP |

## MVP demonstration

Store content locally and in more than one remote Archive. Search the local store independently, search across the configured remotes, and retrieve matching content. Demonstrate synchronization across an interruption and successful operation in both local and cloud deployments.

## Future features

**FF = Future feature; outside MVP.** These goals remain useful but are not prerequisites for the initial release.

| Ticket | Goal | Status |
| --- | --- | --- |
| [ARC-001](ARC-001-source-coverage.md) | Assess provider-session coverage | FF |
| [ARC-002](ARC-002-session-capture.md) | Automatically discover and capture provider sessions | FF |
| [ARC-005](ARC-005-work-context.md) | Associate content with GitHub, Linear, and Atlas-style context | FF |
| [ARC-006](ARC-006-sharing-and-access.md) | Add sharing policies and scoped access | FF |
| [ARC-008](ARC-008-retrospective-proof.md) | Demonstrate retrospective usefulness | FF |
| [ARC-012](ARC-012-operational-lifecycle.md) | Extend backup, retention, deletion, and operational management | FF |

Billing, the Template-based hosted management site, multiple storage technologies, and automated application of lessons also remain future features. Multiple remote Archive destinations are explicitly in MVP; they do not imply multiple storage technologies.

## Longer-term purpose

Archive should make accumulated agent experience useful to future work and support an agent team that needs less repeated human correction. The MVP establishes the storage, search, and synchronization foundation. Session collection, enrichment, and retrospective workflows build on that foundation later.
