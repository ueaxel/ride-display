# Ride Display

One web page with three screens, plus a tool for making your own ride videos. It runs in Chrome; nothing to install.

| Screen | Device | Reads | Shows |
|---|---|---|---|
| **Trainer** (`#trainer`) | TCL tablet beside the trainer | R200 over Bluetooth (FTMS, or Cycling Power), HRM 200 strap | power, HR, cadence, route map with you and the ghost, elevation, HR vs power, power/HR over time, HR response to power steps |
| **Handlebar** (`#ghost`) | Pixel 3a on the bars | phone GPS, HRM 200 strap | gap to the ghost in metres and seconds, gauge, heading-up map, HR and speed against the original |
| **Video** (`#video`) | Mac (Chrome), or the tablet with flat videos | same as Trainer | your ride video full screen, following your position; numbers, map, HR vs power and traces floating on top |

The watch is not involved and the iPhone doesn't need to be connected. The watch keeps recording, and indoors it keeps controlling the R200 over **ANT+**. Each display listens to the same sensors over **Bluetooth**. If a sensor won't connect to the display, check that the watch is using it over ANT+ and not Bluetooth.

## Ride Video Maker (make your own ride videos)

The [`ride-video-maker`](ride-video-maker/) folder has the tool that turns a ride's .fit file and the GoPro files recorded during it into one video for the video screen: GPS time sync, GoPro MAX .360 → 360° conversion with horizon levelling, chapters joined. It runs on your own computer (Mac: double-click; anywhere: Python 3 + ffmpeg). See its [README](ride-video-maker/README.md).

## Reference ride

Tap the purple reference button and pick the original ride's `.fit` file, or the `.zip` you get from Garmin Connect → activity → ⚙ → *Export Original*, without unzipping it. This is the same file you drag into `Make Ride Repro Reference.command`. The page builds the same profile as `tools/make_reference.py`. If the ride has no power, it estimates power the same way `tools/estimate_power.py` does. Optional: *use the ride only up to … km*. The page keeps up to 6 references on the device.

### GPX routes

The same button also takes a **.gpx** file:

- **A recorded ride** (points with times, e.g. exported from Strava): used like a .fit ride, with its own times, speed and heart rate. Power is estimated when the file has none.
- **A planned route** (no times, e.g. RideWithGPS, Komoot or Strava routes): there's no original rider, so the ghost rides the route at a **steady power** you set in the dialog (*Ghost power for a planned .gpx route*, 160 W by default). Its speed comes from the grade with the same physics as the trainer (so pedalling that power keeps you level with it), between 6 and 50 km/h. The reference is named after the power, e.g. *OYJ Dublin Grade Light @ 160 W*; load it again with another power to get a faster or slower ghost.

**Built-in routes:** the `.gpx` files in [`routes/`](routes/) listed in `routes/index.json` appear in the reference list under *Routes* on every device, so you don't need to copy the file to the tablet or phone. Pick one to make it a reference. To add a route, put its .gpx in `routes/` and add a line to `routes/index.json`.

When you load a reference, the page also downloads the streets within about 500 m of the route (stretches already covered by your saved map, ☰ → *Download map around me*, are skipped) from OpenStreetMap (Overpass API) and stores them on the device. That download needs internet, so do it at home. If it fails, use **Download streets** in the same dialog.

## Riding

- **Trainer:** connect the HR strap and the trainer, then press **Start** when you start the watch. Your distance on the route comes from your power, using the same physics as `IndoorRide.mc`. The ghost is where the original ride was after the same moving time.
- **Handlebar:** connect GPS and the HR strap, then press **Start** at the spot where the original ride started. The clock runs only while you move. Your GPS position is matched onto the original route, so you don't see the speed jumps you got from GPS speed. A red *off route* label means you are on a detour, and distance is counted from GPS until you're back on the route.
- **Resistance** (menu in the top bar, tablet only): the tablet can set the R200's resistance over Bluetooth (FTMS):
  - *ghost power (ERG)*: the original ride's power over the next few seconds of road (between 60 and 600 W), like Ride Repro's indoor mode on the watch
  - *route grade*: the R200 simulates the slope of the route at your position
  - *fixed watts (ERG)*: a constant target, set with −10 / +10, for HR step tests
  - *watch / none*: the tablet only listens.

  Only one device can control the trainer. When the tablet controls it, don't link the trainer in the watch app (Ride Repro / HrPw), and set the watch activity's Smart Trainer option to off or Free Ride. The watch still records power and HR over ANT+.
- **Streets on the route maps:** the route's own streets (500 m either side) plus, a little dimmer underneath, your saved area map wherever you've downloaded it. References saved before v42 (200 m) are widened to 500 m automatically the next time you open them online.
- **Moving the map:** drag the map with one finger to look around, pinch to zoom and twist two fingers to turn it (mouse: drag, wheel zooms, shift + wheel turns). A compass shows north when the map isn't heading-up. **◎** (or a double-tap) puts it back on you. On the handlebar screen the map also returns to you by itself 20 s after you let go while riding.
- **Before the ride (handlebar):** tap **GPS** after loading the reference: the map shows you as a blinking **green dot**, the route's **START** flag and, when you're off the route, a dashed green line to the nearest point of the route, with the distances to both under the gap. Ride to the start and press Start, or join the route where it's nearest, press Start there and then **Reset gap**.
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
- **360°:** drag the video to look around and scroll to zoom. The **View** button opens: **Look ahead** (turns forward again); **Set forward** (if the camera faced you, drag the view so you look along the road and press it); **Turn with road** (only for World-Lock exports); and **Level the horizon** (roll and tilt sliders for a tilted picture). All of these are saved per ride.
- **Full screen:** ⛶ in the top bar or the **F** key. Press F or Esc to leave.
- **Chapters:** the GoPro splits long recordings at 4 GB (GS01xxxx, GS02xxxx…). Export each chapter and pair them all with the same ride. They then play as one continuous video, in file-name order, and only one of them needs syncing.
- **World Lock:** export with GoPro Player's *World Lock* **off**. World Lock keeps the picture facing the direction the camera had at the start, so on a bike ride the view drifts away from the road. *Horizon Leveling* can stay on. For a video already exported with World Lock on, press **Turn with road**. The app then turns the view by how much the route has turned since the start of the video. This is saved per clip.
- **Panels:** drag them by the title and resize them at the bottom-right corner; × hides one, and **Panels** turns them on or off or resets the layout. They stay where you put them on the screen, whatever the video does.
- After 4 s of riding, the top bar and the panel handles hide; move the mouse to bring them back. ☰ → **Full screen** fills the whole display.

**Junctions.** Where another clip runs along the same road as the one you're riding, the app looks ahead for where the two routes split. About 350 m before the split, it offers the choice: **1** stays on your clip, **2**, **3**… take the other clip (keys or click). Taking it switches to the other video at the same spot on the road, so the picture doesn't jump. At the end of a clip, if another clip carries on along the same road, the app continues on it automatically. So record the turns you want as separate rides (videos) that share the road before the junction.

## One ride video (automatic)

`Make Ride Video.command` (in `dev/garmin`) turns a watch ride and the GoPro recordings made during it into **one file** with everything inside: `RideVideo_YYMMDD_HHMM.mp4`. In the app, pick that one file (Clips → pick files, or open the folder) and ride. No pairing, no sync.

1. Put in one folder: the watch ride's `.fit`, the GoPro **originals** as they come off the card (`GS01xxxx.360`, `GS02xxxx.360` … for the MAX; `GX01xxxx.MP4` … for a HERO), and for `.360` files the **full-length** 360° exports from GoPro Player (any names; they're matched to the originals by length, so don't trim them).
2. Double-click `Make Ride Video.command` and choose the folder.
3. It reads the **GPS time** (UTC) from each original's telemetry and fine-tunes it by laying the camera's GPS track over the watch's. That's exact even when the camera clock is off. Without a GPS fix (or on a HERO12, which has no GPS), it uses the camera clock; check that ride once with **Sync**. It then joins chapters and separate recordings into one video without re-encoding, and embeds the ride. Where the camera was off, the app shows the map and says so.

Joining several pieces needs **ffmpeg** once: `brew install ffmpeg`. A single piece works without it. The file is as big as the videos together; files over 4 GB don't fit on FAT32 USB sticks.

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
node Display/tests/check_ridevideo.mjs RideVideo_….mp4   # a file from make_ride_video.py: embedded ride, pieces, gaps
```

## Riding without a reference (phone)

- Choose **No reference (free ride)** in the reference list (or load none): the phone screen is a **free ride**: big speed, distance and time, average speed, and a map around you that turns with your direction and shows your track so far.
- **☰ → Download map around me** (5 or 10 km) stores OpenStreetMap streets on the phone in squares of about 2 × 2 km, so the map works without internet. On rides with internet, missing squares load by themselves.
- **☰ → My rides**: every ride (outdoor or indoor) is kept on the device, saved every 30 s and when you stop, so it survives a reload. Each one has **Save FIT** (Garmin Connect / Strava), **Use as reference** (race it next time) and **Delete**. The newest 30 are kept.

## Power, work gap, stops, turn-backs (phone)

- **Power 3 s**: estimated from how the bike moves (speed, change of speed, slope from the reference route or GPS altitude) with the weights in **☰ → Settings** (rider, bike, CdA, Crr). Wind is unknown: headwind reads low, tailwind high.
- **Work line** under the gap: `work` = the energy (kJ) the ghost spent riding from you to where it is (+ = you're ahead). Unlike metres it doesn't shrink when the ghost slows on a climb. `used` = how much more energy you've used than the original to get to this point.
- **Stops**: stops in the reference are smoothed out (the ghost keeps riding instead of braking for its old red lights). When you stop, the gap goes back to what it was before you slowed down once you're up to speed again. Both can be turned off in Settings.
- **Turn-backs**: a stretch of the reference ridden back and forth is shown in the reference dialog on a small map, with **Cut it out** / **Keep it**.
- **Reset gap without touching the screen**: Enter, space, Page Up/Down or arrow keys (Bluetooth remote or keyboard), headset buttons, and the volume keys if Chrome passes them on. **Settings → Button test** shows what arrives.
- A ride carries on after the page reloads (within 3 h): same ride, same gap, same trail; GPS restarts by itself, the HR strap needs one tap. On the reference map your own path is drawn too (shows detours).

## Cadence sensor

**Cadence** (phone: **Cad**) connects a Bluetooth cadence sensor (Cycling Speed and Cadence, e.g. CYCPLUS). Its cadence is shown on the phone, saved in the ride and the .fit, and on the tablet it takes the place of the trainer's cadence. Dual ANT+/Bluetooth sensors work with the watch and the phone at the same time: pair the watch over **ANT+**, the phone uses Bluetooth.

## GoPro MAX .360 straight into a ride video

`Make Ride Video.command` now converts the GoPro MAX's own `.360` files itself (no GoPro Player export needed): put the watch `.fit` and all `.360` chapters of the ride in one folder and run it. Each chapter's two lens tracks become one 360° (equirectangular) video (ffmpeg; on a Mac with the hardware HEVC encoder, about as long as the ride), the chapters are joined, and the camera's gravity sensor is stored with the ride, so the video screen keeps the horizon level by itself (the Level sliders still fine-tune). Full-length GoPro Player exports in the folder are still used when present.

## Brake, and the trainer stops with the ride

- **Brake** (trainer and video screens; or Page Up / ← on a remote or keyboard): the virtual bike brakes hard (about 3 m/s²) and the trainer gets a light uphill instead of the descent, so a trainer with a motor stops pushing. It lets go by itself once you've stopped and pedal again, or tap it again.
- When you stop pedaling, the trainer never gets a descent (flat instead). On **Stop**, at the finish, on **New ride** or when the page closes, the trainer is set flat and sent the FTMS Stop command.
- Bluetooth remotes: Page Down / → / Enter reset the gap; Page Up / ← brake. A presenter clicker (Bluetooth, not a USB dongle on the phone) has exactly these two buttons. Settings → Button test shows what arrives.

## Team rides

**☰ → Team rides** adds more rides of the same route (.fit or .zip, several at once) to the current reference. Each one races along as a coloured dot on the map and the elevation profile, on all screens; the numbers (gap, power, work) stay those of the reference ghost. A team ride starts where it passes the reference's start, is laid onto the reference route (detours hold its position), uses the same clock as the ghost (Reset gap moves them all), and gets its stops smoothed out like the reference. Rides of another route are refused.

## Fast forward

The slider under the elevation profile (trainer and video screens) moves the ghost along the route; the team rides move with it, on the same clock, with their stops smoothed out. With **me too** ticked you go to the same spot (gap 0), so you can skip a part of the ride together; untick it to move only the ghost and the team. The distance shown is then where you are on the route, with the distance actually ridden beside it.

## Play the original ride

**▶** next to the fast-forward slider (trainer and video screens) plays the original ride by itself at normal speed, from where the ghost is: video, map position, elevation dot, numbers (the original's power, heart rate, speed) and the team. Stops are left out (moving time). No trainer control, and nothing is saved. **⏸** (or Pause) stops it; the slider jumps it; **Start** then begins your own ride from that spot.

## Ride library (Mac) and phone-size rides

- **Clips → Ride library**: choose the folder that holds your rides once (e.g. *garmin*); every `RideVideo_….mp4` in it and its subfolders is listed, one per ride, named after its folder, with date, distance, climbing and riding time. **Ride this** opens it (full-resolution 360°, look around as before). Tick **validated** on rides you've checked: they're listed first. Chrome asks once per visit to read the folder again (**Open library**).
- **Phone-size copy**: `Make Phone Version.command` (or `make_ride_video.py --phone RideVideo_….mp4`) makes `RideVideo_…_phone.mp4`: 2560 × 1280 H.264, about 2.7 GB per hour, same ride inside. Copy it onto the phone (iPhone: AirDrop → Save to Files), open the video screen (`#video`) in Safari, **Clips** → pick it, **▶** to play the ride. Turn the phone sideways. iPhones have no Web Bluetooth, so the sensor and trainer buttons are hidden there; Play, the map, the numbers and looking around (drag) work.
