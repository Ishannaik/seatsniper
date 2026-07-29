# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New cinema alerts on subscriptions — notify when a new theatre or show format appears for a subscribed movie (in progress on `feature/new-cinema-alerts`).

## [0.1.0] - 2026-07-29

First public release. Discord bot that watches BookMyShow and DMs you when bookings open or a new date unlocks.

### Added

- Discord bot MVP: `/watch` a BookMyShow link and receive a DM when the requested date opens.
- Movie subscriptions (`date:any`) — ping when a *new* bookable date unlocks, tracked via a `seen_dates` ledger.
- Slash commands: `/watch`, `/list`, `/stop`, `/help` (5 watches per user cap).
- User-install and DM context command registration.
- BookMyShow client using Safari TLS fingerprint (`node-tls-client`) — verified on Oracle VPS.
- Deterministic availability detection via `showDateCode` field comparison (no HTML heuristics).
- SQLite storage (`bun:sqlite`) for watches and seen dates.
- Request coalescing — multiple watches on the same movie share one poll per cycle.
- Positive page identification and real movie title read from BMS responses.
- URL parsing hardening, stale watch expiry, and deduplicated show-time display.
- Design spec, BMS access findings, and spike documentation under `docs/superpowers/`.

### Changed

- Redesigned all Discord messages and embeds when subscriptions were added.

[Unreleased]: https://github.com/Ishannaik/seatsniper/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ishannaik/seatsniper/releases/tag/v0.1.0
