# ARC-007: Make the work deployment usable and maintainable

**Status:** Proposed goal

## Why this matters

A storage service that requires frequent manual rescue adds to the supervision burden Archive is meant to reduce.

## Goal

Provide a local daemon, a Docker Compose deployment of the shared service on team-controlled infrastructure, and an API through which authorized consumers can use Archive.

## Desired outcomes

- The team can install and operate the initial deployment using documented steps.
- Stored experience survives routine service restarts and can be backed up and restored.
- Capture, sharing, and service failures are visible and understandable.
- The team can manage retention and remove stored experience deliberately.
- The initial deployment is useful without the hosted management site or the full Kastle system.

## Questions to resolve

Who will operate the first deployment, and what must be self-service for it to reduce rather than add work?
