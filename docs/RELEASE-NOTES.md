# Turbine Coal Simulator — v1.0.0

Released 2026-09-29 · build [`58a340b`](https://github.com/mikeehendricks/TurbineCoalSimulator/commit/58a340b115548c5521a8b919ad88ac74d15af427) · tag `v1.0.0`

A 2 × 930 t/h twin-boiler, 660 MWe, 50 Hz coal-fired power plant operator
training simulator for Ubuntu Server. This is the first tagged release: every
build before it was identified only by its commit.

## Operator console

- **Full lifecycle** — cold start-up (prestart → purge → light-off →
  pressurising → turbine roll → synchronising → loading) through to normal
  shutdown, coast-down and trips.
- **Autopilot** — starts the unit from cold, runs it up and loads to 500 MW at
  the qualified 6 MW/min, holds on HIGH/CRITICAL alarms, reports MEDIUM/LOW ones
  as advisory, and disengages immediately on an MFT or turbine trip.
- **RESET PLANT** — returns the simulator to a cold, stopped unit, clearing
  faults, trips, the event journal and the plant clock (two-click confirm).
- **34 injectable faults**, each with cause, symptoms and operator actions.
- **Guided 13-step cold start-up tutorial** with live plant readouts.
- **Live synthesised plant sound** driven by the model — no audio files, works
  offline.
- **3D station view** with nine camera presets, mimic panels, trends and an
  alarm list.
- **Build stamp** — version and source commit in the bottom bar.

## Administration

- Hidden one-time-registration console at `/admin`, not linked anywhere on the
  public site, disallowed in `robots.txt`.
- Visitor list showing public WAN IP and geolocation.
- Update system that reads version and source from this repository.
- `tcs-update status | apply --restart | log`, installed to `/usr/local/bin` by
  the installer.
- `tools/admin-reset.js` recovers the console when the one-time registration is
  lost; `tools/git-auth.sh` installs git credentials without leaking them.

## Install (Ubuntu Server)

```bash
git clone https://github.com/mikeehendricks/TurbineCoalSimulator.git
cd TurbineCoalSimulator
sudo bash install.sh
```

## Test programme

84 automated checks pass; 2 known failures.

| Suite | Result |
|---|---|
| Plant model & physics | 21 / 23 |
| HTTP & WebSocket API | 15 / 15 |
| Usability & front-end | 26 / 26 |
| Security & vulnerabilities | 22 / 22 |

The two failures are documented limits, not regressions: determinism between
plants sharing one Node process, and 600× real-time throughput. Full detail in
[`docs/executive-test-report.html`](./executive-test-report.html).

## Upgrading

```bash
tcs-update status              # check against GitHub
tcs-update apply --restart     # install and restart the service
```
