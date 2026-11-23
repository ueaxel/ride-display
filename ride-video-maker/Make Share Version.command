#!/bin/bash
# Share copy of a ride video (RideVideo_....mp4 -> RideVideo_..._share.mp4): steady speed, no stops,
# traffic lights covered, only the route inside. For streaming to other riders.
here="$(cd "$(dirname "$0")" && pwd)"
file=$(osascript -e 'POSIX path of (choose file with prompt "Ride video to make a share copy of (RideVideo_....mp4)" of type {"public.mpeg-4"})' 2>/dev/null)
[ -z "$file" ] && { echo "No file chosen."; exit 1; }
python3 "$here/make_ride_video.py" --share "$file"
echo
read -n 1 -s -r -p "Press any key to close this window"
