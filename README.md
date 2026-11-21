# Ride Display

One web page with two screens. It runs in Chrome; nothing to install.

| Screen | Device | Reads | Shows |
|---|---|---|---|
| **Trainer** (`#trainer`) | TCL tablet beside the trainer | R200 over Bluetooth (FTMS, or Cycling Power), HRM 200 strap | power, HR, cadence, route map with you and the ghost, elevation, HR vs power, power/HR over time, HR response to power steps |
| **Handlebar** (`#ghost`) | Pixel 3a on the bars | phone GPS, HRM 200 strap | gap to the ghost in metres and seconds, gauge, heading-up map, HR and speed against the original |

| **Video** (`#video`) | Mac (Chrome), or the tablet with flat videos | same as Trainer | your ride video full screen, following your position; numbers, map, HR vs power and traces floating on top |

The watch is not involved and the iPhone doesn't need to be connected. The watch keeps recording, and indoors it keeps controlling the R200 over **ANT+**. Each display listens to the same sensors over **Bluetooth**. If a sensor won't connect to the display, check that the watch is using it over ANT+ and not Bluetooth.

## Reference ride

Tap the purple reference button and pick the original ride's `.fit` file, or the `.zip` you get from Garmin Connect → activity → ⚙ → *Export Original*, without unzipping it. This is the same file you drag into `Make Ride Repro Reference.command`. The page builds the same profile as `tools/make_reference.py`. If the ride has no power, it estimates power the same way `tools/estimate_power.py` does. Optional: *use the ride only up to … km*. The page keeps up to 6 references on the device.

When you load a reference, the page also downloads the streets within about 200 m of the route from OpenStreetMap (Overpass API) and stores them on the device. That download needs internet, so do it at home. If it fails, use **Download streets** in the same dialog.

## Riding

- **Trainer:** connect the HR strap and the trainer, then press **Start** when you start the watch. Your distance on the route comes from your power, using the same physics as `IndoorRide.mc`. The ghost is where the original ride was after the same moving time.
- **Handlebar:** connect GPS and the HR strap, then press **Start** at the spot where the original ride started. The clock runs only while you move. Your GPS position is matched onto the original route, so you don't see the speed jumps you got from GPS speed. A red *off route* label means you are on a detour, and distance is counted from GPS until you're back on the route.
- **Resistance** (menu in the top bar, tablet only): the tablet can set the R200's resistance over Bluetooth (FTMS):
  - *ghost power (ERG)*: the original ride's power over the next few seconds of road (between 60 and 600 W), like Ride Repro's indoor mode on the watch
  - *route grade*: the R200 simulates the slope of the route at your position
  - *fixed watts (ERG)*: a constant target, set with −10 / +10, for HR step tests
  - *watch / none*: the tablet only listens.

  Only one device can control the trainer. When the tablet controls it, don't link the trainer in the watch app (Ride Repro / HrPw), and set the watch activity's Smart Trainer option to off or Free Ride. The watch still records power and HR over ANT+.
- **Reset gap** lines the ghost up with you again, like the Lap button on the watch.
- **Save FIT** saves the ride as a .fit activity file in Downloads. Import it at connect.garmin.com (cloud/upload icon → Import Data; the Garmin Connect phone app can't import files), or into Strava or GoldenCheetah. If the watch recorded the same ride, keep only one of the two in Garmin Connect.
- **Save CSV** (or ☰ → Save CSV) saves every second of the ride, plus the fitted power steps.
- ☰ → **Demo data** fills the screen with simulated data so you can try it without sensors.

## Video screen (Mac)

**1. Prepare the videos (once per ride).** GoPro MAX `.360` files can't play in a browser. In **GoPro Player** on the Mac, export each as a **360° (equirectangular) MP4**. 4K H.264 is the safe choice; 5.6K or HEVC also play in Chrome on recent Macs. A normal flat video (or a reframed 16:9 export) works too and is lighter for the tablet.

**2. Put each video and the watch's .fit of the same ride in one folder.** You can also use the .zip from Garmin Connect *Export Original*. One ride can have several videos (GoPro splits long recordings), and every video becomes its own clip.

**3. Open it.** In Chrome: ☰ → **Video screen**, then **Clips** → **Choose video folder…**. Next time, use **Open last folder**. The app pairs each video with the ride that was being recorded when the video started. Camera clocks often save local time as if it were UTC, so the app also tries the ride's time zone. If no time matches, it pairs a video with a ride of the same file name. Streets are downloaded for each clip once (online).

**4. Sync each clip once.** In Clips, tap **Sync**. Scrub the video (−10/−1/+1/+10 s, slider) to a spot you can recognise, such as a crossing, a bridge or a turn, then click that spot on the map. The offset is saved. Check a second spot to confirm. Until you've done this, the clip shows *sync not checked* and relies on the clocks.

**5. Ride.** In Clips, tap **Ride this** (it starts where the video starts), connect HR and trainer, choose a Resistance mode and press **Start**. The video plays at the pace that matches your position on the route. It slows down where the original rider was slower than you, pauses when you stop, and jumps over the original's red-light waits.
- **360°:** drag the video to look around and scroll to zoom. **Look ahead** turns the view forward again. If a video's middle isn't the riding direction (e.g. the camera faced you), drag it so you look along the road and press **Set forward**. This is saved per clip.
- **World Lock:** export with GoPro Player's *World Lock* **off**. World Lock keeps the picture facing the direction the camera had at the start, so on a bike ride the view drifts away from the road. *Horizon Leveling* can stay on. For a video already exported with World Lock on, press **Turn with road**. The app then turns the view by how much the route has turned since the start of the video. This is saved per clip.
- **Panels:** drag them by the title and resize them at the bottom-right corner; × hides one, and **Panels** turns them on or off or resets the layout. They stay where you put them on the screen, whatever the video does.
- After 4 s of riding, the top bar and the panel handles hide; move the mouse to bring them back. ☰ → **Full screen** fills the whole display.

**Junctions.** Where another clip runs along the same road as the one you're riding, the app looks ahead for where the two routes split. About 350 m before the split, it offers the choice: **1** stays on your clip, **2**, **3**… take the other clip (keys or click). Taking it switches to the other video at the same spot on the road, so the picture doesn't jump. At the end of a clip, if another clip carries on along the same road, the app continues on it automatically. So record the turns you want as separate rides (videos) that share the road before the junction.

## HR response panel

Each clear power step (≥ 40 W, held for a minute) gets a fit of the next 2 minutes of heart rate to a first-order response with a dead time: delay, then time constant τ. This is the simple form of the delay and response times in de Leeuw et al. 2025 (see the project's LITERATURE.md). Power drops also give the 60-s HR recovery. The panel shows medians of the fits with R² ≥ 0.8.

## Hosting and riding outside

The live copy is at **https://ueaxel.github.io/ride-display/**, published from the public repo `ueaxel/ride-display`, which holds a copy of this folder. Web Bluetooth and GPS only work on an `https://` page in Chrome (Android, Mac, Windows; not iPhone).

On the Pixel, at home on Wi-Fi: open the address in Chrome, then ⋮ → **Add to Home screen**, then load the reference (this also downloads the streets). After that, the app, the reference and the streets are stored on the phone, and the ride works with no internet. GPS and Bluetooth don't need a network. Keep the page in front with the screen on: the page asks Chrome to keep the screen on, but if you switch apps or lock the phone, Chrome pauses the page.

## Tests

```
python3 Display/tests/check_reference.py   # JS profile/power vs the Python tools
node Display/tests/check_parsers.mjs        # Bluetooth packets, step fits
python3 Display/tests/make_video_fixtures.py /tmp/vfix && node Display/tests/check_clips.mjs /tmp/vfix   # video pairing, timing, junctions
```
