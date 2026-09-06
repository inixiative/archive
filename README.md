# Archive

Local-first, portable experience storage for agent work.

**Status: architecture and product exploration.** This repository describes the intended product; the capabilities below are proposed, not implemented here. Private while the architecture takes shape.

## The problem

Agent sessions contain decisions, failed approaches, human corrections, and context that often disappear into provider-specific histories. GitHub preserves the resulting code and review; Linear preserves task intent. Neither alone preserves the full experience of doing the work.

We want that experience to remain queryable across providers and machines, shareable with a team when appropriate, and useful to future agents. The immediate purpose is to support retrospectives that reduce repeated human correction.

## The product

Archive has two cooperating parts:

- **A local daemon** that discovers and extracts supported agent session logs, preserves source records, associates them with work context, and makes them directly queryable on the machine.
- **A shared server** that receives selected records when connected, allowing authorized people and agents to use shared experience across machines and teams.

Users should be able to bring their own storage infrastructure. The proposed distribution includes a native daemon and a working Docker Compose deployment for the shared service. A hosted management application could configure destinations, tags, members, accounts, and device access. A managed service may also be offered; pricing and the free/paid boundary are undecided.

Archive should be useful on its own and serve as a context component of [Kastle](https://github.com/inixiative/kastle).

## Intended capabilities

### Capture and provenance

- Import sessions from supported native agent harnesses, starting with Claude Code and Codex.
- Use provider-specific adapters for available logs, exports, APIs, or session extraction rather than assuming one universal format.
- Preserve original source records alongside normalized representations and track import provenance and adapter versions.
- Support incremental ingestion, deduplication, and restart-safe progress tracking.
- Retain available tool activity, corrections, and artifacts needed to understand how work happened, rather than reducing every session to a summary.

### Work context

Associate sessions and relevant events with repository identity, branches, commits, pull requests, Linear issues, and Atlas-style structural or concept tags where that information is available.

Distinguish explicit associations from inferred ones. Preserve evidence for inferred links so they can be reviewed and corrected. GitHub and Linear APIs or MCP interfaces can supply complementary records; access must be configured for each deployment.

### Local query and selective sync

Local data should be directly queryable without requiring the shared server. Capture should continue offline, with selected records synced when connectivity returns.

A machine may connect to personal and work Archives. A session's destination may be neither, either, or both, subject to explicit routing and access policies. Source selection for queries and destination selection for writes are separate decisions.

The sync protocol needs stable identities, idempotent uploads, and clear behavior for edits, deletion, retention, and conflicts. Those semantics are design work still to be completed.

### Access and ownership

Shared deployments need membership, scoped query and write access, revocable device credentials, and deliberate handling of sensitive session content. Secret storage and encryption need an explicit design before implementation; sharing a destination must not require distributing an unrestricted administrator credential.

The content path and management service should have a clear boundary. Sending records directly to a user's own server is a desired deployment option.

## From records to useful experience

Archive stores the evidence used by an improvement process. It may also store derived lessons, summaries, and retrospective results, separately from original records and with their own provenance, scope, and versions.

For example:

1. A person corrects an agent for copying an incorrectly placed implementation.
2. The session is linked to the task, pull request, and resulting placement rule.
3. A retrospective derives a contextual lesson and cites those records.
4. A later task retrieves that lesson and receives it in its working context.
5. Subsequent review checks whether the same correction was needed again.

Storage and retrieval enable this loop; they do not by themselves establish that the agent improved.

## Relationship to the rest of Inixiative

| Component | Relationship to Archive |
| --- | --- |
| **[Kastle](https://github.com/inixiative/kastle)** | Connects personal and team Archives to capacity, policies, and improvement processes. |
| **[Foundry](https://github.com/inixiative/foundry)** | Produces agent executions and consumes relevant context while preserving native harness capabilities. |
| **[agent-session](https://github.com/inixiative/agent-session)** | Existing session execution and event work to evaluate for reuse; passive ingestion has additional requirements. |
| **[Atlas](https://github.com/inixiative/atlas)** | Provides structural and conceptual context that can help associate experience with the code it concerns. |
| **Signets** | The proposed scoped access layer for use within a Kastle. |

Archive should not require Foundry to have launched a session in order to ingest it. Supporting existing agent workflows is central to its usefulness.

## MVP and future features

The [goals and tickets](tickets/README.md) define the current release boundary. The intended capabilities above describe the broader product direction; they are not all MVP requirements.

The MVP consists of:

- Durable local storage.
- Remote storage across multiple Archive destinations.
- Direct local search.
- Search across all configured remotes.
- A sync service.
- Deployment locally and to a cloud resource, including a Docker Compose path.

Possession of a remote Archive URL grants access for MVP. Identity-based access, memberships, scoped permissions, and device credential management are future features.

Automatic provider-session capture, work-context enrichment, retrospective workflows, expanded operational lifecycle management, billing, and the hosted management site are marked **FF (future features)**. Multiple remote destinations are in scope; support for multiple storage technologies is deferred.

Storage technologies, schemas, API contracts, synchronization protocols, and implementation sequencing remain undecided. Archive is the working name; licensing and commercial terms remain undecided.
