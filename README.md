# Ride Display

One web page with two screens. It runs in Chrome; nothing to install.

| Screen | Device | Reads | Shows |
|---|---|---|---|
| **Trainer** (`#trainer`) | TCL tablet beside the trainer | R200 over Bluetooth (FTMS, or Cycling Power), HRM 200 strap | power, HR, cadence, route map with you and the ghost, elevation, HR vs power, power/HR over time, HR response to power steps |
| **Handlebar** (`#ghost`) | Pixel 3a on the bars | phone GPS, HRM 200 strap | gap to the ghost in metres and seconds, gauge, heading-up map, HR and speed against the original |

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

## HR response panel

Each clear power step (≥ 40 W, held for a minute) gets a fit of the next 2 minutes of heart rate to a first-order response with a dead time: delay, then time constant τ. This is the simple form of the delay and response times in de Leeuw et al. 2025 (see the project's LITERATURE.md). Power drops also give the 60-s HR recovery. The panel shows medians of the fits with R² ≥ 0.8.

## Hosting and riding outside

The live copy is at **https://ueaxel.github.io/ride-display/**, published from the public repo `ueaxel/ride-display`, which holds a copy of this folder. Web Bluetooth and GPS only work on an `https://` page in Chrome (Android, Mac, Windows; not iPhone).

On the Pixel, at home on Wi-Fi: open the address in Chrome, then ⋮ → **Add to Home screen**, then load the reference (this also downloads the streets). After that, the app, the reference and the streets are stored on the phone, and the ride works with no internet. GPS and Bluetooth don't need a network. Keep the page in front with the screen on: the page asks Chrome to keep the screen on, but if you switch apps or lock the phone, Chrome pauses the page.

## Tests

```
python3 Display/tests/check_reference.py   # JS profile/power vs the Python tools
node Display/tests/check_parsers.mjs        # Bluetooth packets, step fits
```
