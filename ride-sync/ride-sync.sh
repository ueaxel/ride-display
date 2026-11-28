#!/bin/bash
# Ride Sync: copies new activity files from a Garmin watch plugged into the Mac
# by USB into ~/Rides/watch. The watch's originals are copied as they are
# (including beat-to-beat heart rate when the watch logs it); nothing on the
# watch is changed or deleted.
#
#   ride-sync.sh          sync now (prints what it does)
#   ride-sync.sh --auto   used by the background agent every minute: does
#                         nothing unless a Garmin is plugged in, and syncs
#                         only once per plug-in.
#
# Needs libmtp (brew install libmtp): Garmin watches such as the Forerunner
# 265 talk MTP over USB and do not appear in Finder.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

RIDES="${RIDE_SYNC_DIR:-$HOME/Rides}"
DEST="$RIDES/watch"
STATE="${RIDE_SYNC_STATE:-$HOME/Library/Application Support/RideSync}"
LOG="$STATE/ride-sync.log"
GARMIN_VENDOR=2334            # USB vendor id 0x091e
AUTO=0; [ "${1:-}" = "--auto" ] && AUTO=1

mkdir -p "$DEST" "$STATE"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; [ $AUTO = 1 ] || echo "$*"; }
notify() { osascript -e "display notification \"$1\" with title \"Ride Sync\"" >/dev/null 2>&1 || true; }
plugged() { ioreg -p IOUSB -l -w0 2>/dev/null | grep -q "\"idVendor\" = $GARMIN_VENDOR"; }

if ! plugged; then
  rm -f "$STATE/synced-this-plug"
  [ $AUTO = 1 ] || echo "No Garmin watch found on USB. Plug the watch in (it may take a few seconds to appear) and try again."
  exit 0
fi
[ $AUTO = 1 ] && [ -f "$STATE/synced-this-plug" ] && exit 0

# one sync at a time (a lock left by a crash is cleared after 30 minutes)
LOCK="$STATE/lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK" || exit 0
  else [ $AUTO = 1 ] || echo "A sync is already running."; exit 0; fi
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ride-sync.XXXXXX")"
trap 'rmdir "$LOCK" 2>/dev/null; rm -rf "$TMP"' EXIT

if ! command -v mtp-files >/dev/null || ! command -v mtp-getfile >/dev/null || ! command -v mtp-folders >/dev/null; then
  say "libmtp is missing. Run Install Ride Sync.command once."
  notify "Can't read the watch yet: run Install Ride Sync once."
  exit 1
fi

# macOS's camera service (ptpcamerad) grabs MTP devices as soon as they are
# plugged in; only one program can talk to the watch at a time.
free_watch() { killall ptpcamerad "Android File Transfer Agent" >/dev/null 2>&1 || true; sleep 1; }
mtp() {       # run an mtp-* command, retrying when the watch is busy
  local try
  for try in 1 2 3; do
    free_watch
    if "$@" > "$TMP/out" 2> "$TMP/err" && [ -s "$TMP/out" ]; then return 0; fi
    sleep 3
  done
  return 1
}

say "Watch found: reading its folders."
if ! mtp mtp-folders; then
  say "Could not open the watch: $(tail -n 3 "$TMP/err" | tr '\n' ' ')"
  say "If Garmin Express is open, quit it and try again."
  notify "Could not open the watch. Quit Garmin Express if it is open, then unplug and plug in again."
  exit 1
fi
# mtp-folders prints "<id><TAB><two spaces per level><name>"; find GARMIN/Activity
ACTIVITY_IDS="$(awk -F'\t' '
  /^[0-9]+\t/ {
    name = $2; depth = 0
    while (substr(name, 1, 2) == "  ") { name = substr(name, 3); depth++ }
    path[depth] = toupper(name)
    if (depth >= 1 && path[depth] == "ACTIVITY" && path[depth - 1] == "GARMIN") print $1
  }' "$TMP/out")"
if [ -z "$ACTIVITY_IDS" ]; then
  say "No GARMIN/Activity folder on this device."
  notify "The watch has no Activity folder."
  exit 1
fi

say "Listing files (this can take a minute on a full watch)."
if ! mtp mtp-files; then
  say "Could not list the watch's files: $(tail -n 3 "$TMP/err" | tr '\n' ' ')"
  notify "Could not list the watch's files. Unplug and plug in again."
  exit 1
fi
# "File ID: n" blocks -> id<TAB>parent<TAB>size<TAB>name, activity .fit files only
awk -v parents=" $(echo $ACTIVITY_IDS) " '
  function flush() { if (id != "" && index(parents, " " parent " ") && tolower(name) ~ /\.fit$/) print id "\t" parent "\t" size "\t" name; id = ""; name = ""; size = ""; parent = "" }
  /^File ID:/       { flush(); id = $3 }
  /^ *Filename:/    { sub(/^ *Filename: */, ""); name = $0 }
  /^ *File size/    { size = $3 }
  /^ *Parent ID:/   { parent = $3 }
  END { flush() }' "$TMP/out" > "$TMP/list"

total=$(wc -l < "$TMP/list" | tr -d ' ')
new=0; failed=0
while IFS=$'\t' read -r id parent size name; do
  case "$name" in */*|..*|"") continue ;; esac          # never write outside the folder
  target="$DEST/$name"
  if [ -f "$target" ] && [ "$(wc -c < "$target" | tr -d ' ')" = "$size" ]; then continue; fi
  free_watch
  if mtp-getfile "$id" "$TMP/part.fit" >/dev/null 2>>"$TMP/err" && [ -s "$TMP/part.fit" ]; then
    mv -f "$TMP/part.fit" "$target"; new=$((new + 1)); say "  copied $name"
  else
    rm -f "$TMP/part.fit"; failed=$((failed + 1)); say "  could not copy $name"
  fi
done < "$TMP/list"

say "Done: $new new, $failed failed, $total activity files on the watch. Folder: $DEST"
if [ $failed = 0 ]; then touch "$STATE/synced-this-plug"; fi
if [ $new -gt 0 ] || [ $failed -gt 0 ]; then
  msg="$new new ride file$([ $new = 1 ] || echo s) copied to Rides"
  [ $failed -gt 0 ] && msg="$msg, $failed could not be copied"
  notify "$msg."
elif [ $AUTO = 0 ]; then
  notify "No new rides on the watch."
fi
[ $failed = 0 ]
