#!/bin/bash
# Copies every .fit file out of Garmin's "Export Your Data" download (a .zip
# with more .zip files inside) into ~/Rides/garmin-export. The download itself
# is left as it is; files already in the folder are kept.
#
#   ride-import-export.sh <export.zip | unpacked export folder>
#   ride-import-export.sh                 (asks you to pick the .zip)

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
RIDES="${RIDE_SYNC_DIR:-$HOME/Rides}"
DEST="$RIDES/garmin-export"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(osascript -e 'POSIX path of (choose file with prompt "Pick the Garmin export .zip" of type {"zip", "public.zip-archive"})' 2>/dev/null)" || true
fi
if [ -z "$SRC" ] || [ ! -e "$SRC" ]; then echo "No export picked."; exit 1; fi

mkdir -p "$DEST"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ride-import.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "Unpacking $(basename "$SRC") ..."
if [ -d "$SRC" ]; then cp -R "$SRC" "$TMP/export"
else unzip -q -o "$SRC" -d "$TMP/export" || { echo "Could not unpack $SRC"; exit 1; }; fi

# Garmin puts the uploaded files in zips inside the zip: unpack up to 3 levels
for round in 1 2 3; do
  found=0
  while IFS= read -r -d '' z; do
    found=1
    unzip -q -o "$z" -d "${z%.*}_unzipped" >/dev/null 2>&1 || echo "  (could not unpack $(basename "$z"))"
    rm -f "$z"
  done < <(find "$TMP/export" -iname '*.zip' -print0)
  [ $found = 0 ] && break
done

copied=0; kept=0
while IFS= read -r -d '' f; do
  name="$(basename "$f")"
  if [ -e "$DEST/$name" ]; then kept=$((kept + 1)); continue; fi
  cp -p "$f" "$DEST/$name" && copied=$((copied + 1))
done < <(find "$TMP/export" -type f -iname '*.fit' -print0)

echo "Done: $copied .fit files copied, $kept were already there. Folder: $DEST"
echo "(The export has every activity type, not only rides; Ride Compare sorts them.)"
