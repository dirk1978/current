#!/usr/bin/env bash
# Interactive setup for Current: writes .env, optionally installs a systemd service.
# Safe to run again: existing answers are offered as defaults and kept if you just press Enter.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; R=$'\e[31m'; N=$'\e[0m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$R" "$N" "$*"; }
ask()  { # ask VAR "Question" [default] [secret]
  local var=$1 q=$2 def=${3:-} secret=${4:-} ans
  if [ -n "$def" ]; then
    if [ -n "$secret" ]; then q="$q ${D}[keep current]${N}"; else q="$q ${D}[$def]${N}"; fi
  fi
  if [ -n "$secret" ]; then read -rsp "$q: " ans; echo; else read -rp "$q: " ans; fi
  printf -v "$var" '%s' "${ans:-$def}"
}
yes() { local a; read -rp "$1 [y/N]: " a; [[ $a =~ ^[Yy] ]]; }
get() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 | sed "s/^['\"]\(.*\)['\"]\$/\1/" || true; }

say "${B}Current: national grid + home energy${N}"
say ""

# ---- Node ----
if ! command -v node >/dev/null; then
  warn "Node.js 22.5 or newer is needed (https://nodejs.org), or use Docker: docker compose up -d"
  exit 1
fi
NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=5)?1:0)')
[ "$NODE_OK" = 1 ] || { warn "Node.js $(node -v) is too old: 22.5 or newer is needed (it has SQLite built in)"; exit 1; }
ok "Node.js $(node -v)"
say ""

# ---- Octopus ----
say "${B}Octopus Energy${N} ${D}(optional: your electricity, gas, tariff and Home Mini live power)${N}"
say "Get your API key at https://octopus.energy/dashboard/new/accounts/personal-details/api-access"
OCT_KEY=$(get OCTOPUS_API_KEY); OCT_ACC=$(get OCTOPUS_ACCOUNT)
while :; do
  ask OCT_KEY "API key (leave empty to skip)" "$OCT_KEY" secret
  [ -z "$OCT_KEY" ] && { say "${D}Skipping Octopus${N}"; OCT_ACC=""; break; }
  if ACCS=$(node tools/check-login.mjs octopus "$OCT_KEY" 2>&1); then
    set -- $ACCS
    if [ $# -gt 1 ]; then ask OCT_ACC "That key sees accounts: $ACCS. Which one" "${OCT_ACC:-$1}"; else OCT_ACC=$1; fi
    ok "Octopus account $OCT_ACC"
    break
  fi
  warn "$ACCS"
  OCT_KEY=""
done
GAS_UNITS=$(get OCTOPUS_GAS_UNITS)
say ""

# ---- Ohme ----
say "${B}Ohme charger${N} ${D}(optional: uses your Ohme app login; Ohme has no official API, so this could break)${N}"
OHME_EMAIL=$(get OHME_EMAIL); OHME_PASSWORD=$(get OHME_PASSWORD)
while :; do
  ask OHME_EMAIL "Ohme email (leave empty to skip)" "$OHME_EMAIL"
  [ -z "$OHME_EMAIL" ] && { say "${D}Skipping Ohme${N}"; OHME_PASSWORD=""; break; }
  ask OHME_PASSWORD "Ohme password" "$OHME_PASSWORD" secret
  if CH=$(node tools/check-login.mjs ohme "$OHME_EMAIL" "$OHME_PASSWORD" 2>&1); then ok "Ohme: $CH"; break; fi
  warn "$CH"
  OHME_PASSWORD=""
done
say ""

# ---- Server ----
PORT=$(get PORT); ask PORT "Port for the server" "${PORT:-8092}"
TOKEN=$(get ACCESS_TOKEN)
[ -n "$TOKEN" ] || TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
LAN_URL=$(get LAN_URL); PUBLIC_URL=$(get PUBLIC_URL)
say ""
say "${B}Addresses for the Android app${N} ${D}(optional; the app tries the first, then the second)${N}"
say "${D}For use away from home, put the server behind a reverse proxy with HTTPS and enter that address.${N}"
ask PUBLIC_URL "Internet address, e.g. https://current.example.com" "$PUBLIC_URL"
ask LAN_URL "Home network address" "${LAN_URL:-${LAN_IP:+http://$LAN_IP:$PORT}}"

# ---- write .env (keeping any other settings already there) ----
q() { case "$1" in *[\ \'\"\$\`\\!\#]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")";; *) printf '%s' "$1";; esac; }
set_kv() {
  local k=$1 v; v=$(q "$2")
  if [ -f .env ] && grep -q "^$k=" .env; then
    local tmp; tmp=$(mktemp); awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm "$tmp"
  else printf '%s=%s\n' "$k" "$v" >> .env; fi
}
[ -f .env ] || { umask 077; : > .env; }
chmod 600 .env
set_kv ACCESS_TOKEN "$TOKEN"; set_kv PORT "$PORT"
set_kv OCTOPUS_API_KEY "$OCT_KEY"; set_kv OCTOPUS_ACCOUNT "$OCT_ACC"; [ -n "$GAS_UNITS" ] && set_kv OCTOPUS_GAS_UNITS "$GAS_UNITS"
set_kv OHME_EMAIL "$OHME_EMAIL"; set_kv OHME_PASSWORD "$OHME_PASSWORD"
set_kv PUBLIC_URL "$PUBLIC_URL"; set_kv LAN_URL "$LAN_URL"
mkdir -p data
ok "Saved settings to .env (readable only by you)"
say ""

# ---- systemd ----
if command -v systemctl >/dev/null && [ -d /etc/systemd/system ]; then
  if yes "Install and start it as a systemd service (needs sudo)?"; then
    sed -e "s|@USER@|$(id -un)|g" -e "s|@GROUP@|$(id -gn)|g" -e "s|@DIR@|$ROOT|g" -e "s|@NODE@|$(command -v node)|g" deploy/current.service \
      | sudo tee /etc/systemd/system/current.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable --now current.service
    sudo systemctl restart current.service
    ok "Service installed: sudo systemctl status current"
  else
    say "Start it yourself with: ${B}node --no-warnings server/server.mjs${N}"
  fi
fi
say ""
say "${B}Open it in a browser${N} (once; the key is then remembered):"
say "  http://${LAN_IP:-localhost}:$PORT/?key=$TOKEN"
say "The first start downloads a year of grid history and your meter data in the background, which takes a few minutes."
say "Android app: ${B}android/build.sh${N} (needs Docker)."
