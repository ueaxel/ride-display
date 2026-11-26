# 0001 · ANT Live: watch values on the Mac through an ANT USB stick

Date: 2026-11-26 · Status: Accepted; decision 3 superseded by [0002](0002-antlive-public-network.md)

## Context

Wanted: a page on the Mac that shows, in real time, every value a Garmin watch measures,
received through the ANT USB stick, for the FR265 and other Garmin watches.

A Garmin watch broadcasts only heart rate over ANT+ by itself (*Broadcast Heart Rate*). Power,
cadence, speed, distance, position, altitude and the rest are only sent if an app on the watch
sends them.

## Decision

1. **Page:** `ant-live/`, a plain web page (no install), Chrome on the Mac. It talks to the stick
   with **WebUSB** (ANT USB-m, `0fcf:1009`) or **Web Serial** (older ANT USB2 `0fcf:1008` and
   clones). The stick runs one channel in **continuous scan mode** on the ANT+ frequency with
   channel-ID and RSSI extended messages, so every ANT+ device in range is heard at once and
   sorted by device type and number. No pairing step, any number of watches.
2. **Watch side:** the **AntLive** data field (Garmin repo, `AntLive/`) opens an ANT+ transmit
   channel and sends eight pages at 4 Hz (layout in `AntLive/README.md`). A data field rather
   than a watch app, so it runs inside any normal activity and the watch keeps recording.
3. **Own device type `0x42`, transmission type `0x05`.** No ANT+ profile carries all these
   values. `0x42` is not used by any ANT+ profile we read, and the page checks the device type
   before decoding.
4. **Standard profiles too:** heart rate (watches' *Broadcast Heart Rate*, straps), bike power,
   speed/cadence, FE-C trainers, foot pods, temperature. Other device types are listed with their
   raw bytes.

## Consequences

- Any Connect IQ watch with ANT can run AntLive; only its product id goes into the manifest.
- Only one program can hold the stick: Garmin Express, Zwift, GoldenCheetah or another tab must
  let go of it first.
- The ANT+ network key is used for scanning and for AntLive's channel. Fine for personal use;
  publishing AntLive in the Connect IQ Store would need a look at the ANT+ adopter terms.
- Both sides of the page layout have tests with the same numbers
  (`tests/check_ant.mjs`, `AntLive/tests/LivePagesTests.mc`); change both together.
- Not yet verified with the real stick and watch (written 2026-11-26 without access to the Mac).
