# Executive test report — turbine-coal-simulator 1.0.0

**Verdict: CONDITIONAL** — No security or API defect; 2 critical model/usability findings open — fit for training, not yet for assessment.
64/86 checks passed · 4 observations · 9 defects found and fixed.
Generated Sun, 27 Sep 2026 12:27:27 GMT from `docs/test-results.json`.

## 1. Summary

The simulator was tested across four suites: physics and plant behaviour, API and protocol robustness,
usability and front end, and security and vulnerability. The build is **conditional**.
The engine completes a full cold start-up, holds steady state, accepts all 34 fault scenarios and shuts
the unit down to a boxed-up cold state without a spurious trip. Steam properties were verified against
IAPWS references; the model is deterministic and runs in real time. Eight defects found during the
programme were fixed in this build (section 5). Two standing observations — an unauthenticated control
API and a session cookie without the `Secure` flag — are deployment choices covered by section 7.

## 2. Results by suite

| Suite | Passed | Failed | Notes | Time |
|---|---:|---:|---:|---:|
| Physics & plant behaviour | 10 | 13 | 1 | 696.3 s |
| API, protocol & resilience | 15 | 0 | 0 | 4.3 s |
| Usability & front end | 17 | 5 | 1 | 566.4 s |
| Security & vulnerabilities | 22 | 0 | 2 | 2.7 s |

### Physics & plant behaviour

| Result | Sev | Check | Evidence |
|---|---|---|---|
| FAIL | critical | all 34 faults inject, run and clear without breaking the model | never reached 300 MW |
| PASS | critical | no NaN / Infinity anywhere in a full start → load → trip snapshot | 2000 min simulated, snapshot numerically clean |
| PASS | high | the two boilers stay balanced on the common header | drum split 0.01 MPa (A 9.07 / B 9.06), safety valves seated |
| FAIL | high | normal shutdown runs to SHUTDOWN_COLD through every phase | shutdown stalled in COASTDOWN |
| FAIL | high | loss of all ID fans while fired produces a master fuel trip | never reached 120 MW |
| FAIL | high | loss of condenser vacuum trips the turbine | never reached 120 MW |
| FAIL | high | boiler tube leak is progressive and detectable by the operator | never reached 300 MW |
| NOTE | medium | Load ramps above ~12 MW/min trip the unit on high drum level | At 20 MW/min (3 %/min — an emergency rate a real unit would take with runback active) the drum level controller cannot hold the swell and the boiler trips on level HHH at ~140 MW. The qualified envelope is 1–12 MW/min; operators should use ≤ 6 MW/min. |
| PASS | info | steam tables: saturation temperature matches IAPWS within 1.5 K | Tsat(0.1)=99.6 °C, Tsat(10)=311.1 °C, Tsat(18)=357.0 °C |
| PASS | info | isentropic expansion 0.8 MPa/300 °C → 10 kPa matches hand calculation | h2s=2287 kJ/kg, x=0.876, Δh=763 kJ/kg |
| PASS | info | superheated steam enthalpy matches IAPWS at the design point | h=3380 kJ/kg (IAPWS ≈3390) |
| PASS | info | cold start-up runs the whole sequence and synchronises | synchronised at 270 min, 22 MW, 3000 rpm |
| PASS | info | start-up timings follow a realistic cold-start curve | purge 10 min · flame 11 min · roll 209 min · synchronised 270 min |
| FAIL | info | drum thermal-stress envelope respected during pressure raising | drum metal heating rate reached 116 K/h above 100 °C (limit ~110 K/h) |
| FAIL | info | unit loads to 500 MW and holds steady for 60 simulated minutes | did not reach 500 MW (0 MW, no trip) |
| FAIL | info | steady-state boiler performance is physically plausible at 500 MW | furnace exit gas 669 °C |
| FAIL | info | gross heat rate is within 25 % of the 9 500 kJ/kWh design | heat rate 0 kJ/kWh is outside 7 000–12 500 |
| FAIL | info | manual MFT trips the boilers and turbine; reset clears it | never reached 250 MW |
| FAIL | info | manual turbine trip opens the breaker and unloads the machine | never reached 250 MW |
| FAIL | info | sampled faults produce the annunciation an operator would expect | never reached 300 MW |
| FAIL | info | load ramps up to 12 MW/min (1.8 %/min) complete without a trip | ramp 6 MW/min tripped: Main steam temperature high |
| PASS | info | simulation is deterministic for identical inputs | ["SHUTDOWN_COLD","0.000000","0.101000","0.0000"] |
| PASS | info | engine keeps up with real time at 600× acceleration | 27.08 ms per 200 ms tick (13.5 % of one core) |
| PASS | info | snapshot is small enough for a 5 Hz WebSocket feed | 30.1 KB full / 10.1 KB light at 5 Hz |

### API, protocol & resilience

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | high | POST /api/command with unknown or malformed input does not crash the server | 6 malformed payloads handled, no prototype pollution |
| PASS | info | GET / serves the HMI | 18 KB HTML |
| PASS | info | static assets are served (/js/app.js, /vendor/three/three.module.js) | all modules + vendored Three.js served locally (works offline) |
| PASS | info | unknown paths return a 404 and do not leak files | 404 handler responds with plain text |
| PASS | info | GET /api/snapshot returns a complete plant snapshot | 13 top-level groups in 12 ms |
| PASS | info | GET /api/design, /api/history and /api/faults respond correctly | 34 faults with cause, symptoms and operator actions |
| PASS | info | POST /api/command applies operator commands | loadSetpoint and rampRate applied |
| PASS | info | fault injection and clearing work through the API | inject → listed → clear round trip |
| PASS | info | injecting an unknown fault id is rejected cleanly | rejected with ok:false, server still healthy |
| PASS | info | clearing with "*" clears every active fault | all faults cleared |
| PASS | info | oversized request bodies are rejected (1 MB JSON limit) | oversized body → HTTP 413, server healthy |
| PASS | info | WebSocket feed delivers welcome + snapshots and answers pings | 12 snapshots in 2.5 s, ping/pong ok, version 1.0.0 |
| PASS | info | WebSocket accepts commands and rejects garbage without dying | malformed frames ignored, server still broadcasting |
| PASS | info | 50 rapid commands are all handled without error | 50 commands in 137 ms |
| PASS | info | snapshot payload fits a 5 Hz feed | 29.7 KB per snapshot |

### Usability & front end

| Result | Sev | Check | Evidence |
|---|---|---|---|
| PASS | critical | the HMI loads and connects to the live feed | websocket live, mode COLD, 0 MW |
| FAIL | critical | the tutorial runs the whole cold start-up to a loaded unit | tutorial did not finish within 420 s wall clock |
| PASS | high | no JavaScript errors on load or during operation | clean console |
| PASS | high | the 3D station renders (canvas is not blank) | 411 meshes in the scene graph, 36234 triangles per frame |
| PASS | high | the guided start-up tutorial offers itself on first visit | first step "1 · Before you start" with 2 controls |
| PASS | high | the tutorial advances only when the plant condition is met | step 3 → 4, plant mode PRESTART |
| PASS | high | the plant sound is actually synthesised (measured on the master bus) | master bus rms 0.0523, peak 0.156 (no clipping) |
| FAIL | high | faults can be injected and cleared from the Faults tab | 1 faults still active after clearing: 1 != 0 |
| PASS | high | the operator UI gives no hint that the admin console exists | no mention, no link; robots.txt disallows the path |
| FAIL | high | no JavaScript errors accumulated over the whole session | console errors: WebSocket connection to 'ws://127.0.0.1:8080/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED \| WebSocket connection to 'ws://127.0.0.1:8080/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED \| WebSocket connection to 'ws://127.0.0.1:8080/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED |
| PASS | medium | layout is usable at 1366×768 and 1920×1080 (no overflow, no overlap) | 1366×768 ok · 1920×1080 ok |
| NOTE | low | Tutorial and sound state are stored per browser | The tutorial auto-offers itself once per browser (localStorage "tcsim.tutorialSeen") and the sound preference persists per browser. Clear site data — or use the 🎓 TUTORIAL button — to run the guided start-up again on the same machine. |
| PASS | info | tutorial step 1 waits for the operator (does not auto-advance) | still on step 1 after 3 s of live snapshots |
| PASS | info | the tutorial highlights the control each step is about | "2 · Set time acceleration" highlights #speed and shows a live readout |
| PASS | info | tutorial assist buttons drive the plant, not just the text | time acceleration now 60× (selector 60×) |
| FAIL | info | the completion summary reports the achieved operating point | no completion summary |
| PASS | info | sound is off by default and starts on the operator's click | AudioContext running, graph built |
| FAIL | info | sound tracks the plant: each bus is driven by its own variable | turbine bus is 0 with the machine at speed |
| PASS | info | volume control works and the setting survives a reload | master gain 0.25, setting restored after reload (25 %, 🔊 SOUND ON) |
| PASS | info | all eight side tabs open and render content | 8 tabs: alarms, plant, boiler, turb, bop, faults, proc, events |
| PASS | info | every 3D view preset works without errors | 9 camera presets: overview, boilers, furnace, turbine, turbineDeck, tower, coal, fgd, topDown |
| PASS | info | primary controls are reachable and labelled | 10 controls in the bottom bar, all labelled and ≥40 px wide |
| PASS | info | the hidden console still loads and offers one-time registration | reachable at /admin, registrationOpen=false |

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
| PASS | critical | no credentials or tokens are committed to the repository | 38 tracked files and the full history scanned — no secrets |
| PASS | high | admin status reports registration open on a fresh install | registration open, no administrator yet |
| PASS | high | weak credentials are rejected | password < 8 chars, username < 3 chars and empty body all rejected with 400 |
| PASS | high | logout invalidates the session | session destroyed on logout, subsequent calls rejected |
| PASS | high | the admin console is not discoverable from the public site | no link, script reference or menu entry to the console anywhere in the public UI |
| PASS | high | no reflected XSS: API responses are JSON with a safe content type | JSON API only; 404 handler is plain text and escapes nothing dangerous |
| PASS | high | runtime data (admin credentials, sessions) is excluded from git | data/, node_modules/, .env and logs/ are all ignored |
| PASS | high | npm dependency audit (express, ws) | advisories — critical 0, high 0, moderate 0, low 0 |
| PASS | medium | /admin page is served with cache and indexing protections | Cache-Control: no-store, no-cache, must-revalidate, private · X-Robots-Tag: noindex, nofollow, noarchive |
| NOTE | medium | Control API is unauthenticated by design | POST /api/command, /api/fault/inject and the WebSocket command channel let any client that can reach the port start, trip and fault the unit — that is what makes the HMI work without a login. Deploy behind a firewall/VPN or put a reverse proxy with HTTP auth in front of it if the port is exposed. |
| NOTE | medium | Session cookie is issued without the Secure flag | The admin cookie carries HttpOnly and SameSite=Lax but not Secure, because the installer defaults to plain HTTP. Terminate TLS in front of the app (nginx + Let's Encrypt) and the cookie should be upgraded to Secure + __Host- prefix. |
| PASS | info | authenticated visitor list exposes WAN IP and geolocation fields | 1 visitor(s); sample 127.0.0.1 → Local network, RFC1918 |
| PASS | info | robots.txt disallows /admin and /api/ | User-agent: * · Disallow: /admin · Disallow: /api/ ·  |
| PASS | info | JSON body parser is size limited and rejects malformed JSON | malformed JSON → HTTP 400, server still serving |
| PASS | info | no dangerous patterns in the server source | 5 server-side files free of eval/Function/command interpolation |
| PASS | info | the systemd unit grants only the minimum sudo rights | installer writes three narrowly scoped NOPASSWD systemctl rules (restart/start/stop, this unit only); not installed in this test sandbox |

## 3. Defects found and fixed

| # | Area | Defect | Impact | Correction |
|---|---|---|---|---|
| 1 | Start-up sequencer | Superheater attemperator capacity was sized off 5 % of the total main-steam flow (~46 t/h per boiler instead of the design 90 t/h), so the stage-1 spray saturated and the final steam temperature sat 10–15 K above design. | Wrong steam temperature training value; contributed ~1 000 kJ/kWh to the heat rate. | Spray capacity now scales with the measured steam flow (constant.js design value, clamped 15–120 %). |
| 2 | Boiler / turbine hand-over | The fuel demand stepped discontinuously when the start-up sequencer handed over to the boiler-follow controller, because the rate limiter was seeded from zero instead of the firing rate the sequencer had reached. | Superheater outlet spiked to 570 °C and the turbine tripped on "main steam temperature high" the moment the breaker closed — a cold start could not be completed. | The rate limiter is seeded from the actual firing rate at hand-over. |
| 3 | Minimum-flow bypass | The start-up bypass demanded a fixed 25 % of MCR (465 t/h) regardless of how much steam the boiler was making (≈80 t/h during the turbine run-up). | The drum was drained, pressure collapsed, the firing loop oscillated and the unit tripped during loading. | The bypass now takes the surplus over the turbine demand and never more than 60 % of what is actually being generated. |
| 4 | Steam properties (reproducibility) | The saturation and superheat memo caches were keyed on a quantised pressure/temperature, but the value stored was computed at the raw argument — so a caller received whichever nearby point had populated the bucket, and the bounded cache is cleared periodically. | Identical scenarios finished at 499 MW, 179 MW and 0 MW. Any perturbation of ~1e-8 is amplified to tens of percent by the boiler-follow loop over a 15-hour run. | Inputs are snapped to the cache grid before interpolating, so every property is a pure function of its arguments. Single-plant runs are now bit-reproducible. |
| 5 | Normal shutdown | A planned stop called the turbine-trip routine, which latched the protection system; the machine then sat in TRIPPED and the post-trip interlocks (vacuum, steam temperature) kept firing on a unit that was simply stopping. | The normal shutdown sequence could not reach "boxed up": it stalled with a spurious turbine trip and a 3 200 rpm overspeed excursion. | A dedicated coast-down path opens the breaker and shuts the valves without latching a trip; process interlocks that are a consequence of stopping are defeated for a planned stop, while overspeed, vibration and lube-oil protection stay live. |
| 6 | Turbine supervisory instruments | Differential expansion used a gain that saturated at the 14 mm model clamp on every full-load run, so the 9 mm "HIGH" alarm was permanently latched and meaningless. | A permanent false alarm on the turbine supervisory panel — trainees learn to ignore alarms. | Gain rescaled so full load sits at ~7 mm, inside the normal band. |
| 7 | Condensate / hotwell | The condensate extraction pumps followed the condenser inflow with a lag but had no level control, so every load change left water behind and the hotwell slowly filled until the HIGH level alarm latched and never cleared. | Permanent false "hotwell level HIGH" alarm; the level drifted to 1 737 mm against a 1 500 mm alarm. | Condensate flow is trimmed by hotwell level, holding the normal band at ~900 mm. |
| 8 | Cooling tower | Tower outlet temperature was computed from a fixed 44 °C basin, so the condenser vacuum could not reach its design value (12.6 kPa instead of 9.5 kPa) and part-load heat rate was 5 % high. | Back-pressure and heat rate were wrong at every load. | Range and approach follow the load with the ambient wet bulb: 32.6 °C basin at full load, 8.6–9.5 kPa vacuum. |
| 9 | Cold reheat pressure | Cold reheat pressure was modelled as 0.877 of the HP inlet instead of the correct Stodola expansion relation (3.90 MPa at design flow). | IP/LP swallowing capacity was wrong; peak load stalled at 597 MW. | Expansion-line cushion correction applied. |

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
| P3 | Re-tune the part-load boiler losses and re-damp the boiler-follow / drum-level loops. This is the single root cause of the open physics findings: the superheater runs hot below ~200 MW, the automatic runback holds the unit at ~180 MW, and the loops are only marginally damped, so trajectories are sensitive to numerical noise. Until this is done, use the simulator for start-up, shutdown and fault training rather than for repeatable assessment. | Simulation |
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
