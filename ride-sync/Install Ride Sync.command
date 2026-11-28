#!/bin/bash
# Installs Ride Sync: libmtp (to read the watch over USB), the ~/Rides folder,
# and a background agent that copies new rides whenever a Garmin watch is
# plugged into this Mac. Run it again after an update; it replaces the old copy.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
STATE="$HOME/Library/Application Support/RideSync"
AGENT="$HOME/Library/LaunchAgents/com.ueaxel.ridesync.plist"
LABEL=com.ueaxel.ridesync

echo "== Ride Sync install =="
if ! command -v brew >/dev/null; then
  echo "Homebrew is needed to install libmtp. Opening https://brew.sh — install it, then run this again."
  open https://brew.sh; read -r -p "Press Return to close." _; exit 1
fi
if ! command -v mtp-files >/dev/null; then
  echo "Installing libmtp ..."; brew install libmtp || { read -r -p "libmtp install failed. Press Return to close." _; exit 1; }
fi

mkdir -p "$HOME/Rides/watch" "$HOME/Rides/garmin-export" "$STATE" "$HOME/Library/LaunchAgents"
cp ride-sync.sh ride-import-export.sh "$STATE/" && chmod +x "$STATE/ride-sync.sh" "$STATE/ride-import-export.sh"

cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$STATE/ride-sync.sh</string><string>--auto</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$STATE/agent-errors.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
launchctl bootstrap "gui/$(id -u)" "$AGENT" && echo "Background agent running: new rides are copied within a minute of plugging in the watch."

echo
echo "Rides go to: $HOME/Rides/watch"
echo "Checking for a watch now ..."
/bin/bash "$STATE/ride-sync.sh"
echo
echo "Done."
