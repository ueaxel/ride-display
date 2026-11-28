# Ride Sync

Copies your rides from a Garmin watch into one folder on the Mac, `~/Rides`, so Ride Compare (and anything else) finds them in one place.

- **From the watch, automatically.** Plug the watch into the Mac with its USB cable. Within a minute, every activity file not yet in `~/Rides/watch` is copied there and a notification says how many. These are the watch's complete original files. Nothing on the watch is changed or deleted.
- **Your older rides, once.** Garmin's "Export Your Data" download holds every activity you ever uploaded. `Import Garmin Export.command` copies all its `.fit` files into `~/Rides/garmin-export`.

## Install (once)

Double-click **Install Ride Sync.command**. It installs `libmtp` with Homebrew (Garmin watches such as the Forerunner 265 use MTP over USB, so they don't show up in Finder), creates `~/Rides`, and starts a small background agent that checks once a minute whether a Garmin is plugged in. It syncs once per plug-in.

Run it again after an update.

## Everyday use

| Want to | Do |
| --- | --- |
| Copy new rides | Plug in the watch. Or double-click **Sync Rides Now.command**. |
| Load your older rides | Request your data at Garmin (Account › Data Management › Export Your Data), download the .zip from the email, double-click **Import Garmin Export.command** and pick the .zip. |
| Stop the background agent | **Uninstall Ride Sync.command** (`~/Rides` stays). |
| See what happened | `~/Library/Application Support/RideSync/ride-sync.log` |

## Beat-to-beat heart rate

To have the watch save every heartbeat interval from the HRM 200 in its files, turn on **Log HRV** in the watch's data recording settings (Settings › System › Data Recording; on some watches under System › Advanced). It is off by default. The wrist sensor does not provide beat intervals.

## If it can't read the watch

Only one program can talk to the watch at a time. Ride Sync stops macOS's camera service (which grabs such devices) before each step. If Garmin Express or OpenMTP is open, quit it, then unplug and plug in the watch again.
