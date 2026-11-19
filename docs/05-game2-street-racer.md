# 05 — Game 2: ApexDrive Street Racer Specification

**Status: Playable beta** alongside Game 1 ([StrikeCore Tactical Shooter](./03-game1-tactical-shooter.md)) via the unified top-bar **Game Hub Switcher** (`StrikeCore FPS` ↔ `ApexDrive Racer`) and direct deep links (`/?game=racer` and `/?race=CODE`).

Use the Race Arena to select a circuit and mode. **Solo Time Trial** gives you one timed lap with no traffic. Your fastest valid recording becomes a translucent ghost for the same circuit on your next run. Your best Time Trial and multiplayer lap times are recorded separately in the browser.

---

## 1. Architecture Overview

ApexDrive Street Racer shares the monorepo structure and authoritative WebSocket architecture with Game 1 without duplicating engine bootstrap or disrupting Shooter endpoints:

| Layer | Package / Path | Responsibilities |
| :--- | :--- | :--- |
| **Shared Registries & Physics** | `packages/shared/src/racing/` | `VehicleRegistry.ts`, `LiveryRegistry.ts`, `CarPartRegistry.ts`, `TrackRegistry.ts`, `VehiclePhysics.ts`, `RacingPacketCodec.ts` |
| **Authoritative Race Server** | `packages/server/src/racing/` | `RaceRoom.ts` (60 Hz wall-clock accumulator), `RaceRoomManager.ts`, `RaceBotAi.ts`, mounted on `/ws/race` and `GET /api/race-rooms` in `GameServer.ts` |
| **Assets & Automotive Audio** | `packages/client/src/games/racer/` | `RaceAssetCache.ts` (garage loads the Apex GT model and studio environment. Race scenes load the selected circuit’s environment and textures as needed) & `EngineAudioSynth.ts` (Web Audio harmonic engine synth, turbo BOV, tunnel convolver reverb, 3D HRTF rivals) |
| **3D Scene, Track & VFX** | `packages/client/src/games/racer/` | `TrackBuilder.ts` (extruded banked spline road, apex kerbs, guardrails, tunnels, themed scenery), `DriftVfxSystem.ts` (ThinInstance skid marks, smoke, nitro flames, sparks), `ChaseCamera.ts`, `RaceNetClient.ts`, `RacerScene.ts`, `GaragePreviewScene.ts` |
| **Garage UI, HUD & Hub** | `packages/client/src/ui/` & `src/main.ts` | `RaceGarageScreen.ts`, `RaceHud.ts`, `LobbyScreen.ts` hub pill, `UserProfileStore.ts` (`profile.racing`), `main.ts` stage lifecycle & deep links |

---

## 2. Arcade-Drift Physics & Driving Loop (`VehiclePhysics.ts`)

Deterministic 60 Hz vehicle simulation shared verbatim between server (`RaceRoom.ts`) and client (`RacerScene.ts`) for input-buffered reconciliation (`lastProcessedSeq` replay + 150 ms residual smoothing):

* **Speed-Sensitive Steering & Suspension:** High cornering authority at low speed, stable micro-corrections at 300+ km/h, plus dynamic chassis pitch, roll, and vertical suspension bounce.
* **Handbrake Drift → Nitro Boost Loop:**
  * Holding `Space` (Handbrake) while turning transitions rear grip into a controllable power-slide angle.
  * Clean slides build live **Drift Score + Combo Multiplier (`1x`–`5x`)** and continuously refill the **Nitrous Boost Bar (`0–100%`)**, unleashed with `Shift`.
* **Green-Zone Skill Launch (`3 - 2 - 1 - GO!`):**
  * Holding throttle inside the green tachometer band (`rpmNorm` in `[0.65, 0.85]`) when `GO!` triggers unleashes a `1.8s` **Perfect Launch Turbo Boost** off the grid.
* **Slipstream Drafting Cone:**
  * Trailing `< 22m` inside a rival's aerodynamic wake grants **+10% top speed** and **1.5× Nitro charge**, surfacing the glowing `SLIPSTREAM DRAFTING (+10%)` HUD pill.
* **Guardrail Spline Containment & Instant Reset:**
  * Lateral spline clamping keeps vehicles on-circuit with speed-scaled wall scrape sparks instead of clipping out of bounds; pressing `R` performs an instant centerline recovery.
* **Automatic & Manual Transmission:**
  * 6-speed gearbox supporting `AUTO` shifting or `MANUAL` paddle shifting (`Q` downshift / `E` upshift), persisted per guest profile.

---

## 3. Controls (Keyboard + HTML5 Gamepad)

| Action | Keyboard | Gamepad (Standard Layout) |
| :--- | :--- | :--- |
| **Throttle / Brake & Reverse** | `W` / `S` or `↑` / `↓` | `RT` / `LT` |
| **Steer Left / Right** | `A` / `D` or `←` / `→` | Left Stick X |
| **Handbrake Drift** | `Space` | `LB` / `L1` or `B` / `Circle` |
| **Nitrous Boost** | `Shift` | `RB` / `R1` |
| **Manual Shift Down / Up** | `Q` / `E` | D-pad Down / Up |
| **Cycle Camera (`Dynamic Chase` / `Far Chase` / `Hood` / `Bumper`)** | `C` | `Y` / `Triangle` |
| **Look Back (Rear View)** | `B` | `L3` / `R3` |
| **Instant Track Reset** | `R` | `Back` / `Share` |
| **Live Standings Overlay** | Hold `Tab` | Hold D-pad Left |
| **Race Control Menu (Pause / Track Switch / Settings)** | `M` or `Esc` | `Start` / `Options` |

Touch devices get on-screen steering, throttle, brake, drift, nitro, camera, reset, and manual gear buttons. The system reduced-motion preference disables camera shake, horizon tilt, and speed-based field-of-view changes.

---

## 4. Modular Registries (Data-Driven Customization)

Adding new cars, liveries, performance tunes, aero parts, or tracks requires only a single registry entry in `packages/shared/src/racing/`.

### 4.1 Vehicles (`VehicleRegistry.ts`)
| ID | Name | Class | Drivetrain | Engine Profile | Base Stats (SPD / ACC / DRF) | Top Speed |
| :--- | :--- | :--- | :---: | :--- | :---: | :---: |
| `apex_gt` | **Apex GT458** | GT Supercar | RWD | `V10_SUPER` (`ferrari.glb`) | `96 / 91 / 86` | 318 km/h |
| `skyline_r34` | **Skyline R34 Spec-Z** | JDM Turbo | AWD | `I6_TURBO` | `88 / 89 / 95` | 300 km/h |
| `viper_v8` | **Viper V8 Dominator** | Muscle V8 | RWD | `V8_MUSCLE` | `93 / 94 / 79` | 312 km/h |
| `rally_rs` | **Rally RS Evo-X** | AWD Rally | AWD | `BOXER_RALLY` | `84 / 96 / 93` | 290 km/h |

### 4.2 Clearcoat PBR Liveries (`LiveryRegistry.ts`)
Universal paint finishes applied across every vehicle's standardized body, accent, caliper, and rim material slots (`clearCoat.isEnabled = true`):
* `rosso_corsa` (**Rosso Corsa**)
* `midnight_purple` (**Midnight Purple**)
* `pearl_white_stripe` (**Pearl White GT**)
* `matte_carbon_gold` (**Matte Carbon Gold**)
* `tokyo_cyber_cyan` (**Tokyo Cyber Cyan**)
* `sunset_orange_metallic` (**Sunset Metallic**)

### 4.3 Tuning, Aero, Rims & Underglow (`CarPartRegistry.ts`)
* **Performance Tunes (`computeEffectiveVehicleStats`):** `tune_street` (*Street Balanced*), `tune_track` (*Track Grip* — +5% top speed, sharper apex grip), `tune_drift` (*Drift Spec* — wider lock, looser rear slip, +28% Nitro charge).
* **Rear Spoilers:** `spoiler_none` (*Clean Deck*), `spoiler_gt_wing` (*Carbon GT Wing*), `spoiler_ducktail` (*Street Ducktail*).
* **Forged Rims:** `rim_sport` (*Forged 5-Spoke*), `rim_mesh_gold` (*Motorsport Gold Mesh*), `rim_aero_carbon` (*Aero Carbon Disc*).
* **Neon Underglow:** `underglow_none` (*Off*), `underglow_cyan` (*Cyber Cyan*), `underglow_magenta` (*Tokyo Magenta*), `underglow_amber` (*Solar Amber*), `underglow_emerald` (*Neon Emerald*).

---

## 5. Tracks & Racing Modes (`TrackRegistry.ts` & `RacingPacketCodec.ts`)

All circuits are closed centripetal Catmull-Rom 3D splines (`sampleTrackFrames`, `projectPointToTrack`, `getTrackStartGrid`) with smooth banking, 17–20 m paved widths, 2-wide staggered start grids, and 16 sector checkpoints:

1. **`tokyo_midnight` — Tokyo Midnight Expressway (2 Laps, Night):** Wet reflective neon highway loops, skyscraper skyline, streetlamp poles, and an echoing roofed concrete tunnel (`isTunnel: true`) triggering live Web Audio convolver acoustics.
2. **`coastal_sunset` — Coastal Sunset Canyon (2 Laps, Golden Hour):** Mountain pass with elevation crests, banked cliff hairpins, gravel outer shoulders (`hasGravelShoulder: true`), directional sunset shadows, and coastal overlooks.
3. **`harbor_gp` — Harbor Grand Prix Circuit (3 Laps, Daylight):** Wide 20 m technical circuit with fast chicanes, alternating red/white apex kerbs, sunlit grandstands, pit garages, and a long slipstream main straight.

### Race Modes
* **`GRAND_PRIX` (Grand Prix 8P):** Full 8-car grid with optional AI rival grid fill (`EASY` / `NORMAL` / `PRO`), live split deltas, and post-race results with track voting and a ready check for the next grid.
* **`DUEL_1V1` (1v1 Touge Duel):** Focused 2-car head-to-head sprint with zero traffic clutter.
* **`DRIFT_ATTACK` (Drift Attack):** Up to 8 cars chaining high-angle slides up to a `5x` combo multiplier; ranked by total drift score. Each driver can complete up to two laps within a two-minute session.
* **`TIME_TRIAL` (Solo Time Trial):** One timed lap from a standing start in a private room. Use **Restart Time Trial** in the race menu to retry. The ghost is recorded from server positions and stays local to the browser.

### Grid and results

* Quick Race matches open lobbies. A locked grid accepts returning drivers with a reserved seat. The host can change the circuit while the lobby is open, and drivers can vote on the next circuit from results.
* The countdown starts after all human drivers finish preparing the current grid. If preparation exceeds 25 seconds, the host can start again once drivers are ready. A reconnect restores the car and starts a fresh input sequence.
* Circuit races have a six-minute limit and a 45-second finish window after the first driver finishes, whichever ends sooner. Time Trial ends at the line or the six-minute limit. Drift Attack classifies drivers who finish or earn drift points by its deadline.
* Final standings determine results and career updates. The host can start the next grid from results. The room also prepares the next grid after an 18-second results window.


---

## 6. 3D Showroom Garage, HUD & Persistence

* **3D Automotive Showroom (`GaragePreviewScene.ts` + `RaceGarageScreen.ts`):** Floating glass panels (`pointer-events: none` shell) leave the center viewport open for smooth drag-to-orbit & scroll-zoom around the live clearcoat car on a reflective studio turntable, complete with an interactive **REV ENGINE** button that triggers exhaust flames and a live synth rev burst.
* **Motorsport Telemetry HUD (`RaceHud.ts`):**
  * Top-left live `164×164` **Track Spline Minimap** (circuit outline, tunnel highlight, start/finish line, rival dots, cyan directional player chevron) + Room Code / Invite (`/?race=CODE`) / Menu / Host Start bar.
  * Top-center **Position (`1st / 8`)**, **Lap Counter**, live **Lap Timer**, **Best Lap**, and **Split Delta (`-0.38s`)**.
  * Center **3-2-1-GO!** starting lights, **PERFECT LAUNCH!**, and **WRONG WAY!** animated alerts; center-right **Drift Combo Banner**.
  * Bottom-right **SVG Circular Tachometer** with redline pulse, **Gear Badge**, **Digital KM/H**, countdown **Green Launch Zone** bar, **Nitrous Boost Bar**, and **SLIPSTREAM DRAFTING (+10%)** badge.
  * Hold-`Tab` live Standings table, `[M]` Race Control Pause Menu, and **Post-Race 3D Podium Overlay** with Top-3 breakdown, personal best summary, track voting, and **Start Next Grid**.
* **Guest profile (`UserProfileStore.ts`)** stores vehicle setup, races, wins, best drift score, and separate personal bests for multiplayer and Time Trial alongside the existing shooter profile.
