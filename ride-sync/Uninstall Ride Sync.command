#!/bin/bash
# Stops the background agent. Your ~/Rides folder and libmtp are left alone.
launchctl bootout "gui/$(id -u)/com.ueaxel.ridesync" >/dev/null 2>&1
rm -f "$HOME/Library/LaunchAgents/com.ueaxel.ridesync.plist"
echo "Ride Sync agent removed. ~/Rides is unchanged."
