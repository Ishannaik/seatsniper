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
