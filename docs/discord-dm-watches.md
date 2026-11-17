# Private Discord movie watches

The optional `src/doomsday-cloud.ts` entry point supports normal DM commands and
`/watch`, `/list`, `/stop`, `/help` for BookMyShow and District movie links.
Each Discord account has its own persistent watch namespace, five-watch limit,
filters and private alerts. Watch IDs are local to that account. `stop all`
affects only the sender. Guild commands direct users to a private DM.

```text
watch <movie link> date:2026-12-18 time:18:30 theatre:"Oberoi Mall" format:PXL
list
stop 1
stop all
help
```

Replace `<movie link>` with an official movie URL. Date is required unless in
the URL. Times are IST. Time, theatre and format are optional; `after:18:00
before:23:00` can replace exact time. Each watch sends one matching-show alert
with an official booking link and completes. Seat availability and final prices
must be checked on the booking page. Watch commands do not hold seats or pay.

## Run

Install Bun and dependencies as in the main README. Set `DISCORD_TOKEN` and
`DISCORD_CLIENT_ID`, register commands with `bun run commands`, then start:

```sh
bun src/doomsday-cloud.ts
```

Run only one gateway process for the same bot token; stop the original
`src/index.ts` process before using this alternative entry point. Configure
`MONITOR_STATE_DIR` to a persistent, service-owned private directory. Each user's
state lives in `users/<Discord user ID>/dm-watches.json`, mode 600. The original
owner's root state is preserved in place when `DISTRICT_BOOKING_OWNER_ID` is set.
Never expose state files, tokens, phone numbers or booking sessions publicly.

Allow users to DM the bot (they may need to share a server and enable DMs).
Install the bot with the `bot` and `applications.commands` scopes. Guild channel
message permissions are not required for private watches. A disabled DM is
retried with backoff and does not prevent other users receiving alerts.

Checks run every 30 seconds after each completed check; provider or delivery
failures use exponential backoff and respect longer provider retry hints.
Creation validates the live provider. Actual returned show dates must match;
HTTP success or an echoed date alone is insufficient. BookMyShow format child
listings are checked when needed. TLS defaults to Safari; rotate only measured
Safari/Firefox profiles through `BMS_TLS_PROFILE` if necessary. Do not add
mismatched headers or use Chrome profiles. Native `node-tls-client` must remain
external when bundling this entry point.

Legacy hard-coded movie monitoring is disabled by default and runs only when
`LEGACY_DOOMSDAY_ENABLED=true`. Optional District `/book`, voice tests, reminders,
login, holds and payment controls stay restricted to the configured owner; this
change does not share the owner's District session with other Discord users.

## Screen formats

Use `format:PXL`, `format:IMAX`, `format:4DX`, `format:ScreenX`, `format:3D`
or `format:2D`. Other suggestions include MX4D, ICE, Dolby Atmos, Dolby Cinema,
RPX and VIP. Slash-command autocomplete includes PXL and IMAX dimensional options.

`format:PXL` accepts both PXL 2D and 3D. Use `format:"PXL 3D"` to require
PXL 3D, or `format:"IMAX 3D"` to require IMAX 3D. `format:PXL,IMAX` accepts
either format, without ranking one over the other. With no format option, any
format can match. These filters use the provider's reported format metadata;
a missing or unrecognised label cannot be treated as a confirmed match.
