# One-click self-host install

## Goal

Open-source friendly: one command installs SeatSniper on a Linux/macOS box with Bun, `.env`, slash commands, and optional pm2.

## Non-goals

- Docker
- Private / Oracle auto-deploy (later)
- Windows installer (WSL / manual setup is fine)

## Interface

```bash
curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh | bash
```

## Behaviour

1. Banner + require `curl`, `git`, bash; Linux or macOS.
2. Install Bun if missing (`curl …/bun.sh | bash`), put `~/.bun/bin` on PATH for the session.
3. Clone (or update) repo to `~/seatsniper` unless `SEATSNIPER_DIR` is set.
4. Prompt for `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`; optional `DISCORD_GUILD_ID`.
5. Write `.env` from answers (never echo token back).
6. `bun install` + `bun run commands`.
7. If `pm2` on PATH: start/restart `seatsniper` and `pm2 save`. Else print `bun run start`.
8. Print bot invite URL (`client_id` + bot scopes) and `/watch` tip.

## CI

Public workflow: checkout, setup-bun, `bun install`, `bun test`. No secrets.

## Docs

README leads with the one-liner; keep a short manual setup fallback.
