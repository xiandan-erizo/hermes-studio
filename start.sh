#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SSO_ENV_FILE="${HERMES_STUDIO_SSO_ENV_FILE:-/etc/hermes-webui/oidc.env}"
BACKEND_PORT="${PORT:-8647}"

if [[ ! -r "$SSO_ENV_FILE" ]]; then
  echo "SSO config is not readable: $SSO_ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SSO_ENV_FILE"
set +a

for key in HERMES_SSO_ISSUER HERMES_SSO_CLIENT_ID HERMES_SSO_CLIENT_SECRET; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required SSO setting: $key" >&2
    exit 1
  fi
done

cd "$ROOT_DIR"
npm run build
node bin/hermes-web-ui.mjs stop --port "$BACKEND_PORT" >/dev/null 2>&1 || true
exec node bin/hermes-web-ui.mjs start --port "$BACKEND_PORT" --no-open
