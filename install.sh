#!/usr/bin/env bash
#
# install.sh — one-shot installer for the Twin-Boiler Coal Power Plant Simulator
#              on Ubuntu Server (20.04 / 22.04 / 24.04 / 25.04).
#
#   sudo ./install.sh
#
# Options (environment variables):
#   APP_DIR=/opt/turbine-coal-simulator   where the simulator is installed
#   APP_USER=simulator                    unprivileged user that runs the service
#   PORT=8080                             HTTP port
#   ADMIN_PATH=/admin                     path of the hidden admin console
#   SKIP_NODE=1                           do not install Node.js (use the distro one)
#   NO_SERVICE=1                          install files but do not create the service
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/turbine-coal-simulator}"
APP_USER="${APP_USER:-simulator}"
PORT="${PORT:-8080}"
ADMIN_PATH="${ADMIN_PATH:-/admin}"
SKIP_NODE="${SKIP_NODE:-0}"
NO_SERVICE="${NO_SERVICE:-0}"
REPO="${REPO:-https://github.com/mikeehendricks/TurbineCoalSimulator.git}"
BRANCH="${BRANCH:-main}"

if [ "$(id -u)" -ne 0 ]; then
  echo "!! This installer must be run as root (try: sudo $0)" >&2
  exit 1
fi

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    %s\033[0m\n' "$*"; }

# --------------------------------------------------------------------------
say "Twin-Boiler Coal Power Plant Simulator — installer"
echo "    install dir : $APP_DIR"
echo "    service user: $APP_USER"
echo "    http port   : $PORT"
echo "    admin path  : $ADMIN_PATH"

# --------------------------------------------------------------------------
# Ubuntu 24.04 / 25.04 renamed a number of libraries to the "t64" ABI flavour
# and left the old names behind as *virtual* packages, which apt refuses to
# install ("E: Package 'libasound2' has no installation candidate").
# Resolve each package to the first name that really exists in the archive.
pick_pkg() {
  local c
  for c in "$@"; do
    if apt-cache show "$c" 2>/dev/null | grep -q '^Package: '; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# Each argument is a space-separated group of equivalent candidates.
resolve_groups() {
  local grp resolved skipped=()
  for grp in "$@"; do
    if resolved="$(pick_pkg $grp)"; then          # word splitting is intended
      printf '%s\n' "$resolved"
    else
      skipped+=("${grp%% *}")
    fi
  done
  if [ "${#skipped[@]}" -gt 0 ]; then
    printf '\033[1;33m    not in this archive, skipped: %s\033[0m\n' "${skipped[*]}" >&2
  fi
}

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

# Required by the simulator itself.
CORE_PKGS=(curl ca-certificates gnupg git rsync build-essential fonts-dejavu-core)
apt-get install -y --no-install-recommends "${CORE_PKGS[@]}"

# Headless-browser runtime libraries. These are only needed by the optional
# Puppeteer screenshot harness (tools/shots.js) — never by the running plant
# simulator — so a failure here must not abort the installation.
BROWSER_GROUPS=(
  "libnspr4"
  "libnss3"
  "libatk1.0-0 libatk1.0-0t64"
  "libatk-bridge2.0-0 libatk-bridge2.0-0t64"
  "libcups2 libcups2t64"
  "libdrm2"
  "libxkbcommon0"
  "libxcomposite1"
  "libxdamage1"
  "libxfixes3"
  "libxrandr2"
  "libgbm1"
  "libpango-1.0-0"
  "libcairo2"
  "libasound2 libasound2t64"
  "libatspi2.0-0 libatspi2.0-0t64"
)
mapfile -t BROWSER_PKGS < <(resolve_groups "${BROWSER_GROUPS[@]}")
if [ "${#BROWSER_PKGS[@]}" -gt 0 ]; then
  apt-get install -y --no-install-recommends "${BROWSER_PKGS[@]}" \
    || warn "optional headless-browser libraries unavailable (only used by tools/shots.js)"
fi
ok "system packages present"

# --------------------------------------------------------------------------
say "Checking for Node.js 18 or newer"
need_node=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    ok "Node.js $(node -v) already installed"; need_node=0
  else
    warn "Node.js $(node -v) is too old"
  fi
fi
if [ "$need_node" -eq 1 ] && [ "$SKIP_NODE" != "1" ]; then
  say "Installing Node.js 20 LTS from NodeSource"
  install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
  ok "Node.js $(node -v) / npm $(npm -v)"
elif [ "$SKIP_NODE" = "1" ]; then
  warn "SKIP_NODE=1 — using the distribution Node.js"
fi

# --------------------------------------------------------------------------
say "Creating service account"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  ok "created user $APP_USER"
else
  ok "user $APP_USER already exists"
fi

# --------------------------------------------------------------------------
say "Deploying application files to $APP_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$APP_DIR"
if [ -d "$SRC_DIR/.git" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git --exclude docs/*.png \
    "$SRC_DIR/" "$APP_DIR/"
else
  rm -rf "${APP_DIR:?}.new"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR.new"
  rm -rf "$APP_DIR.new/.git"
  mkdir -p "$APP_DIR"
  cp -a "$APP_DIR.new/." "$APP_DIR/"
  rm -rf "$APP_DIR.new"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
ok "files deployed"

# --------------------------------------------------------------------------
say "Installing npm dependencies"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

say "Vendoring Three.js for offline use"
npm install --no-save three@0.169.0 >/dev/null 2>&1 || warn "could not fetch three — using the copy already vendored"
node scripts/vendor.js || warn "vendoring skipped (public/vendor already populated?)"

# --------------------------------------------------------------------------
say "Writing environment file"
cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
HOST=0.0.0.0
ADMIN_PATH=$ADMIN_PATH
GIT_BRANCH=$BRANCH
UPDATE_SERVICE=turbine-coal-simulator
NODE_ENV=production
EOF
ok "$APP_DIR/.env written"

# --------------------------------------------------------------------------
say "Setting ownership"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chmod 0750 "$APP_DIR/data"

# --------------------------------------------------------------------------
if [ "$NO_SERVICE" != "1" ]; then
  say "Installing systemd unit"

  if command -v ss >/dev/null 2>&1 \
     && ss -Hltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}$"; then
    warn "port $PORT is already listening — if that is not a previous copy of this"
    warn "simulator, stop that service or re-run the installer with PORT=<other>"
  fi

  # Ports below 1024 are privileged: an unprivileged service account cannot
  # bind them. Grant just CAP_NET_BIND_SERVICE in that case; it replaces
  # NoNewPrivileges=yes, which would otherwise strip the capability.
  if [ "${PORT:-8080}" -ge 1 ] 2>/dev/null && [ "${PORT:-8080}" -lt 1024 ] 2>/dev/null; then
    CAP_LINES="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
    warn "port $PORT is privileged — the service is granted CAP_NET_BIND_SERVICE"
  else
    CAP_LINES="NoNewPrivileges=yes"
  fi

  cat > /etc/systemd/system/turbine-coal-simulator.service <<EOF
[Unit]
Description=Twin-Boiler Coal Power Plant Simulator
Documentation=https://github.com/mikeehendricks/TurbineCoalSimulator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/env node server/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=turbine-coal-simulator
# hardening
$CAP_LINES
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF

  # Allow the service account to restart the unit from the admin page.
  cat > /etc/sudoers.d/turbine-coal-simulator <<EOF
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl restart turbine-coal-simulator
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl start turbine-coal-simulator
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl stop turbine-coal-simulator
EOF
  chmod 0440 /etc/sudoers.d/turbine-coal-simulator

  systemctl daemon-reload
  systemctl enable turbine-coal-simulator
  systemctl restart turbine-coal-simulator
  sleep 2
  systemctl --no-pager status turbine-coal-simulator | head -12 || true

  say "Opening the firewall port (if ufw is active)"
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
    ufw allow "${PORT}/tcp" comment "coal plant simulator" || true
    ok "ufw rule added"
  else
    ok "ufw not active — skipped"
  fi
fi

# --------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOSTIP="${IP:-<server-ip>}"
say "Installation complete"
cat <<EOF

    Simulator      http://${HOSTIP}:${PORT}
    Admin console  http://${HOSTIP}:${PORT}${ADMIN_PATH}     (hidden — not linked anywhere)

    Useful commands
      sudo systemctl status  turbine-coal-simulator
      sudo journalctl -u turbine-coal-simulator -f
      sudo systemctl restart turbine-coal-simulator

    The admin account is created on first visit to the admin page — that is the
    only time registration is offered.

EOF
