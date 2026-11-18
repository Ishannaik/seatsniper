# Untangle SeatSniper — decision log

Skill: caldoai/skills `untangle-codebase`, revision 2e157218049708bf337717847bc1b2a971203e3f.
Scope: local structural refactor; no live server changes. Preserve provider transport
constraints, per-user privacy, existing file formats and explicit booking confirmation.
The user chose neither optional cleanup: existing comments and tests are retained.

## Decisions, with the problems they solve

1. Put shared movie models/date helpers and JSON/domain types below provider adapters.
   - Hidden link: District event reads and message presentation import runtime helpers
     from bms.ts, loading the unrelated native TLS transport.
   - Needless link: provider-neutral Show/Target/FormatChip live in bms.ts; stable
     watch/presentation code depends on a concrete provider.
   - Needless link: generic notification payloads import Json from authenticated MCP.
   - Keep old exports as compatibility boundaries; do not rewrite public behavior.
2. Own public movie reads and TLS lifecycle once per runtime, with explicit cycle caching.
   - Hidden link: per-user DmWatches calls process-global initBms/closeBms.
   - Hidden link: function identity decides whether injected reads need TLS or BMS
     format-child reads; tests and production use different implicit contracts.
   - Hidden link: caches stop at each user boundary, so identical public reads repeat.
   - Surplus: the gateway serializes all users despite per-user command serialization.
3. Make runtime-specific command definitions and DM option parsing one feature contract.
   - Hidden link: register.ts advertises events/subscriptions/weekdays/seats/budget
     while cloud DM handlers intentionally reject them; exact time is text-only.
   - Hidden link: slash autocomplete/help/registration maintain separate capability lists.
   - Preserve classic slash runtime capabilities and make DM registration explicit.
4. Separate Discord delivery and protocol-neutral HTTP cooldowns from movie monitoring.
   - Needless link: generic reminders/PVR import doomsday-monitor to send a DM.
   - Needless link: Discord/PVR polling depends on DistrictHttpError for Retry-After.
   - Keep recipient binding, receipt validation, no mutation retries and cooldown behavior.
5. Give the legacy movie policy a single owner below booking and polling code.
   - Hidden links: three-seat/price/format/date policy is copied across monitor,
     hold validation, renewal checks and PVR notifications.
   - Preserve the disabled-by-default legacy watch and exact existing policy values.
   - Retain exported descriptive policy fields for compatibility, rather than inventing
     new configurable behavior.
6. Classify seat/renewal notifications in one place.
   - Hidden links: reminders and voice independently inspect the same component IDs
     and expiry rendering; gateway acknowledgements maintain another action list.
   - Preserve current button identifiers, expiry/acknowledgement semantics and scopes.


7. Move booking session/application ownership below the Discord adapter.
   - Needless link: background monitors import hold preparation and expiry processing
     from district-booking-discord.ts, loading Interaction/modal rendering.
   - Hidden link: preview preparation and user confirmations must share one per-user
     lock and one cached connection/store owner; preserve that ownership explicitly.
   - Extract booking application functions without changing confirmation/payment
     transitions, persisted state, button IDs or compatibility exports.

8. Share watch quota/time policy and cycle mechanics without shared private state.
   - Hidden links: five-watch limits and IST calculations were independent copies.
   - Surplus: BMS and routed providers had separate promise-cache implementations.
   - One explicit ReadCycle coalesces reads; each polling cycle owns a fresh instance.
   - Stable polling no longer imports guest authentication just to use a scheduler.

## Special cases deliberately retained

- BookMyShow actual-show-date comparison and Safari/Firefox TLS transport constraints.
- District event vs movie schemas and BMS format-child events are provider requirements.
- Guest monitoring and personal booking sessions remain separate; no action retries.
- Legacy owner root-file mapping preserves existing private state without reassignment.
- Venue-scoped recliner metadata, partial-map warnings and exact-seat confirmation checks.
- Retry/backoff for failed reads/delivery and rate-limit guards for existing reminders.

## Verification

Baseline: 248 Bun tests pass; TypeScript and cloud bundle build pass.
Independent audit: watch/provider review and booking/notification review.
Final results and review findings will be appended after implementation.

Final result: all eight structural decisions above are implemented. The user chose
neither optional cleanup; no existing test was removed. Comments moved with the
code they document. Existing state schemas and old public export paths remain.

The independent watch/provider reviewer and booking/notification reviewer signed
off after a second pass. Their remaining findings (PVR's scheduler importing guest
auth and stale event-command guidance) were fixed and rechecked. No worthwhile
issues remain on the agreed structural list. Necessary external constraints and
legacy compatibility special cases are documented above.

Final checks: 260 tests passed across 28 files (1,891 assertions), TypeScript passed,
classic and DM Bun bundles built, and git diff whitespace checks passed. The
42-module local source graph has no dependency cycles; see dependencies.json.
Tests added cover shared native lifecycle, public-read coalescing across private
users, runtime command contracts, shared booking locking, recipient-bound delivery
and generic server cooldowns. No live server, credentials, registration or service
configuration was modified by this refactor.
