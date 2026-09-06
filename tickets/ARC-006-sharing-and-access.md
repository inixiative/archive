# ARC-006: Make sharing intentional and access scoped

**Status:** FF — Future feature; outside MVP

For the MVP, possession of a remote Archive URL grants access. Membership, identity-based permissions, and device credential management are future features.

## Why this matters

Work and personal agent activity may coexist on a machine. Collecting local experience must not implicitly share it, and shared access must reflect the authority granted.

## Goal

Give users clear control over what enters the work Archive and give the team manageable, revocable access for people, agents, and devices.

## Desired outcomes

- Users can deliberately include or exclude work from sharing; unrelated personal activity is excluded by default.
- Collecting locally and sharing with a team are separate choices.
- An authorized participant can contribute or retrieve only the experience permitted to them.
- Device or participant access can be withdrawn without replacing access for everyone.

## Questions to resolve

What sharing choices and access distinctions are necessary for the initial UserEvidence deployment?
