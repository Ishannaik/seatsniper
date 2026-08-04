#!/usr/bin/env bash
# SeatSniper — one-shot install for Linux / macOS
# curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh | bash
set -euo pipefail

REPO="${SEATSNIPER_REPO:-https://github.com/Ishannaik/seatsniper.git}"
DIR="${SEATSNIPER_DIR:-$HOME/seatsniper}"
BRANCH="${SEATSNIPER_BRANCH:-main}"

# cinema lobby palette
R=$'\033[0m'
B=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[38;5;196m'
AMB=$'\033[38;5;214m'
CREAM=$'\033[38;5;223m'
OK=$'\033[38;5;114m'
ERR=$'\033[38;5;203m'

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸%s %s%s%s\n' "$AMB" "$R" "$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
die()  { printf '%s✗ %s%s\n' "$ERR" "$*" "$R" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need \`$1\` on PATH"; }

banner() {
  printf '%s' "$RED"
  cat <<'EOF'

   ███████╗███████╗ █████╗ ████████╗
   ██╔════╝██╔════╝██╔══██╗╚══██╔══╝
   ███████╗█████╗  ███████║   ██║
   ╚════██║██╔══╝  ██╔══██║   ██║
   ███████║███████╗██║  ██║   ██║
   ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝
EOF
  printf '%s' "$AMB"
  cat <<'EOF'
   ███████╗███╗   ██╗██╗██████╗ ███████╗██████╗
   ██╔════╝████╗  ██║██║██╔══██╗██╔════╝██╔══██╗
   ███████╗██╔██╗ ██║██║██████╔╝█████╗  ██████╔╝
   ╚════██║██║╚██╗██║██║██╔═══╝ ██╔══╝  ██╔══██╗
   ███████║██║ ╚████║██║██║     ███████╗██║  ██║
   ╚══════╝╚═╝  ╚═══╝╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝

EOF
  printf '%s%s  BookMyShow opens → Discord DM. One install.%s\n' "$DIM" "$CREAM" "$R"
}

# curl|bash steals stdin — always talk to the real terminal
read_tty() {
  # sets REPLY
  if [[ -r /dev/tty ]]; then
    IFS= read -r REPLY </dev/tty || REPLY=
  else
    IFS= read -r REPLY || REPLY=
  fi
}

prompt() {
  # prompt VAR "label" [secret]
  local var="$1" label="$2" secret="${3:-}"
  local val="${!var-}"
  if [[ -n "${val}" ]]; then
    ok "$label (from env)"
    printf -v "$var" '%s' "$val"
    return
  fi
  if [[ ! -r /dev/tty && ! -t 0 ]]; then
    die "$var required — set the env var for non-interactive install"
  fi
  printf '  %s%s%s ' "$CREAM" "$label" "$R"
  if [[ "$secret" == secret ]]; then
    stty -echo </dev/tty 2>/dev/null || stty -echo 2>/dev/null || true
    read_tty
    val=$REPLY
    stty echo </dev/tty 2>/dev/null || stty echo 2>/dev/null || true
    printf '\n'
  else
    read_tty
    val=$REPLY
  fi
  [[ -n "$val" ]] || die "$label is required"
  printf -v "$var" '%s' "$val"
}

prompt_opt() {
  local var="$1" label="$2"
  local val="${!var-}"
  if [[ -n "${val}" ]]; then
    ok "$label (from env)"
    printf -v "$var" '%s' "$val"
    return
  fi
  if [[ ! -r /dev/tty && ! -t 0 ]]; then
    printf -v "$var" ''
    return
  fi
  printf '  %s%s%s %s(optional, enter to skip)%s ' "$CREAM" "$label" "$R" "$DIM" "$R"
  read_tty
  printf -v "$var" '%s' "$REPLY"
}

ensure_bun() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun >/dev/null 2>&1; then
    ok "Bun $(bun --version)"
    return
  fi
  say "  installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun install finished but \`bun\` not on PATH"
  ok "Bun $(bun --version)"
}

clone_or_update() {
  if [[ -d "$DIR/.git" ]]; then
    say "  updating $DIR …"
    git -C "$DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$DIR" checkout -q "$BRANCH"
    git -C "$DIR" reset --hard -q "origin/$BRANCH"
    ok "updated → $BRANCH"
  elif [[ -d "$DIR" ]]; then
    die "$DIR exists but is not a git repo — set SEATSNIPER_DIR or move it"
  else
    say "  cloning into $DIR …"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
    ok "cloned"
  fi
}

write_env() {
  local envf="$DIR/.env"
  if [[ -f "$envf" ]]; then
    if [[ -r /dev/tty || -t 0 ]]; then
      printf '  %s.env exists — overwrite? [y/N]%s ' "$AMB" "$R"
      read_tty
      if [[ ! "${REPLY:-}" =~ ^[Yy]$ ]]; then
        ok "keeping existing .env"
        return
      fi
    else
      ok "keeping existing .env (non-interactive)"
      return
    fi
  fi
  umask 077
  {
    printf 'DISCORD_TOKEN=%s\n' "$DISCORD_TOKEN"
    printf 'DISCORD_CLIENT_ID=%s\n' "$DISCORD_CLIENT_ID"
    if [[ -n "${DISCORD_GUILD_ID:-}" ]]; then
      printf 'DISCORD_GUILD_ID=%s\n' "$DISCORD_GUILD_ID"
    fi
  } >"$envf"
  ok "wrote .env (mode 600)"
}

start_bot() {
  cd "$DIR"
  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe seatsniper >/dev/null 2>&1; then
      pm2 restart seatsniper --update-env
    else
      pm2 start "$BUN_INSTALL/bin/bun" --name seatsniper --interpreter none --time -- run src/index.ts
    fi
    pm2 save >/dev/null 2>&1 || true
    ok "running under pm2 as \`seatsniper\`"
    say "  ${DIM}pm2 logs seatsniper${R}"
  else
    ok "deps ready — start with:"
    say "  ${B}cd $DIR && bun run start${R}"
    say "  ${DIM}(install pm2 for background: npm i -g pm2)${R}"
  fi
}

main() {
  banner
  need curl
  need git

  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) die "Linux or macOS only (Windows: use WSL)" ;;
  esac

  step "Runtime"
  ensure_bun

  step "Source"
  clone_or_update

  step "Discord credentials"
  say "  ${DIM}https://discord.com/developers/applications → your app → Bot / OAuth2${R}"
  DISCORD_TOKEN="${DISCORD_TOKEN:-}"
  DISCORD_CLIENT_ID="${DISCORD_CLIENT_ID:-}"
  DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-}"
  prompt DISCORD_TOKEN "Bot token" secret
  prompt DISCORD_CLIENT_ID "Application (client) ID"
  prompt_opt DISCORD_GUILD_ID "Guild ID for instant slash commands"
  write_env

  step "Dependencies"
  cd "$DIR"
  bun install
  ok "packages installed"

  step "Slash commands"
  bun run commands
  ok "registered"

  step "Launch"
  start_bot

  printf '\n%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$AMB" "$R"
  printf '%s  Armed.%s Invite the bot:\n' "$B" "$R"
  printf '  %shttps://discord.com/oauth2/authorize?client_id=%s&scope=bot%%20applications.commands%s\n' \
    "$CREAM" "$DISCORD_CLIENT_ID" "$R"
  printf '\n  Then in Discord:  %s/watch%s  paste a BookMyShow link\n' "$B" "$R"
  printf '  Subs:               %s/watch%s … %sdate:any%s  (new dates + new cinemas)\n\n' "$B" "$R" "$AMB" "$R"
}

main "$@"
