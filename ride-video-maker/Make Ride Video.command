#!/bin/bash
# Make one ride video for Ride Display: a ride (.fit) + the GoPro recordings made during it
# -> RideVideo_YYMMDD_HHMM.mp4. Double-click on a Mac; you're asked for the folder.
here="$(cd "$(dirname "$0")" && pwd)"
folder=$(osascript -e 'POSIX path of (choose folder with prompt "Folder with the ride (.fit) and the GoPro files (.360 / .MP4)")' 2>/dev/null)
[ -z "$folder" ] && { echo "No folder chosen."; exit 1; }
echo "Folder: $folder"
python3 "$here/make_ride_video.py" "$folder"
echo
read -n 1 -s -r -p "Press any key to close this window"
