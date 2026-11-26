# 0002 · AntLive transmits on the public ANT network

Date: 2026-11-26 · Status: Accepted · Supersedes part of [0001](0001-ant-live-reader.md) (decision 3: AntLive on the ANT+ network)

## Context

On the FR265, AntLive failed to open its channel. The Connect IQ simulator gave the reason:
"Master channels on the ANT+ network are not allowed." Connect IQ apps may only receive on
the ANT+ network, not transmit.

## Decision

- AntLive transmits on the **public ANT network** (network key all zeros), still on 2457 MHz,
  device type `0x42`, transmission type `0x05`, 4 Hz. Page layout unchanged.
- The stick's continuous scan mode listens to one network at a time, so the page has a switch:
  **Garmin watches (AntLive)** (public network, the default) or **ANT+ sensors & heart-rate
  broadcast** (ANT+ network). Switching re-configures the running stick. The choice is remembered
  per browser.

## Consequences

- One stick shows either AntLive watches or ANT+ devices, not both at once. Both at once would
  need a second stick, or the page giving up scan mode for one channel per device type.
- The ANT+ key is only used for listening, which removes the adopter-terms concern in 0001 for
  AntLive itself.
- Found with the simulator (`Preview AntLive.command`), which reports such errors in full;
  the watch cut the message off.
