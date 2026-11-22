#!/bin/bash
# Phone-size copy of a ride video (RideVideo_....mp4 -> RideVideo_..._phone.mp4, about 2.7 GB per hour),
# to copy onto an iPhone / Android phone / tablet and ride or play it there without streaming.
here="$(cd "$(dirname "$0")" && pwd)"
file=$(osascript -e 'POSIX path of (choose file with prompt "Ride video to make a phone-size copy of (RideVideo_....mp4)" of type {"public.mpeg-4"})' 2>/dev/null)
[ -z "$file" ] && { echo "No file chosen."; exit 1; }
python3 "$here/make_ride_video.py" --phone "$file"
echo
read -n 1 -s -r -p "Press any key to close this window"
