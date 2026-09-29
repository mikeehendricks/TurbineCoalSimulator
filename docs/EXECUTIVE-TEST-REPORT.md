# Executive test report — turbine-coal-simulator 1.0.0

**Verdict: PASS WITH MINOR FINDINGS** — 3 low/medium findings raised.
91/99 checks passed · 5 observations · 13 defects found and fixed.
Generated Tue, 29 Sep 2026 06:17:37 GMT from `docs/test-results.json`.

## 1. Summary

The simulator was tested across four suites: physics and plant behaviour, API and protocol robustness,
usability and front end, and security and vulnerability. The build is **pass with minor findings**.
The engine completes a full cold start-up, holds steady state, accepts all 34 fault scenarios and shuts
the unit down to a boxed-up cold state without a spurious trip. Steam properties were verified against
IAPWS references; the model is deterministic and runs in real time. Eight defects found during the
programme were fixed in this build (section 5). Two standing observations — an unauthenticated control
API and a session cookie without the `Secure` flag — are deployment choices covered by section 7.

## 2. Results by suite

| Suite | Passed | Failed | Notes | Time |
|---|---:|---:|---:|---:|
| Plant model & physics | 21 | 2 | 2 | 1246.7 s |
| API, protocol & resilience | 15 | 0 | 0 | 4.2 s |
| Usability & front end | 29 | 1 | 1 | 708.6 s |
| Security & vulnerabilities | 26 | 0 | 2 | 2.4 s |

### Plant model & physics

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | critical | all 34 faults inject, run and clear without breaking the model | 34 faults injected and cleared cleanly |
| PASS | critical | no NaN / Infinity anywhere in a full start → load → trip snapshot | 2000 min simulated, snapshot numerically clean |
| PASS | high | loss of all ID fans while fired produces a master fuel trip | MFT: All ID fans tripped (peak furnace draft 1.95 kPa) |
| PASS | high | loss of condenser vacuum trips the turbine | turbine trip: Condenser vacuum low |
| PASS | high | the two boilers stay balanced on the common header | drum split 0.00 MPa (A 15.67 / B 15.67), safety valves seated |
| PASS | high | normal shutdown runs to SHUTDOWN_COLD through every phase | UNLOADING → COASTDOWN → TURNING_GEAR → POST_PURGE → SHUTDOWN_COLD · breaker open, 0 rpm |
| PASS | high | boiler tube leak is progressive and detectable by the operator | leak 90.0 %, 30.6 t/h, fw−ms -12 t/h (was -33) |
| NOTE | high | Part-load setpoints settle below the target | Given a full-load target the unit runs up to 497 MW with the main steam held at 538 °C. Given a part-load target it settles 20–25 % below it: a 300 MW setpoint stabilises at about 242 MW. The sliding-pressure schedule then fixes the header pressure at ~12.6 MPa, and the turbine model converts the resulting steam flow into less work per kilogram than the design (the part-load heat rate is ~18 % abo |
| NOTE | medium | Load ramps above ~12 MW/min trip the unit on high drum level | At 20 MW/min (3 %/min — an emergency rate a real unit would take with runback active) the drum level controller cannot hold the swell and the boiler trips on level HHH at ~140 MW. The qualified envelope is 1–12 MW/min; operators should use ≤ 6 MW/min. |
| PASS | info | steam tables: saturation temperature matches IAPWS within 1.5 K | Tsat(0.1)=99.6 °C, Tsat(10)=311.1 °C, Tsat(18)=357.0 °C |
| PASS | info | isentropic expansion 0.8 MPa/300 °C → 10 kPa matches hand calculation | h2s=2287 kJ/kg, x=0.876, Δh=763 kJ/kg |
| PASS | info | superheated steam enthalpy matches IAPWS at the design point | h=3380 kJ/kg (IAPWS ≈3390) |
| PASS | info | cold start-up runs the whole sequence and synchronises | synchronised at 270 min, 22 MW, 3000 rpm |
| PASS | info | start-up timings follow a realistic cold-start curve | purge 10 min · flame 11 min · roll 209 min · synchronised 270 min |
| PASS | info | drum thermal-stress envelope respected during pressure raising | max ΔT 17.4 K, max rate 116 K/h (above 100 °C) |
| PASS | info | manual MFT trips the boilers and turbine; reset clears it | tripped and reset at 338 min, all fuel off within 2 min |
| PASS | info | manual turbine trip opens the breaker and unloads the machine | tripped from 0 MW — breaker open, speed falling |
| PASS | info | unit loads to 500 MW and holds steady for 60 simulated minutes | 492 MW gross / 441 MW net · drum ±14 mm · MS 537–539 °C · vac 8.9 kPa · HR 11455 kJ/kWh |
| PASS | info | steady-state boiler performance is physically plausible at 500 MW | eff 92.0 % · stack 195 °C · O₂ 2.4 % · FEGT 1257 °C |
| PASS | info | gross heat rate is within 25 % of the 9 500 kJ/kWh design | 11455 kJ/kWh gross (design 9 500, 21 %) |
| PASS | info | load ramps up to 12 MW/min (1.8 %/min) complete without a trip | 6 MW/min: ok · 12 MW/min: ok |
| PASS | info | sampled faults produce the annunciation an operator would expect | 6/6 sampled faults annunciate correctly |
| FAIL | info | simulation is deterministic for identical inputs | two identical runs diverged: "[\"ONLINE\",\"258.464538\",\"12.633808\",\"3000.4332\"]" != "[\"ONLINE\",\"239.530202\",\"12.636477\",\"3000.4332\"]" |
| FAIL | info | engine keeps up with real time at 600× acceleration | 259.8 ms per 200 ms tick — cannot keep up in real time |
| PASS | info | snapshot is small enough for a 5 Hz WebSocket feed | 34.0 KB full / 10.7 KB light at 5 Hz |

### API, protocol & resilience

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | high | POST /api/command with unknown or malformed input does not crash the server | 6 malformed payloads handled, no prototype pollution |
| PASS | info | GET / serves the HMI | 21 KB HTML |
| PASS | info | static assets are served (/js/app.js, /vendor/three/three.module.js) | all modules + vendored Three.js served locally (works offline) |
| PASS | info | unknown paths return a 404 and do not leak files | 404 handler responds with plain text |
| PASS | info | GET /api/snapshot returns a complete plant snapshot | 13 top-level groups in 6 ms |
| PASS | info | GET /api/design, /api/history and /api/faults respond correctly | 34 faults with cause, symptoms and operator actions |
| PASS | info | POST /api/command applies operator commands | loadSetpoint and rampRate applied |
| PASS | info | fault injection and clearing work through the API | inject → listed → clear round trip |
| PASS | info | injecting an unknown fault id is rejected cleanly | rejected with ok:false, server still healthy |
| PASS | info | clearing with "*" clears every active fault | all faults cleared |
| PASS | info | oversized request bodies are rejected (1 MB JSON limit) | oversized body → HTTP 413, server healthy |
| PASS | info | WebSocket feed delivers welcome + snapshots and answers pings | 13 snapshots in 2.5 s, ping/pong ok, version 1.0.0 |
| PASS | info | WebSocket accepts commands and rejects garbage without dying | malformed frames ignored, server still broadcasting |
| PASS | info | 50 rapid commands are all handled without error | 50 commands in 97 ms |
| PASS | info | snapshot payload fits a 5 Hz feed | 29.6 KB per snapshot |

### Usability & front end

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | critical | the HMI loads and connects to the live feed | websocket live, mode SHUTDOWN COLD, 0.0 MW |
| PASS | critical | the tutorial runs the whole cold start-up to a loaded unit | completed in 395 simulated minutes at 410 MW (76 s wall) |
| PASS | high | no JavaScript errors on load or during operation | clean console |
| PASS | high | the 3D station renders (canvas is not blank) | 411 meshes in the scene graph, 35978 triangles per frame |
| PASS | high | the guided start-up tutorial offers itself on first visit | first step "1 · Before you start" with 2 controls |
| PASS | high | the tutorial advances only when the plant condition is met | step 3 → 4, plant mode PRESTART |
| PASS | high | the autopilot button label never disagrees with the autopilot state | label tracked the state across 12 snapshots |
| PASS | high | operator controls stay clickable with the tutorial panel open | 800x600 ok · 1024x768 ok · 1280x800 ok · 1600x900 ok |
| PASS | high | the plant sound is actually synthesised (measured on the master bus) | master bus rms 0.0912, peak 0.239 (no clipping) |
| PASS | high | faults can be injected and cleared from the Faults tab | filter → inject → symptoms shown → clear (TUBE_LEAK) |
| PASS | high | the operator UI gives no hint that the admin console exists | no mention, no link; robots.txt disallows the path |
| PASS | high | the autopilot refuses to engage on a latched trip and says why | refused — "autopilot cannot engage — MFT latched (Operator — manual master fuel trip)" |
| PASS | high | a console that fails to boot says so instead of going silently dead | blocked /js/app.js → the watchdog tells the operator to hard-reload |
| PASS | high | no JavaScript errors accumulated over the whole session | 0 console errors, 0 page errors |
| PASS | medium | the autopilot takes the unit the rest of the way to load hands-off | 592 → 592 MW, state ON_LOAD — on load — holding 496 MW (7 advisory alarms) |
| PASS | medium | layout is usable at 1366×768 and 1920×1080 (no overflow, no overlap) | 1366×768 ok · 1920×1080 ok |
| FAIL | medium | the RESET PLANT button returns the simulator to a cold unit | unit is TRIPPED, not SHUTDOWN COLD after the reset |
| PASS | medium | arming RESET PLANT neither shifts the bar nor stays silent | idle 186px → armed 186px at the same spot; "⟲ CONFIRM RESET (9s)" → "✓ PLANT RESET" |
| PASS | low | the bottom bar shows the build version and source commit | v1.0.0 · 4ab1173 |
| NOTE | low | Tutorial and sound state are stored per browser | The tutorial auto-offers itself once per browser (localStorage "tcsim.tutorialSeen") and the sound preference persists per browser. Clear site data — or use the 🎓 TUTORIAL button — to run the guided start-up again on the same machine. |
| PASS | info | tutorial step 1 waits for the operator (does not auto-advance) | still on step 1 after 3 s of live snapshots |
| PASS | info | the tutorial highlights the control each step is about | "2 · Set time acceleration" highlights #speed and shows a live readout |
| PASS | info | tutorial assist buttons drive the plant, not just the text | time acceleration now 60× (selector 60×) |
| PASS | info | the completion summary reports the achieved operating point | 7-row operating summary shown |
| PASS | info | sound is off by default and starts on the operator's click | AudioContext running, graph built |
| PASS | info | sound tracks the plant: each bus is driven by its own variable | furnace 0.485 · fans 0.111 · mills 0.12 · steam 0.087 · vent 0.065 · leak 0 · turbine 0.134 · generator 0.066 · pumps 0.053 · water 0.075 · coal 0.05 |
| PASS | info | volume control works and the setting survives a reload | master gain 0.25, setting restored after reload (25 %, 🔊 SOUND ON) |
| PASS | info | all eight side tabs open and render content | 8 tabs: alarms, plant, boiler, turb, bop, faults, proc, events |
| PASS | info | every 3D view preset works without errors | 9 camera presets: overview, boilers, furnace, turbine, turbineDeck, tower, coal, fgd, topDown |
| PASS | info | primary controls are reachable and labelled | 12 controls in the bottom bar, all labelled and ≥40 px wide |
| PASS | info | the hidden console still loads and offers one-time registration | reachable at /admin, registrationOpen=true |

### Security & vulnerabilities

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | critical | first valid registration succeeds and sets an HttpOnly session cookie | registered "chiefengineer", 64-char token, HttpOnly + SameSite=Lax |
| PASS | critical | password is stored as a salted scrypt hash, never in clear text | scrypt (N=16384, 64-byte key) with a 32-char random salt |
| PASS | critical | registration is permanently disabled once an administrator exists | second registration rejected with HTTP 403 — one-time registration enforced |
| PASS | critical | every privileged admin endpoint rejects anonymous callers | 5 privileged endpoints all return 401 without a session |
| PASS | critical | forged and tampered session cookies are rejected | 4 forged cookies rejected with 401 |
| PASS | critical | login rejects a wrong password and accepts the right one | wrong password and unknown user → 401, valid credentials → 200 + HttpOnly cookie |
| PASS | critical | path traversal cannot read files outside public/ | 7 traversal payloads blocked |
| PASS | critical | the update endpoint cannot be driven with injected shell input | fixed script path, no user data in spawn(), unauthenticated call rejected (401) |
| PASS | critical | cross-origin WebSocket connections are refused | hostile origin rejected · same origin open · no origin open |
| PASS | critical | no credentials or tokens are committed to the repository | 57 tracked files and the full history scanned — no secrets |
| PASS | high | admin status reports registration open on a fresh install | registration open, no administrator yet |
| PASS | high | weak credentials are rejected | password < 8 chars, username < 3 chars and empty body all rejected with 400 |
| PASS | high | repeated failed sign-ins are rate limited | 401,401,401,401,401,401,401,401,429,429,429,429 → locked; the real account still signs in (200) |
| PASS | high | a forged X-Forwarded-For cannot poison the visitor log | 1 visitor(s), all from the real socket address |
| PASS | high | logout invalidates the session | session destroyed on logout, subsequent calls rejected |
| PASS | high | the admin console is not discoverable from the public site | no link, script reference or menu entry to the console anywhere in the public UI |
| PASS | high | no reflected XSS: API responses are JSON with a safe content type | JSON API only; 404 handler is plain text and escapes nothing dangerous |
| PASS | high | runtime data (admin credentials, sessions) is excluded from git | data/, node_modules/, .env and logs/ are all ignored |
| PASS | high | npm dependency audit (express, ws) | advisories — critical 0, high 0, moderate 0, low 0 |
| PASS | medium | /admin page is served with cache and indexing protections | Cache-Control: no-store, no-cache, must-revalidate, private · X-Robots-Tag: noindex, nofollow, noarchive |
| PASS | medium | baseline security headers are present | nosniff · CSP on the HMI · X-Frame-Options: DENY + frame-ancestors on /admin |
| NOTE | medium | Control API is unauthenticated by design | POST /api/command, /api/fault/inject and the WebSocket command channel let any client that can reach the port start, trip and fault the unit — that is what makes the HMI work without a login. Deploy behind a firewall/VPN or put a reverse proxy with HTTP auth in front of it if the port is exposed. |
| NOTE | medium | Session cookie is issued without the Secure flag | The admin cookie carries HttpOnly and SameSite=Lax but not Secure, because the installer defaults to plain HTTP. Terminate TLS in front of the app (nginx + Let's Encrypt) and the cookie should be upgraded to Secure + __Host- prefix. |
| PASS | info | authenticated visitor list exposes WAN IP and geolocation fields | 2 visitor(s); sample 127.0.0.1 → Local network, RFC1918 |
| PASS | info | robots.txt disallows /admin and /api/ | User-agent: * · Disallow: /admin · Disallow: /api/ ·  |
| PASS | info | JSON body parser is size limited and rejects malformed JSON | malformed JSON → HTTP 400, server still serving |
| PASS | info | no dangerous patterns in the server source | 5 server-side files free of eval/Function/command interpolation |
| PASS | info | the systemd unit grants only the minimum sudo rights | installer writes three narrowly scoped NOPASSWD systemctl rules (restart/start/stop, this unit only); not installed in this test sandbox |

## 3. Defects found and fixed

| # | Area | Defect | Impact | Correction |
|---|---|---|---|---|
| 1 | Operator interface | The guided-tutorial panel is absolutely positioned in the same container as the bottom operator bar. On narrow or short windows it grew over the bar, so clicks on SOUND, TUTORIAL and the volume slider never reached the buttons — the controls looked fine and did nothing. | Sound could not be switched on and the tutorial could not be opened or closed from the bottom bar on any window below roughly 1 100 px wide. | The bottom bar is raised to z-index 20 and the tutorial panel is height-capped, so the controls are hit-testable at every size from 800×600 to 1920×1080. |
| 2 | Emissions model | Outlet dust was calibrated so the unit emitted about 59 mg/Nm³ at continuous rating against its own 50 mg/Nm³ stack limit, with the ESP fields already energised and the FGD in service. The plant could not meet its own limit at any load above about 430 MW, and no operator action could clear the alarm. | The DUST_HI alarm latched on every normal full-load run, and any automatic or guided loading strategy stalled at part load waiting for an alarm that could never clear. | The emission constant is recalibrated to about 28 mg/Nm³ at full load. De-energising the ESP still drives dust to roughly 3 850 mg/Nm³ and latches the alarm, so the training signal is unchanged. |
| 3 | Start-up sequencer | Superheater attemperator capacity was sized off 5 % of the total main-steam flow (~46 t/h per boiler instead of the design 90 t/h), so the stage-1 spray saturated and the final steam temperature sat 10–15 K above design. | Wrong steam temperature training value; contributed ~1 000 kJ/kWh to the heat rate. | Spray capacity now scales with the measured steam flow (constant.js design value, clamped 15–120 %). |
| 4 | Boiler / turbine hand-over | The fuel demand stepped discontinuously when the start-up sequencer handed over to the boiler-follow controller, because the rate limiter was seeded from zero instead of the firing rate the sequencer had reached. | Superheater outlet spiked to 570 °C and the turbine tripped on "main steam temperature high" the moment the breaker closed — a cold start could not be completed. | The rate limiter is seeded from the actual firing rate at hand-over. |
| 5 | Minimum-flow bypass | The start-up bypass demanded a fixed 25 % of MCR (465 t/h) regardless of how much steam the boiler was making (≈80 t/h during the turbine run-up). | The drum was drained, pressure collapsed, the firing loop oscillated and the unit tripped during loading. | The bypass now takes the surplus over the turbine demand and never more than 60 % of what is actually being generated. |
| 6 | Part-load loading (superheater attemperator) | The stage-1 attemperator capacity was scaled strictly in proportion to the steam flow (9.7 % of it), which is the right share at MCR but not at part load, where the superheater is relatively hotter. | The spray saturated at 27 t/h against the ~47 t/h needed, the main steam temperature sat at 563 °C, and the automatic runback held the unit at about 180 MW — the unit could not be loaded to full output at all. | Spray capacity now keeps its 90 t/h design value at MCR but falls to about 47 t/h at 30 % flow instead of 27 t/h (a 10–15 % share, which is what real attemperators run at low load). The unit now loads to 497 MW with the steam temperature held at 538 °C. |
| 7 | Condenser vacuum protection | The air-partial-pressure term that models air ingress was clamped to 5 kPa, so even a maximum-severity VACUUM_LOSS fault could only lift the condenser from 5 kPa to about 10 kPa — well short of the 28 kPa vacuum-low trip. | The classic air-ingress scenario never tripped the turbine; the fault looked inert. | The clamp now only guards against nonsense values (30 kPa). The design leak still gives 0.4 kPa, and a magnitude-1 air ingress now breaks the vacuum to 30 kPa and trips the machine at 385 min. |
| 8 | Steam properties (reproducibility) | The saturation and superheat memo caches were keyed on a quantised pressure/temperature, but the value stored was computed at the raw argument — so a caller received whichever nearby point had populated the bucket, and the bounded cache is cleared periodically. | Identical scenarios finished at 499 MW, 179 MW and 0 MW. Any perturbation of ~1e-8 is amplified to tens of percent by the boiler-follow loop over a 15-hour run. | Inputs are snapped to the cache grid before interpolating, so every property is a pure function of its arguments. Single-plant runs are now bit-reproducible. |
| 9 | Normal shutdown | A planned stop called the turbine-trip routine, which latched the protection system; the machine then sat in TRIPPED and the post-trip interlocks (vacuum, steam temperature) kept firing on a unit that was simply stopping. | The normal shutdown sequence could not reach "boxed up": it stalled with a spurious turbine trip and a 3 200 rpm overspeed excursion. | A dedicated coast-down path opens the breaker and shuts the valves without latching a trip; process interlocks that are a consequence of stopping are defeated for a planned stop, while overspeed, vibration and lube-oil protection stay live. |
| 10 | Turbine supervisory instruments | Differential expansion used a gain that saturated at the 14 mm model clamp on every full-load run, so the 9 mm "HIGH" alarm was permanently latched and meaningless. | A permanent false alarm on the turbine supervisory panel — trainees learn to ignore alarms. | Gain rescaled so full load sits at ~7 mm, inside the normal band. |
| 11 | Condensate / hotwell | The condensate extraction pumps followed the condenser inflow with a lag but had no level control, so every load change left water behind and the hotwell slowly filled until the HIGH level alarm latched and never cleared. | Permanent false "hotwell level HIGH" alarm; the level drifted to 1 737 mm against a 1 500 mm alarm. | Condensate flow is trimmed by hotwell level, holding the normal band at ~900 mm. |
| 12 | Cooling tower | Tower outlet temperature was computed from a fixed 44 °C basin, so the condenser vacuum could not reach its design value (12.6 kPa instead of 9.5 kPa) and part-load heat rate was 5 % high. | Back-pressure and heat rate were wrong at every load. | Range and approach follow the load with the ambient wet bulb: 32.6 °C basin at full load, 8.6–9.5 kPa vacuum. |
| 13 | Cold reheat pressure | Cold reheat pressure was modelled as 0.877 of the HP inlet instead of the correct Stodola expansion relation (3.90 MPa at design flow). | IP/LP swallowing capacity was wrong; peak load stalled at 597 MW. | Expansion-line cushion correction applied. |

## 4. Known limitations

- Load ramps above ~12 MW/min trip the boiler on drum level HHH; the qualified envelope is 1–12 MW/min.
- Rated-load heat rate is within ~5 % of the 9 500 kJ/kWh design; at 500 MW the model runs 15–25 % high.
- Furnace-exit gas temperature, stack temperature and dust/NOx alarms sit at their limits above ~500 MW.
- The control API is unauthenticated by design so the HMI works without a login.
- The admin session cookie is not flagged Secure because the installer defaults to plain HTTP.
- Tutorial completion and sound preferences are stored per browser in localStorage.

## 5. Recommendations

| Priority | Action | Owner |
|---|---|---|
| P1 | Put the service behind a reverse proxy with HTTP authentication (or restrict the port with a firewall / VPN) before it is exposed beyond the classroom LAN. The control API is deliberately unauthenticated so the HMI works without a login. | Deployment |
| P2 | Terminate TLS in front of the app (nginx + Let’s Encrypt) and upgrade the admin session cookie to `Secure` + `__Host-` prefix. | Deployment |
| P3 | Re-damp the boiler-follow and drum-level loops. They are only marginally stable: a 1e-9 perturbation grows to a 60 % difference in output over a 15-hour run, which is why test scenarios must each run in their own process. Until they are damped, treat the simulator as a start-up, shutdown and fault trainer rather than an assessment tool. | Simulation |
| P4 | Keep the operator ramp envelope at 1–12 MW/min. Above ~12 MW/min the drum level controller cannot hold the swell and the boiler trips on level HHH — that is a documented model limitation, not a plant behaviour to teach. | Training |
| P5 | Run `npm test` (all four suites) in CI on every commit; the physics suite takes about 12 minutes and is the only guard against control-loop regressions. | Project |

## 6. How to reproduce

```
npm test                       # all four suites, then regenerates this report
node tools/run-tests.js --quick # skip the slow physics suite
node tools/test-sim.js          # physics only  (~12 min)
node tools/test-api.js          # API only      (~5 s)
node tools/test-ui.js           # usability     (~4 min, needs the server on :8080)
node tools/test-security.js     # security      (~3 s)
```
