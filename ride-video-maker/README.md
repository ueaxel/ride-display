# Ride Video Maker

Turns a bike ride into one video file for the [Ride Display](https://ueaxel.github.io/ride-display/) video screen, so you can ride it again on an indoor trainer: the video plays at your speed, the trainer follows the road's slope (or the original power), and your ghost from the original ride rides along.

**In:** a folder with
- the ride from your bike computer or watch: a **.fit** file (Garmin Connect: the activity → ⚙ → *Export Original*; a .zip is fine too after unzipping),
- the camera files recorded during the ride, straight from the camera:
  - **GoPro MAX** (360°): `GS01xxxx.360`, `GS02xxxx.360`, … (all chapters; `.LRV` / `.THM` can stay, they're ignored),
  - **GoPro HERO**: `GX01xxxx.MP4` / `GH01xxxx.MP4`, … (HERO6 and newer), or `GOPRxxxx.MP4`, `GP01xxxx.MP4`, … (HERO5 and older)

**Out:** `RideVideo_YYMMDD_HHMM.mp4` in the same folder, with the ride and the timing inside. In Ride Display: open the video screen (`#video`), **Clips** → pick that one file.

## The app (easiest)

Double-click **`Ride Video Maker.command`** (or `python3 ride_video_app.py`). A page opens in your browser
(it runs on this computer only):

1. **The ride folder:** *Choose…* the folder with the watch's .fit and the GoPro files.
2. **What to make:** *Full size* (riding on this Mac / the tablet), *Streaming* (under 300 MB, to upload to
   Cloudflare and share as a link), *Phone* (to copy onto a phone). If the folder already has a ride video, it can be
   reused instead of putting it together again.
3. **Make:** progress shows on the page; *Show in Finder* when done. For a streaming copy the page also shows the
   `index.json` line and the link to send.

Command line, same thing: `make_ride_video.py FOLDER`, then `--stream RideVideo_….mp4` or `--phone RideVideo_….mp4`.

## What it does

1. **Timing:** reads the GPS time from the camera's own telemetry (exact, whatever the camera clock is set to), then fine-tunes it by laying the camera's GPS track over the ride's. Without a GPS fix it falls back on the camera clock (check with **Sync** in the app).
2. **360° conversion (GoPro MAX):** the `.360` format stores the picture as two lens tracks of cube faces; they are turned into one 360° (equirectangular) video, the same kind GoPro Player exports. The camera's gravity sensor is stored with the ride, so the app keeps the horizon level by itself. If full-length (untrimmed) GoPro Player exports are in the folder, those are used instead.
3. **Joining:** chapters and separate recordings become one file; gaps where the camera was off are handled by the app ("no video for this part").

## Cameras

| Camera | Files | |
|---|---|---|
| GoPro MAX | `GS01xxxx.360` | 360°: converted here, GPS sync, horizon levelling |
| GoPro MAX, single-lens mode | `GS01xxxx.MP4` | flat video, GPS sync |
| HERO5 Black – HERO11, HERO13 | `GX…` / `GH…` / `GOPR…` / `GP…` `.MP4` | flat video, GPS sync |
| HERO12 (no GPS), HERO4 and older (no telemetry) | `.MP4` | flat video, timed by the camera clock: check with **Sync** in the app |
| GoPro MAX2, Fusion, other 360° cameras | | export a full-length 360° (equirectangular) .mp4 with the camera's own software and put it next to the originals (MAX2) or use the app's **Clips** to pair it with the .fit and **Sync** it |

## Install (once)

- **Mac:** Python 3 (macOS asks to install the developer tools the first time you run `python3`; say yes) and ffmpeg: install [Homebrew](https://brew.sh), then `brew install ffmpeg`.
- **Windows / Linux:** Python 3 and ffmpeg (from your package manager or ffmpeg.org).

No other packages are needed.

## Run

- **Mac:** download this folder, double-click **Make Ride Video.command** (the first time: right-click → Open, because it's downloaded), choose the ride's folder.
- **Anywhere:** `python3 make_ride_video.py /path/to/ride-folder` (`--fit NAME.fit` if the folder holds several rides, `--dry-run` to only check the timing).

## How long, how big

Converting 360° video takes roughly as long as the ride on a recent Mac (it uses the Mac's hardware video encoder; elsewhere ffmpeg's slower software encoder). The result is large: about 25 GB for an hour of 5.4K 360° video. Joining files that need no conversion (HERO videos, GoPro Player exports) takes a minute.

## Phone-size copy

`Make Phone Version.command` (or `python3 make_ride_video.py --phone RideVideo_….mp4`) makes `RideVideo_…_phone.mp4` next to it: 2560 × 1280 H.264, about 2.7 GB per hour, with the same ride inside. Copy it onto a phone or tablet (iPhone: AirDrop → Save to Files) and open it on the video screen (Clips → pick it): no streaming needed, ▶ plays the ride.

## Files

- `make_ride_video.py` — the tool
- `estimate_power.py` — reads .fit files (and, run on its own, estimates power for rides recorded without a power meter: `python3 estimate_power.py RIDE.fit OUT.fit --rider-kg 75`)
- `Make Ride Video.command` — double-click starter for the Mac
- `ride_video_app.py` / `Ride Video Maker.command` — the app in your browser
- `Make Phone Version.command` — double-click: phone-size copy of a ride video
