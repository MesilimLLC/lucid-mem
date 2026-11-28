#!/bin/sh
# Registers periodic dreaming for lucid-mem on macOS/Linux.
#
#   ./install-dream.sh            install
#   ./install-dream.sh remove     uninstall
#
# Prefers a systemd user timer (Linux); falls back to a weekly cron
# entry (macOS, minimal Linux). Both run:
#   weekly  Sun 03:00  lucid dream --fix --compact
#   daily              lucid dream --if-stale 1 --fix --compact
# POSIX cron has no idle trigger, so the daily stale-gated run takes
# the place of the Windows 5-minute idle task: it still catches up
# once a day instead of within minutes.
#
# Repo root is derived from this script's location (adapters/posix/);
# override with AMR_REPO=/path/to/clone.

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=${AMR_REPO:-$(dirname "$(dirname "$HERE")")}
AMR_JS="$REPO/cli/amr.mjs"
NODE=$(command -v node || true)

if [ ! -f "$AMR_JS" ]; then
  echo "cannot find cli/amr.mjs under $REPO (set AMR_REPO=...)" >&2
  exit 1
fi
if [ -z "$NODE" ]; then
  echo "node not on PATH" >&2
  exit 1
fi

WEEKLY_CMD="\"$NODE\" \"$AMR_JS\" dream --fix --compact"
DAILY_CMD="\"$NODE\" \"$AMR_JS\" dream --if-stale 1 --fix --compact"

remove_all() {
  if command -v systemctl >/dev/null 2>&1; then
    d="$HOME/.config/systemd/user"
    rm -f "$d/lucid-mem-dream.service" "$d/lucid-mem-dream.timer" \
          "$d/lucid-mem-dream-daily.service" "$d/lucid-mem-dream-daily.timer"
    systemctl --user disable --now lucid-mem-dream.timer lucid-mem-dream-daily.timer 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  if command -v crontab >/dev/null 2>&1; then
    crontab -l 2>/dev/null | grep -v 'amr\.mjs.*dream' | crontab - || true
  fi
  echo "removed lucid-mem dream schedules"
}

if [ "${1:-}" = "remove" ]; then
  remove_all
  exit 0
fi

# Prefer systemd user timers when a user manager is reachable.
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  d="$HOME/.config/systemd/user"
  mkdir -p "$d"

  cat > "$d/lucid-mem-dream.service" <<EOF
[Service]
Type=oneshot
ExecStart=$NODE $AMR_JS dream --fix --compact
EOF
  cat > "$d/lucid-mem-dream.timer" <<EOF
[Timer]
OnCalendar=Sun 03:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

  cat > "$d/lucid-mem-dream-daily.service" <<EOF
[Service]
Type=oneshot
ExecStart=$NODE $AMR_JS dream --if-stale 1 --fix --compact
EOF
  cat > "$d/lucid-mem-dream-daily.timer" <<EOF
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now lucid-mem-dream.timer lucid-mem-dream-daily.timer
  echo "installed systemd user timers:"
  echo "  lucid-mem-dream.timer        weekly Sun 03:00  dream --fix --compact"
  echo "  lucid-mem-dream-daily.timer  daily             dream --if-stale 1 --fix --compact"
  echo "note: user timers need 'loginctl enable-linger $USER' to fire while logged out"
  exit 0
fi

# cron fallback (macOS, minimal Linux)
if command -v crontab >/dev/null 2>&1; then
  existing=$(crontab -l 2>/dev/null | grep -v 'amr\.mjs.*dream' || true)
  {
    [ -n "$existing" ] && printf '%s\n' "$existing"
    printf '7 3 * * 0 %s # lucid-mem weekly dream\n' "$WEEKLY_CMD"
    printf '17 4 * * * %s # lucid-mem daily stale-gated dream\n' "$DAILY_CMD"
  } | crontab -
  echo "installed cron entries:"
  echo "  7 3 * * 0   dream --fix --compact"
  echo "  17 4 * * *  dream --if-stale 1 --fix --compact"
  exit 0
fi

echo "no systemd user manager and no crontab found; install a scheduler manually:" >&2
echo "  $WEEKLY_CMD" >&2
exit 1
