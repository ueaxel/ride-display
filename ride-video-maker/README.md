# Ride Video Maker

Turns a bike ride into one video file for the [Ride Display](https://ueaxel.github.io/ride-display/) video screen, so you can ride it again on an indoor trainer: the video plays at your speed, the trainer follows the road's slope (or the original power), and your ghost from the original ride rides along.

**In:** a folder with
- the ride from your bike computer or watch: a **.fit** file (Garmin Connect: the activity → ⚙ → *Export Original*; a .zip is fine too after unzipping),
- the camera files recorded during the ride, straight from the camera:
  - **GoPro MAX** (360°): `GS01xxxx.360`, `GS02xxxx.360`, … (all chapters; `.LRV` / `.THM` can stay, they're ignored),
  - **GoPro HERO**: `GX01xxxx.MP4` / `GH01xxxx.MP4`, …

**Out:** `RideVideo_YYMMDD_HHMM.mp4` in the same folder, with the ride and the timing inside. In Ride Display: open the video screen (`#video`), **Clips** → pick that one file.

## What it does

1. **Timing:** reads the GPS time from the camera's own telemetry (exact, whatever the camera clock is set to), then fine-tunes it by laying the camera's GPS track over the ride's. Without a GPS fix it falls back on the camera clock (check with **Sync** in the app).
2. **360° conversion (GoPro MAX):** the `.360` format stores the picture as two lens tracks of cube faces; they are turned into one 360° (equirectangular) video, the same kind GoPro Player exports. The camera's gravity sensor is stored with the ride, so the app keeps the horizon level by itself. If full-length (untrimmed) GoPro Player exports are in the folder, those are used instead.
3. **Joining:** chapters and separate recordings become one file; gaps where the camera was off are handled by the app ("no video for this part").

## Install (once)

- **Mac:** Python 3 (macOS asks to install the developer tools the first time you run `python3`; say yes) and ffmpeg: install [Homebrew](https://brew.sh), then `brew install ffmpeg`.
- **Windows / Linux:** Python 3 and ffmpeg (from your package manager or ffmpeg.org).

No other packages are needed.

## Run

- **Mac:** download this folder, double-click **Make Ride Video.command** (the first time: right-click → Open, because it's downloaded), choose the ride's folder.
- **Anywhere:** `python3 make_ride_video.py /path/to/ride-folder` (`--fit NAME.fit` if the folder holds several rides, `--dry-run` to only check the timing).

## How long, how big

Converting 360° video takes roughly as long as the ride on a recent Mac (it uses the Mac's hardware video encoder; elsewhere ffmpeg's slower software encoder). The result is large: about 25 GB for an hour of 5.4K 360° video. Joining files that need no conversion (HERO videos, GoPro Player exports) takes a minute.

## Files

- `make_ride_video.py` — the tool
- `estimate_power.py` — reads .fit files (and, run on its own, estimates power for rides recorded without a power meter: `python3 estimate_power.py RIDE.fit OUT.fit --rider-kg 75`)
- `Make Ride Video.command` — double-click starter for the Mac
