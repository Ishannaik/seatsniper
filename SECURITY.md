# Security Policy

SeatSniper observes a ticketing site and sends notifications. It never buys
tickets, holds seats, or automates checkout. Issues that matter here are leaks
of Discord tokens or database contents, and anything that lets the bot act
beyond reading public showtimes.

## Reporting a vulnerability

Open a GitHub issue, or email the maintainers directly if you believe the
issue is sensitive. Include:

- The affected version or commit
- Steps to reproduce
- What you expected to happen and what happened instead

Do not open a public issue that exposes a live Discord token.

## Scope

- `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` must stay out of the repository and
  the image. Never commit a `.env` file.
- The database file holds Discord user IDs and BookMyShow event codes. Treat
  `seatsniper.db` as private.
- The bot only sends what BookMyShow already serves publicly. A bug here is a
  wrong notification, not an unauthorized purchase.


## Personal District booking

The optional `/book` integration uses District's official authenticated connector.
It can place real holds and initiate payments after the configured owner confirms
District's exact summaries. Report unintended writes, cross-user account access,
confirmation replay and duplicate payment attempts as security issues.

Keep `.runtime/`, `.env` and `DISTRICT_STATE_DIR` private. They can contain District
bearer/refresh tokens, session IDs and booking/cart context as well as the Discord
token. Never publish them or include them in logs, screenshots or deployment
archives. Phone numbers and OTPs are sent to District only for the owner-initiated
login and are not persisted by the bot. Never include live credentials in an issue.
