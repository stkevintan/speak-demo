#!/usr/bin/env bash
#
# Deploy Rehearsal to Fly.io.
#
# Creates the three apps, the SQLite volume and an Upstash Redis database,
# pushes the provider credentials from .env as Fly secrets, then deploys each
# app. Re-running is safe: existing apps, volumes and secrets are reused.
#
#   ./deploy/fly/deploy.sh
#   REGION=hkg ./deploy/fly/deploy.sh
#
# Credentials go straight from .env into `fly secrets set`; nothing secret is
# written to disk. See deploy/fly/README.md for the manual equivalent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

REGION="${REGION:-sin}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
REDIS_NAME="${REDIS_NAME:-rehearsal-redis}"
VOLUME_NAME="rehearsal_api_data"

info() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Read `app = "..."` out of a fly.*.toml.
app_name() {
  sed -n 's/^[[:space:]]*app[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n1
}

# Read KEY=value from .env, tolerating surrounding quotes.
env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | tail -n1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

require_env() {
  local value
  value="$(env_value "$1")"
  [ -n "$value" ] || die "$1 is missing from $ENV_FILE"
  # Catch .env.example placeholders before they become a running deployment
  # that fails at the first LiveKit connection instead of at deploy time.
  case "$value" in
    *replace-with*|*your-livekit-host*)
      die "$1 is still the placeholder from .env.example; set a real value in $ENV_FILE"
      ;;
  esac
  printf '%s' "$value"
}

app_exists() { fly apps list 2>/dev/null | grep -qw "$1"; }

ensure_app() {
  if app_exists "$1"; then
    info "app $1 already exists"
  else
    info "creating app $1"
    fly apps create "$1" ||
      die "could not create '$1' -- app names are global, so if it is taken, rename it in the matching fly.*.toml"
  fi
}

# --- preflight ---------------------------------------------------------------

command -v fly >/dev/null 2>&1 || die "flyctl not found: https://fly.io/docs/flyctl/install/"
fly auth whoami >/dev/null 2>&1 || die "not logged in; run: fly auth login"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; copy .env.example to .env and fill it in"

WEB_APP="$(app_name fly.web.toml)"
API_APP="$(app_name fly.api.toml)"
AGENT_APP="$(app_name fly.agent.toml)"
for name in "$WEB_APP" "$API_APP" "$AGENT_APP"; do
  [ -n "$name" ] || die "could not read app names from fly.*.toml"
done

info "region $REGION | web $WEB_APP | api $API_APP | agent $AGENT_APP"

# --- credentials -------------------------------------------------------------
#
# Only these specific keys are pushed, and never the whole .env: the local file
# sets DEV_AUTH_ENABLED=true (which config.ts refuses to boot with under
# NODE_ENV=production), NODE_ENV=development, HOST=127.0.0.1 and a localhost
# REDIS_URL. A blanket `fly secrets import < .env` would break all four.

JWT_SECRET_VALUE="$(env_value JWT_SECRET)"
if [ -z "$JWT_SECRET_VALUE" ]; then
  JWT_SECRET_VALUE="$(openssl rand -base64 48 | tr -d '\n')"
  info "JWT_SECRET was empty in .env, generated a new one"
fi
# config.ts rejects anything shorter, and changing it later invalidates every
# existing session.
[ "${#JWT_SECRET_VALUE}" -ge 32 ] ||
  die "JWT_SECRET must be at least 32 characters"

LIVEKIT_URL_VALUE="$(require_env LIVEKIT_URL)"
LIVEKIT_API_KEY_VALUE="$(require_env LIVEKIT_API_KEY)"
LIVEKIT_API_SECRET_VALUE="$(require_env LIVEKIT_API_SECRET)"

if [ -n "${REDIS_URL:-}" ]; then
  REDIS_URL_VALUE="$REDIS_URL"
  info "using REDIS_URL from the environment"
else
  # Deliberately not read from .env: that file points at a local Redis.
  if fly redis status "$REDIS_NAME" >/dev/null 2>&1; then
    info "Redis database $REDIS_NAME already exists"
  else
    info "creating Redis database $REDIS_NAME ($REGION)"
    fly redis create --name "$REDIS_NAME" --region "$REGION" --plan pay-as-you-go --no-replicas
  fi
  REDIS_URL_VALUE="$(fly redis status "$REDIS_NAME" 2>/dev/null |
    grep -oE 'rediss?://[^[:space:]]+' | head -n1)"
  [ -n "$REDIS_URL_VALUE" ] ||
    die "could not read the Redis URL; re-run as: REDIS_URL=... ./deploy/fly/deploy.sh"
fi

# --- infrastructure ----------------------------------------------------------

ensure_app "$AGENT_APP"
ensure_app "$API_APP"
ensure_app "$WEB_APP"

if fly volumes list -a "$API_APP" 2>/dev/null | grep -qw "$VOLUME_NAME"; then
  info "volume $VOLUME_NAME already exists"
else
  info "creating volume $VOLUME_NAME (1 GB, $REGION)"
  fly volumes create "$VOLUME_NAME" -a "$API_APP" -r "$REGION" -s 1 -y
fi

# --stage writes the secrets without restarting anything, so they are already
# in place when the deploy below creates the Machines.
info "pushing secrets to $API_APP"
fly secrets set --stage -a "$API_APP" \
  JWT_SECRET="$JWT_SECRET_VALUE" \
  REDIS_URL="$REDIS_URL_VALUE" \
  LIVEKIT_URL="$LIVEKIT_URL_VALUE" \
  LIVEKIT_API_KEY="$LIVEKIT_API_KEY_VALUE" \
  LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET_VALUE" \
  WEB_ORIGIN="https://$WEB_APP.fly.dev"

info "pushing secrets to $AGENT_APP"
fly secrets set --stage -a "$AGENT_APP" \
  REDIS_URL="$REDIS_URL_VALUE" \
  LIVEKIT_URL="$LIVEKIT_URL_VALUE" \
  LIVEKIT_API_KEY="$LIVEKIT_API_KEY_VALUE" \
  LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET_VALUE"

COACH_API_KEY_VALUE="$(env_value COACH_API_KEY)"
if [ -n "$COACH_API_KEY_VALUE" ]; then
  fly secrets set --stage -a "$AGENT_APP" COACH_API_KEY="$COACH_API_KEY_VALUE"
fi

# --- deploy ------------------------------------------------------------------
#
# No -a here: each config names its own app, so the two can never disagree.
# --ha=false keeps Fly from leaving a stopped standby Machine behind, which
# would double the bill for no benefit at this size.
#
# The agent goes first so it is already registered with LiveKit by the time the
# API starts handing out room tokens; the web app goes last because it is the
# only one that takes public traffic.

info "deploying $AGENT_APP"
fly deploy --config fly.agent.toml --ha=false

info "deploying $API_APP"
fly deploy --config fly.api.toml --ha=false

info "deploying $WEB_APP"
fly deploy --config fly.web.toml --ha=false

info "done -- https://$WEB_APP.fly.dev"
printf 'Watch the logs with:\n  fly logs -a %s\n  fly logs -a %s\n' "$API_APP" "$AGENT_APP"
