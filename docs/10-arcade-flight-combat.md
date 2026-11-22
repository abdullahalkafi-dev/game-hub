# Arcade flight combat game design

**Flight game design baseline.** **Arcade Flight Combat** is the working title. This document is the source of truth for the flight release scope, implementation choices, and release checks. Starting values are defined here so implementation and benchmarking can begin. Playtests and measurements determine final tuning and capacity.

| Status | Decisions |
| --- | --- |
| Agreed scope | Four playable jets, four launch modes including public 1v1, two regions, six authored Operations, six dynamic Frontier objectives, aircraft publishing, and custom sorties. Prioritize in-flight frame pacing with up to 60 seconds of initial preparation under the reference conditions. |
| Implementation baseline | Babylon.js on the shared hub, WebGL2, fixed-step arcade flight, server-authoritative hitscan cannon and simulated missiles, solo Frontier checkpoints, and aircraft processing in a dedicated child process. Air Duel is the first complete internal online milestone. |
| Confirm during development | Aircraft and encounter balance, final depth configuration, rendering and content budgets, load-time targets, maximum simultaneous rooms, and whether Duel needs a late-round boundary change. |

## Contents

- [Launch scope](#1-launch-scope)
- [Player experience](#2-player-experience)
- [Aircraft and combat](#3-aircraft-and-combat)
- [Game modes](#4-game-modes)
- [Regions, airfields, and AI](#5-regions-airfields-and-ai)
- [Aircraft asset production](#6-aircraft-asset-production)
- [Aircraft uploads and custom sorties](#7-aircraft-uploads-and-custom-sorties)
- [Integration and multiplayer](#8-integration-and-multiplayer)
- [Loading and performance](#9-loading-and-performance)
- [Build milestones and release criteria](#10-build-milestones-and-release-criteria)

## 1. Launch scope

The game is a third-person, 3D browser flight game. A new player should be able to take off, follow a target marker, and make a first pass within one guided sortie. An experienced player should still have meaningful decisions about speed, turning, target selection, limited ordnance, and when to land. The signature loop is capturing an enemy airfield and using it as the next repair and launch point as the fight moves deeper into the region.

| Area | First release |
| --- | --- |
| Playable aircraft | Four visually distinct jets with different handling, armament options, sounds, and roles. All four stock airframes are available from the start. |
| AI aircraft | Hostile and friendly variants of the four jets, plus a transport and a helicopter with dedicated models and behaviors. |
| Public competition | One 1v1 Air Duel queue. Two humans per match, with best-of-three rounds and a mutual rematch. |
| Team play | Private 4v4 Air Domination with bot fill, and authored Co-op Operations for one to four players. |
| Open-ended play | Frontier, a solo or private co-op run for up to four players with escalating threats and capturable airfields. |
| Content | Two regions, two competitive layouts per region across the two PvP modes, six authored Operations, and six reusable dynamic objective types. Training is a separate guided activity. |
| Custom content | Admin aircraft importing and publishing, editable flight profiles, and a player-facing custom sortie editor for solo and private play. |
| Presentation | A 3D hangar, preflight briefing, readable flight HUD, positional audio, distinct terrain and weather, and a debrief with score breakdown. |
| Platform | Desktop browser with mouse and keyboard or a standard gamepad. Low, Balanced, and High graphics presets. WebGL2 is the initial release baseline. |

## 2. Player experience

### 2.1 Hub, hangar, and first flight

1. Enter the flight game through the hub switcher. The hangar presents the four jets, what each does well, and the available modes. The first-time entry highlights **Training**. **Find Duel** is always accessible for players ready to compete.
2. Inspect a jet in the hangar, choose a livery and compatible loadout, and see handling strengths in language such as *turns tightly at medium speed*. Preview the aircraft and hear its engine at idle and thrust. The hangar saves selection, input preferences, and audio settings to the guest profile.
3. Read a short briefing with objective, theater and weather, available wingmen, and the expected sortie length where applicable. The loading panel shows the current preparation stage and a cancel action. The hangar preview yields its rendering resources when the match scene needs them.
4. Fly the mission. The HUD highlights the current objective and briefly explains unfamiliar actions as they become relevant. Objective and damage feedback remain readable through explosions and bright skies.
5. Review completion, team or round score, objectives, capture history, and personal bests where relevant. Offer a context-appropriate action such as rematch, retry, next Operation, or hangar.

**Training sortie.** A five-to-eight-minute target length across four short lessons. Taxi guidance and a straight takeoff teach throttle and pitch. A gate course teaches steering, braking, and boost. A practice drone teaches target selection, firing, and threat cues. A marked runway teaches assisted landing and servicing. Players can repeat individual lessons and resume at the last training checkpoint after a crash.

### 2.2 Handling and camera

Use arcade flight with throttle, pitch, yaw, and roll. Input controls desired turn and bank rates, and the plane's current speed and profile determine its response. At mid-throttle a jet can turn more tightly. Boost helps it gain separation and cover distance, with wider turns. Very low speed reduces responsiveness and produces a recoverable warning and nose drop. Assisted auto-leveling gently restores bank after release and yields immediately to sustained roll input. A fixed-step simulation updates position, orientation, speed, boost, and contact state. Use an interpolated chase camera, with smoothing tuned separately from aircraft steering so the response feels immediate.

The primary camera follows behind and above the jet with a readable horizon. The player can switch between near and far chase views and briefly look behind. Camera collision or clearance correction keeps nearby slopes from hiding the aircraft. Reduced motion disables shake, eliminates boost-driven field-of-view changes, and reduces camera roll and flashes. Keep the aiming reticle stable under those settings.

### 2.3 Controls and assistance

| Action | Mouse and keyboard default | Standard gamepad default |
| --- | --- | --- |
| Steer pitch and yaw | Mouse-guided reticle, with arrow keys as a keyboard-only alternative | Left stick |
| Roll | `A` / `D` | Right stick horizontal |
| Increase or decrease throttle | `W` / `S` | Right / left trigger |
| Airbrake | Hold `X` | Hold left trigger at full travel |
| Boost | `Shift` | `X` / Square |
| Cannon | Left mouse / `Space` | Right bumper |
| Selected secondary | Right mouse / `E` | Left bumper |
| Cycle target | `T` | `Y` / Triangle |
| Cycle secondary | `Q` | D-pad right |
| Flares | `F` | `B` |
| Request landing / interact | `R` | `A` |
| Rear view / chase distance | `V` / `C` | Right stick click / D-pad down |
| Pause or open match menu | `Esc` | Menu button |

Expose sensitivity, dead zone, vertical inversion, remapping, and camera settings, including optional horizon lock. Display current bindings in each prompt. Use a mouse reticle bounded by the flight canvas, with a keyboard-only fallback. Capture right-click only while flight controls are active. Keep `Tab` available for keyboard navigation and leave browser shortcuts accessible. If a pointer-lock option is added, treat Escape or loss of lock as an input interruption and request lock again from a player gesture. Offline sessions pause locally. Online pause opens the menu while the match clock continues. Clear held input on focus loss or controller disconnect, prompt the player, and allow keyboard control. Public Duel applies the same aim and lock rules to both input methods. [Pointer Lock specification](https://w3c.github.io/pointerlock/)

### 2.4 HUD and sound

Use a DOM HUD and a Canvas 2D radar, following the existing shooter overlay. Color-independent ally and hostile symbols, a sky-readable hit marker, and synchronized visual and audio threat warnings take priority over decorative effects. Test a projected ground cue near runways and low terrain. Use horizon lock and reduced motion to keep visual feedback comfortable. [Shooter HUD](../packages/client/src/ui/ShooterHud.ts)

- **In the flight path** show the aim point, selected target, lock state, and off-screen target arrow. A compact flight ladder shows pitch and horizon, with speed and relative altitude at the edges of the aiming area. Keep center text clear of the reticle.
- **At a glance** show hull, boost, cannon heat, secondary ammunition, flares, and a radar with heading, threats, and friendly airfields. Use distinct icons, text, and shapes alongside color. Make the radar and HUD scale adjustable.
- **At the right moment** show capture progress, range and bearing to the next objective, approach cues, low altitude, incoming threats, and the current mode's score, round, or timer. Prioritize immediate hazards and suppress duplicate warnings.
- **In sound** layer throttle and boost, wind, distant flybys, cannon and secondary cues, warning tones, and short mission callouts. Keep launch and threat cues audible over explosions. Caption priority callouts and expose separate master, effects, music, and voice levels. Use distinct engine profiles for the four jets, adapt the racer's Doppler approach for flybys, and cap simultaneous positional voices in large fights. [Racer positional audio](../packages/client/src/games/racer/EngineAudioSynth.ts)

## 3. Aircraft and combat

### 3.1 Stock fleet and roles

The launch aircraft are fictional designs. Model silhouettes and relative stats below are illustrative. Balance the four as sidegrades so the public queue gives every player a competitive starting selection.

| Aircraft | Visual direction | Flight characteristics | Best use and tradeoff |
| --- | --- | --- | --- |
| **Kestrel** | Small, single-engine jet with a sharply swept wing | Fast throttle response, high sustained turn rate, light hull | Interception and close dogfights. Carries fewer secondary rounds. |
| **Meridian** | Mid-size twin-tail multirole fighter | Predictable roll and pitch, medium boost and hull | Starter and flexible wingman. Supports a broad choice of loadouts. |
| **Vanguard** | Broad twin-engine air-superiority fighter | Strong boost, higher hull, slower roll response | Airspace control and high-speed passes. Needs room to reverse direction. |
| **Bastion** | Wide-wing attack jet with a high tail | Stable slow flight, resilient hull, modest top speed | Base assaults and escort support. Gives up the initiative in sustained dogfights. |

Each flight profile defines cruise and maximum speed, acceleration and braking, boost capacity and recovery, turn rates across the speed range, roll response, low-speed recovery, durability, and an approach envelope. Keep the model, the flight profile, and the equipment rules independently versioned. Symmetric spawn options and a common gear tier apply in public Duel. Public competitive variants use vetted stock profiles. Private games can allow published custom aircraft at the host's option.

### 3.2 Loadouts and feedback

| System | Player decision and game behavior |
| --- | --- |
| Primary cannon | Server-authoritative hitscan online, using the shared ray query offline. Fire in short bursts to manage heat. A momentary overheat cooldown is visible beside the reticle. Use tracers for visual feedback and server-confirmed hit markers in online play. |
| Air-to-air secondary | Limited missile stock. The player holds a target inside the acquisition area to establish lock. The HUD distinguishes acquiring, ready, lost, and missile warning. Targets can evade or spend a flare. |
| Air-to-ground secondary | Choose a bomb or guided ground-attack option in objective modes. Target and range cues communicate when the selected weapon can be used. The ground slot is disabled for stock public Duel. |
| Countermeasure | Flares are limited and have a cooldown. Availability is visible on the HUD and resets between Duel rounds or at a successful service stop in modes with airfields. |
| Boost and airbrake | Boost spends a regenerating meter. Ordinary throttle reduction moves the cruise setpoint down. Holding the airbrake temporarily increases deceleration and suppresses boost, then restores the throttle setpoint on release. |

Use clear shield-free hull feedback with smoke and audio at low health. Keep the effect intensity adjustable. Distinguish confirmed hits, assists, environmental crashes, and aircraft losses in the debrief. Use simple collision shapes and swept movement checks for fast-moving entities against aircraft and terrain. Shared rules determine damage, friendly-fire policy, and cooldowns. Competitive player hits and results come from the server. Default team and co-op rules let friendly aircraft pass one another and disable allied damage, which reduces spawn collisions and accidental teammate losses.

### 3.3 Flight model and first tuning profile

Use meters, seconds, meters per second, hit points, and a fixed 60 Hz step. The flight space is right along `+X`, up along `+Y`, and forward at neutral orientation along `+Z`, matching the left-handed Babylon scene convention. Store aircraft orientation as a normalized quaternion. Author rates and angles in degrees and convert to radians in the simulation. World altitude uses sea level as zero. The radar, landing guide, and low-altitude warning use height above local terrain or runway as appropriate. Normalize imported aircraft axes and scale before applying any flight profile.

At each step, read the normalized input and control state, advance throttle and boost, compute turn and roll authority from speed, and advance the airframe along its new forward vector. Sweep the movement against the shared terrain and colliders before committing the step. Apply low-speed nose recovery and neutral-bank leveling through the same orientation controller. The camera reads the interpolated result. These values are the first playable baseline for the stock **Meridian**.

| Parameter | Meridian starting value |
| --- | --- |
| Speed bands | Low-speed recovery below **65 m/s**, takeoff rotation available at **75 m/s**, cruise **190 m/s**, best turn near **170 m/s**, dry maximum **275 m/s**, boost maximum **330 m/s**. Plan streaming and match manifests around a **360 m/s** maximum for every eligible flight profile. |
| Speed response | **24 m/s²** powered acceleration, **18 m/s²** ordinary deceleration, up to **32 m/s²** with held airbrake, and **36 m/s²** powered acceleration with boost. Clamp toward the active speed band; bleed speed toward dry maximum after boost ends. |
| Turn curve | Fraction of peak turn authority at **65 / 110 / 170 / 275 / 330 m/s** is **0.35 / 0.75 / 1.00 / 0.70 / 0.55**, with linear interpolation. Below 65 m/s, ease to reduced authority and pitch the nose toward recovery at up to **12°/s**. |
| Orientation | Peak pitch **55°/s**, yaw **40°/s**, and roll **110°/s**. Auto-bank up to **55°** in mouse-guided turns. On neutral steering, level the bank toward the horizon at up to **40°/s**. Explicit roll input takes priority. |
| Boost and hull | **4 seconds** of full-meter boost. Begin recovery after **1 second** off boost, then refill an empty meter over **8 seconds**. Meridian has **100 HP**. |
| Ground and approach | Taxi up to **20 m/s**. The assisted approach gate sits **350–900 m** before the runway threshold, **20–120 m** above runway elevation, with **75–105 m/s** airspeed, heading within **12°**, bank within **15°**, and lateral offset within **45 m**. Provide at least **1,000 m** of clear runway. |

| Loadout parameter | First balance pass |
| --- | --- |
| Cannon | **900 m** maximum ray range, **12 shots/s**, **4 HP** per valid hit, a **2-second** sustained-fire heat budget from cold, and a **1.2-second** forced cooldown on overheat. |
| Air-to-air missile | **4** carried, **3.2 km** maximum lock range, **18°** lock half-angle, **0.85 seconds** continuous acquisition, **2.5-second** launch cooldown, **45 HP** hit. Flight lifetime and world-space travel are capped, starting with **5 seconds** and **4.5 km** respectively. |
| Air-to-ground options | **4** bombs or **4** guided rounds. Bomb release cue within **1.6 km** ground range, guided lock within **2.4 km**. Start with **60 HP** direct objective damage and tune area effects with the authored missions. |
| Flares | **3** carried, with a **3-second** cooldown. Use a shared and testable countermeasure rule in competitive modes. |

Treat weapon ranges as inputs to encounter placement and target-interest rules. Verify the selected target and its route are available before the player can engage. Check the outer estimates with a maximum-speed approach, a head-on engagement, and ground clearance at a mountain airfield before setting the rest of the fleet's balance.

## 4. Game modes

### 4.1 1v1 Air Duel

Two real players enter a public queue. The first waits and can cancel at any time before accepting a pairing. The next eligible player creates a two-seat match. There is one unranked queue per deployment at launch. Match compatible game and content versions, give the older queued player priority among available matches, and allow one queue ticket per guest session. Players can look through stock loadouts while waiting. Opening another game mode or leaving the hub cancels the ticket. Show explicit **Searching**, **Opponent found**, **Preparing match**, and **Waiting for opponent** states.

1. **Pair.** Reserve each seat, present the match offer, and give both pilots a proposed 15-second acceptance window. If the offer expires, release both seats and return the responding player to the queue with their original priority.
2. **Brief and load.** Pick one of the two compact airspace layouts. Each player has an initial **20-second** selection window with their current valid stock loadout as the default. Lock selections as soon as both confirm or the window expires, and reveal both aircraft during countdown. Start the **75-second** room preparation clock at that lock, giving clients 60 seconds for local preparation plus 15 seconds of room coordination margin. On expiry, return a ready pilot to the queue and show the other a retryable load error. If both are still loading, release both seats and show each pilot the failure state. Use a match-scoped readiness token so stale events from a prior room cannot start the match.
3. **Fight.** Start a synchronized three-second countdown once both are ready. Spawn airborne in mirrored positions, initially **4.4 km** apart at **190 m/s**, with matching altitude and access to cover. Each round restores hull, ammunition, boost, and cooldowns. Swap sides after the first round. A round ends when a plane is destroyed or crashes. On the three-minute baseline timeout, the higher remaining hull percentage wins. Equal hull or same-tick elimination draws the round. Keep the perimeter visible, with a grace interval to turn back before leaving the airspace counts as a round loss. During playtests, record extended disengagement by a leading pilot and evaluate a clearly signaled late-round boundary change on both maps if it becomes a common winning tactic.
4. **Settle the match.** First to two round wins takes the match. After three rounds the higher win total takes it, and equal totals record a draw. Show round-by-round results and the deciding event. If both players request a rematch, prepare a fresh best-of-three in the same room with a new match ID and an option to reselect stock jets.
5. **Handle exits.** Once live, reserve a disconnected seat for 30 seconds and show the opponent a reconnect timer. Set a short authoritative rules pause while the seat is reserved. Restore the current match state on reconnect, then resume with a short countdown. A second interruption or an expired grace period is a forfeit if one pilot remains. Record an abandoned match if both leave. A deliberate quit during live play forfeits immediately. Pre-countdown exits return the other pilot to the public queue without recording a defeat.

### 4.2 4v4 Air Domination

Create a private room and share its code or invite link. Up to eight humans can choose sides in the lobby. The host selects one of two arena layouts, bot-fill settings, and bot difficulty. Bots fill vacant starting slots to make four per side when enabled. The room locks teams and the region before preparation. Returning players can reclaim reserved seats. After the reservation expires, enabled bot fill takes over at the next safe respawn. The host can start only when both sides have at least one pilot, counting bots, and all participating humans are ready for the current layout revision.

Three control zones make up each arena. An uncontested friendly aircraft in a zone advances capture, and opponents in the same zone freeze its progress. Sides earn one point per second for each uncontested controlled zone. Holding one with a wingman should matter as much as chasing a defeat on the far side of the map. A downed aircraft returns after a proposed eight-second respawn with short protection that ends when it fires or enters a scoring zone. Spawn zones sit outside capture volumes.

The proposed limit is **600 points or eight minutes**, whichever comes first. The greater score at the time limit wins. On a tie, play up to 60 seconds of overtime and award the game on the first scoring tick that separates the teams. Equal scores at the overtime cap are a draw. The scoreboard shows objective time, captures, eliminations, assists, and losses. Results allow the party to switch layout, rebalance teams, or start another round.

### 4.3 Co-op Operations

Six authored sorties, three in each region, for solo flight or a private party of up to four. Each mission has a briefing, authored start, primary objective sequence, optional objective, and an ending with success, partial completion when appropriate, or failure. Players can pick any starter Operation. Enemy group size and reinforcements scale to the human party size at launch, with a cap tested on the minimum graphics tier. Use role cues such as *cover the transport* and *open the airfield approach*, so cooperation emerges naturally. A human who loses a jet can follow a teammate and redeploy from a designated checkpoint or an eligible serviced airfield, according to the mission's rules. An exhausted team or a failed required objective ends the sortie.

| Region | Operation | Briefing and objective arc |
| --- | --- | --- |
| Breakwater Isles | **Outer Beacon** | Intercept a patrol beyond the lighthouse islands, then escort a supply transport across the channel. Optional goal to keep the transport above a hull threshold. |
| Breakwater Isles | **Harbor Line** | Defend a friendly runway through two distinct attack waves, then protect the helicopter as ground crews finish evacuating. |
| Breakwater Isles | **Second Runway** | Clear a hostile island airfield, hold the area through its response wave, then land at the newly friendly runway. |
| Slate Divide | **Ridgewatch** | Intercept an approaching flight before it crosses the pass, then escort an allied survey plane through a lower valley. |
| Slate Divide | **Pass Control** | Disable marked installations at two connected sites, then defend the allied base against the response. |
| Slate Divide | **Last Light** | Escort an evacuation helicopter, open the marked escape route, and regroup at the safe airfield before time expires. |

### 4.4 Frontier

Start at a friendly airfield in an authored opening sector. Players pick an aircraft and loadout, head toward the marked frontier, and choose whether to push into the next objective or return to friendly territory. Open-ended terrain and threat progression let the run continue for as long as the pilot or party sustains it. The objective director reads sector seed, available bases and routes, recent objective history, current threat, and party capability. It offers encounters that can actually be completed with the available target types and aircraft equipment.

| Dynamic objective | Completion and failure | Director placement rule |
| --- | --- | --- |
| **Interception** | Stop the marked aircraft before it crosses a visible exit line. Its escape fails the objective. | Spawn the group with time to reach the interception area and a readable route. |
| **Escort** | Guide a friendly transport or helicopter to its destination. Loss of that aircraft fails the objective. | Use a continuous, clear path through active sectors, with visible points where threats can enter. |
| **Base defense** | Keep a friendly airfield operational until the wave ends. Excess damage disables servicing there until it is recovered. | Choose a friendly field and introduce the threat far enough away to respond. Keep an alternate return route to a functioning field. |
| **Ground strike** | Destroy designated arcade ground targets within the sortie window. A missed deadline closes the encounter and yields partial credit for completed steps. | Match required equipment to the party's available loadout or place a reachable service point before activation. |
| **Airfield capture** | Clear the marked defenders and hold the airfield until ownership changes. A contest pauses progress. A party retreat leaves the field neutral or hostile according to its current state. | Choose a validated runway near the frontier, with landing clearance and access once secured. |
| **Extraction** | Cover a departing helicopter or transport until it reaches the exit, then let the party return to a safe field to bank the run or continue. | Have a reachable safe airfield and a departure route clear of terrain. Keep the extraction window visible. |

An objective moves through offered, active, success or failure, and resolved states. Keep one primary objective active for the party. Offer an approach or response window before starting a timer. Failure can increase pressure or remove a bonus while leaving the run playable when the party still has an aircraft and a way forward. Avoid back-to-back objective types when an eligible alternative exists. Maintain deterministic tie-breaking from the run seed and record which objectives were accepted, so reported encounters can be reproduced.

Threat rises on captures, primary objective clears, and first arrival at outward distance bands. Returning through visited sectors preserves score and frontier position. The first bands introduce patrols and light defenses, then mixed squadrons, denser airfield defense, and ace encounters. Later bands rotate combinations within active-entity and AI budgets. Award points for objectives, assists, captures, and meaningful distance milestones. Credit one-time ownership events and only the farthest outward band reached. A successful return after an Extraction banks a completion bonus and opens debrief or continued flight. Party debrief records furthest sector, captures, threat, completed objectives, result, and individual contributions.

In co-op, a downed pilot may redeploy once an ally lands and services at a functioning friendly airfield, with a per-objective redeploy allowance. A full party loss ends the run. In solo, the loss of the aircraft ends the run at debrief. Store one versioned solo checkpoint in IndexedDB after initial deployment setup and each completed service stop. Write a coherent snapshot of the run seed and rules revision, aircraft and equipment, parked airfield, persistent ownership, resolved encounters, objective director state, and score. Resume at the saved field after rebuilding its starting area. On confirmed defeat or bank-and-end, finalize the result and retire the checkpoint in one transaction. Preserve the previous completed checkpoint if saving fails and show when the latest checkpoint was written. Online run state lives in its room and supports a reconnect grace period. Captured airfields and resolved encounters persist within the run even when their terrain meshes leave memory. Personal bests and completed Operation results persist locally. Public Duel results and current rematch state are server-owned for the match session.

## 5. Regions, airfields, and AI

### 5.1 World design

| Region | Landmarks and flying character | Launch layouts and authored anchor |
| --- | --- | --- |
| **Breakwater Isles** | Coastal island chain with dark rock, low ridges, open water, harbor lights, and a clear horizon. Prioritize readable silhouettes against sea and sky. | Air Duel over a paired headland layout. Domination links a beacon, harbor, and outer runway. Frontier begins at a sheltered airfield with two visible routes toward the outer islands. |
| **Slate Divide** | Layered mountain ridge and valley terrain, high plateaus, pine slopes, and a hazy skyline. Provide both elevated approaches and lower visual corridors. | Air Duel uses a broad saddle with mirrored ridge cover. Domination spreads checkpoints across a pass, a shelf, and a valley crossing. Frontier starts on a plateau airfield with clear valley and ridge exits. |

Competitive layouts use baked terrain and a visible flight boundary. Authored Operations use bounded corridors sized for their scripted encounters. Frontier extends each handcrafted opening using versioned procedural terrain, region materials, landmark families, and rules for placing bases and approach routes. The server and offline simulation use a shared height and object query. Client mesh detail can change with distance while collision height and persistent landmarks stay consistent. Start testing with fair daylight in PvP and use clear, overcast, or low-haze presets for Operations, Frontier, and custom sorties. Ensure that weather keeps warnings, radar, and the horizon readable.

| Spatial parameter | First implementation baseline |
| --- | --- |
| Sector and heightfield | **2,048 × 2,048 m** with a **129 × 129** shared height sample grid at **16 m** spacing. Adjacent sectors share border samples. Apply authored terrain overrides consistently in the client and simulation. Runways and collidable structures use explicit geometry or simple shapes. |
| Air Duel playable area | **8.192 × 8.192 km** or a 4 × 4 sector footprint. Start with a **3,500 m** sea-level ceiling and choose mirrored spawn routes with equivalent terrain clearance. |
| Air Domination playable area | **12.288 × 12.288 km** or a 6 × 6 sector footprint. Recheck control zone spacing, travel time, and spawn safety at the first flight profile's cruise and boost speeds. |
| Frontier opening and base placement | Handcraft a **5 × 5** sector opening, **10.24 km** across. Target **5–8 km** between neighboring usable airfields on future seeded routes. Validate runways, surrounding terrain, and approaches before advertising a field. |
| Render-origin shift | Rebase at sector boundaries using the active camera sector as the render origin. Update view objects, static chunk transforms, and visual effects before drawing the next frame. Preserve canonical sector and local coordinates on the server and in saves. |

Use indexed heightfield samples for ordinary terrain queries. Sweep fast movement across the traversed cells and authored colliders for collision. Set the initial chase camera depth range to **1.5 m near** and **16 km far**, with an independent sky treatment for the horizon and a separate close hangar camera. Profile dense mountain ridges, runway markings, airborne overlaps, particles, and transparent water on WebGL2 with conventional depth first. Compare tighter clipping, reverse depth, and logarithmic depth if precision artifacts remain. Test StrikeCore and ApexDrive if the chosen setting affects the shared Babylon engine. Capture the selected depth configuration and the scenes used to verify it. [Babylon.js WebGL2 support](https://doc.babylonjs.com/setup/support/webGL2/)

### 5.2 Capture, landing, and turnaround

**Ownership.** A hostile airfield has clearly marked defense and control targets. Once the required targets are cleared, it becomes neutral and a visible capture volume becomes available. A friendly pilot holds it through a proposed 15-second uncontested capture interval. Check ownership, the active defense wave, and contested status on the authoritative simulation before publishing the capture event. Captured fields retain a persistent ID for their runway, service state, allied spawn, and score event.

**Ground roll and departure.** Use a simplified kinematic runway state with steering, acceleration, braking, and runway contact clearance. Taxi at the profile limit, then transition to takeoff roll once aligned and released by runway occupancy. The pilot controls acceleration and rotation. At the profile's rotation speed and a positive pitch request, transition to airborne flight and enable normal steering as clearance increases. A low-speed runway overrun can be stopped or reset during training. Live collision and mission rules apply during a sortie.

**Approach.** Friendly operational fields advertise runway heading, distance, and preferred direction. When the pilot requests landing, show approach gates and speed guidance. Assisted landing becomes available only within that aircraft's approach envelope. Confirmation reserves the runway and assigns the aircraft to an authored approach and touchdown controller. Speed controls or a go-around request can return control before touchdown. If the field loses service availability first, cancel the approach and show an alternate field marker. After contact, use the ground-roll controller to brake and taxi to the service point. Release the runway reservation when it is clear.

**Service.** Once parked, offer repair, refill, compatible loadout change, or a swap to a published airframe permitted by the room. Report service duration and lock the revised loadout when departing. Validate runway availability before takeoff. A damaged home or captured field surfaces its status on radar and in the team feed. Public Air Duel begins airborne and resets equipment between rounds. Domination uses airborne team respawns for a predictable match rhythm.

### 5.3 AI behavior and encounter pacing

- **Fighter pilots** patrol, pursue, evade, disengage, or return to an objective. Wingmen can defend a teammate or contest a zone. Difficulty changes decision delay, aim error, aggression, and coordination while keeping the airframe inside its published flight envelope.
- **Helicopters** hold or follow an authored corridor, and transports take readable routes with a clear approach and exit marker. Escort targets react visibly to damage and report their status at mission thresholds.
- **Ground defenses** signal engagement by readable tracers, markers, and warning cues. Assign threats by zone and cap simultaneous lock warnings so the player can react. A threat already engaged with a pilot retains state as visibility detail shifts.
- **Encounters** alternate pressure and recovery. Place reinforcements outside the immediate view and awareness bubble where geometry and mission rules allow, then announce their arrival. Start distant decision updates at **5–10 Hz** while integration and nearby engagements use the normal simulation step. Test bots in all map layouts, especially when a team is mostly AI, an escort gets stalled, or a player camps near the boundary.

## 6. Aircraft asset production

### 6.1 Art direction and sourcing

Use detailed aircraft and terrain with restrained effects and high-contrast silhouettes. Spend the most detail on the parts visible from the chase camera and in the hangar, especially the canopy, intakes, tails, exhausts, and landing gear. Establish a common scale, panel density, material response, and livery palette with the Meridian, then use those references to review the other aircraft. Use original shapes and marking sets. An existing model is a candidate if its rights cover game use, modification, and redistribution in the shipped format. Record creator, license, source, and modifications beside every shipped asset or pack, including audio.

1. **Block out the fleet.** Establish silhouettes for the four playable jets and both AI airframes. Check each at near chase, far chase, radar-icon, and hangar viewing distances. Judge the readability of friendly and hostile liveries at combat distances with each region's lighting.
2. **Model and texture.** Use Blender for clean game meshes, UVs, bake maps, and rigging. Use a shared physically based material setup with base color, normals, packed roughness/metallic data where appropriate, emissive exhaust, and canopy glass. Keep faction and livery changes in tintable slots or decal layers where possible. Use opaque materials for distant canopy and other cosmetic transparency where practical.
3. **Rig interaction points.** Place or map engine exhaust, effect and equipment sockets, camera reference, landing gear and wheel contact, and animation nodes for control surfaces. Keep gameplay collision as a separately authored simple shape. Animate gear and control surfaces where the model supports them. A mesh with a static gear configuration receives a clear preview warning and may be approved with an appropriate visual fallback.
4. **Bake and package.** Export a self-contained glTF 2.0 `.glb` in meter units, generate two lighter distance levels, cap texture dimensions, remove unused data, and deduplicate materials. Start with **1K** KTX2/Basis textures and test **2K** maps where close-flight detail warrants them. Profile compressed transfer, GPU residency, decode and transcode, and visual artifacts independently. Use a dedicated aircraft tool that preserves hierarchy, animation tracks, and attachment nodes through orientation and simplification. The existing scripts provide profiling and compression references. The weapon optimizer flattens hierarchy when its orientation option is used. [Khronos texture compression extension](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md) · [Weapon optimizer](../tools/optimize-weapon.mjs) · [Model profiler](../tools/model-profile.mjs)
5. **Review in context.** Validate the model structurally, then render it in the real hangar and flight scene, including close chase, distant combat, shadows, takeoff, and night or haze where relevant. Verify orientation, gear, lights, effect positions, livery, silhouette, and collision proxy. Test running with several copies onscreen and record the relevant performance budgets with the asset revision. [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator)

### 6.2 Region, airfield, effect, and audio assets

Build both regions around authored terrain height, runway pads, readable landmarks, and repeatable transition materials. Bake terrain texture sets and reusable runway markings. Use shared buildings, hangars, beacons, barriers, and defense props placed in recognizable combinations. The authored Operations supply distinct compositions and mission routes. Procedural sectors reuse the same kit with region-specific placement rules and terrain blending. Batch static props into thin instances per chunk and transition distant silhouettes to simpler meshes or impostors. Static chunks need to accept an origin shift when their render positions change. Test vertex color with one detail texture and simple shaded water on Low. Profile optional shore foam, reflections, clouds, and altitude haze on Balanced and High. [Babylon.js thin instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances/)

Build a compact effects library for boost, contrails, flares, strikes, damage smoke, impacts, and airfield capture. Use pooled emitters and shared sprite materials with distance limits. Start with a bounded near-aircraft shadow pass and inexpensive projected or baked shadows elsewhere. Test optional wind streaks, camera lag, and boost field-of-view changes while keeping reduced-motion settings functional. Show important events at long range with a simpler effect and a HUD cue. Mix engine layers per role using synthesis, licensed samples, or both. Prepare short warnings and mission cues for fast decoding and use ambient loops for wind, coast, and mountain profiles. Keep an attribution manifest with the built asset bundle.

## 7. Aircraft uploads and custom sorties

### 7.1 Aircraft import and publish workflow

Extend the existing authenticated `/admin` area with a dedicated Aircraft section. The current weapon route stores GLB submissions for review. The flight feature adds a validation, preview, and publish flow backed by a versioned flight catalog. The goal is for the owner to add an aircraft to the hangar through the admin UI, with no code edits or deploy required. [Existing upload workflow](./09-admin-uploads.md) · [Admin handler](../packages/server/src/admin/AdminModule.ts)

1. **Submit.** Supply a self-contained `.glb`, display name, credit or ownership record, and an optional custom thumbnail. If your source is `.blend`, `.fbx`, `.obj`, or a `.gltf` folder, import it into Blender or an equivalent converter and export a self-contained `.glb` first. Name and path handling use server-generated storage IDs. Draft uploads are private and versioned.
2. **Validate.** Check the declared size and GLB header during intake. Run structural validation, resource inspection, and optimization in a dedicated child process outside the match server. Give each job a timeout and enforce memory and CPU limits at the OS or container level. Begin with one concurrent job and a bounded queue on the shared host. Reject external resources and unsupported extensions, and inspect geometry, decoded texture size, node count, animation, and embedded resources. Write prepared artifacts to staging. Publish only after the required checks complete, and clean up incomplete artifacts after a failed or timed-out job. Report actionable errors and preserve the original private draft. [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) · [Node worker resource limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerresourcelimits)
3. **Fit.** Show a spinning hangar preview and fixed top, side, front, and chase views. Set forward and up, scale, ground clearance, and the model's visual offset. Start with a bounding-box estimate and support numeric adjustments. Map supported gear, canopy, exhaust, and control nodes or supply visual anchors in the editor. Show the collision outline and landing clearance. Preview from both team livery colors.
4. **Assign handling.** Attach one of the four launch handling presets for a quick cosmetic variant, or copy a preset and tune a custom flight profile. The editor gives units, accepted ranges, handling explanations, and a test flight. Pitch, roll, acceleration, top speed, boosting, hit points, and landing limits remain authored data with server-side validation. In stock competition, use the published stock allowance and ruleset.
5. **Optimize and verify.** Produce a runtime GLB or optimized multi-level package, thumbnail, and manifest. The preview report compares the original and optimized size, texture dimensions, materials, and triangles against their respective budgets. A status screen tracks draft, processing, ready for review, published, and retired. Recoverable errors leave the draft available for correction. Preview the optimized version with the same renderer used in play. [Reference performance targets](#92-reference-performance-targets)
6. **Publish and manage.** Publish a catalog revision after approval. The browser refreshes the catalog in the hangar. Room owners opt into a published custom variant in eligible modes. Store immutable revisions by content hash and atomically change the catalog pointer after every asset is available. Active rooms pin their aircraft and sortie revisions so a later update or retirement takes effect for new sessions. Support restoring a previously published revision and retain pinned assets through an upgrade.

Use an initial **50 MiB** source upload cap on a dedicated aircraft route and aim for a runtime pack at or below **4 MiB** per custom aircraft. Keep the existing weapon handler's **100 MiB** limit. Confirm the aircraft caps with representative standard and unusually detailed models. Before committing a private room, report which custom aircraft contribute to the combined load budget and let the host revise the selection. Defer unrelated catalog assets until a player opens their hangar preview. Log validation and publishing outcomes by administrator action and revision so a failed processing job can be retried without producing duplicate catalog entries. [Admin handler](../packages/server/src/admin/AdminModule.ts)

### 7.2 Data contracts

Store validated, versioned records for the elements below. Prefer stable IDs plus content revisions for room manifests and share links. The simulation loads only the data it needs. A preview model change can be reviewed independently of handling balance.

| Record | Core fields |
| --- | --- |
| Aircraft asset | Asset ID/revision, model and thumbnail hashes, LOD paths, material slots, scale and axis corrections, visual anchors, animation mapping, source credit, validation report. |
| Flight profile | Profile ID/revision, role, speed band, acceleration, braking, turn response, roll, boost, recovery, hull, contact shape, and runway envelope. |
| Airframe | Airframe ID, display name, description, asset/profile revisions, permitted equipment and livery IDs, and mode eligibility. |
| Region | Region ID/revision, bounds or generator revision, collision and visual data, approach rules, landmark and airfield definitions, environment presets, and competitive layout IDs. |
| Sortie | Sortie ID/revision, region/layout, seed, time-of-day and weather presets, player and AI sides, allowed aircraft, difficulty, ordered objectives and limits, origin and service fields, author, and visibility. |
| Match content manifest | Mode/rules revision plus exact region, asset, airframe profile, and sortie revisions, with file hashes and expected preparation steps. |

Normalize stored orientation and units once at import. Keep the flight coordinate convention documented alongside those fields. Validate references through the same shared registries used when a player selects a sortie or joins a room. One representative test asset should be imported with an unusual source orientation and no optional rig nodes to exercise the standard preview and publishing path.

### 7.3 Custom sortie editor

The editor creates missions using the two regions and the six built-in objective types. It works for a private party or solo test flight. A template supplies defaults and the editor guides the player from setup to a visible flight plan.

| Editor step | Controls and validation |
| --- | --- |
| Setup | Choose region, authored layout or Frontier sector seed, time of day, weather, starting runway or air spawn, and any active flight boundary. |
| Aircraft and sides | Pick stock or eligible published aircraft, human and AI slots, bot difficulty, loadout restrictions, and whether captured runways can service the party. |
| Objectives | Place markers on a map, set the order of required and optional objectives, choose limits and fail conditions, and preview routes and capture zones. |
| Result | Choose how the sortie ends and which fields the debrief should summarize. Show predicted aircraft and content load with warnings before test flight. |
| Save and share | Save a reusable draft to the local profile. Export or import a versioned JSON preset. When a host creates a private room, validate the preset and share it with participants through the room invite. Pin the committed revision at room readiness. |

The editor checks reachable spawn positions, valid and clear runway approaches, target ownership, party sizes, aircraft compatibility, and missing dependencies. Start with a **64 KiB** UTF-8 preset limit, **12** levels of nesting, **16** objective steps, and **24** route waypoints per step. For any concurrently active step, apply the shared room entity caps. Use a versioned schema and validate bytes before parsing wherever the input path allows, then bound structure and resolve approved catalog references. Apply the same checks to local imports, room submissions, and shared presets. Show the exact failing field and preserve the rest of the draft if validation fails. Display a clear error if a referenced revision has become unavailable.

## 8. Integration and multiplayer

### 8.1 Repository integration

The current hub is Vite and TypeScript with Babylon.js. Its browser app has a shared canvas, an engine wrapper, a fixed-step loop, and separate showroom and match stages for the shooter and racer. The server runs Node and WebSockets, with a separate racing room manager and protocol. Use the same integration seams for flight. The hub selects the WebGL path with `app.init(false)` at `main.ts:122`. Profile flight on WebGL2. Existing WebSocket upgrade routing starts at `GameServer.ts:86`. [Current tech stack](./01-tech-stack-and-monorepo.md) · [Hub bootstrap](../packages/client/src/main.ts) · [Game server](../packages/server/src/GameServer.ts)

| Layer | Proposed responsibility |
| --- | --- |
| `packages/client/src/games/flight/` | Lazy-loaded flight scene, hangar preview, controls and camera, audio and effects, asset catalog, terrain worker and streaming, and flight network client. |
| `packages/client/src/ui/` | Hangar and fleet selection, public queue and private rooms, preparation overlay, training, flight HUD, custom sortie editor, and debrief. |
| `packages/shared/src/flight/` | Flight state and fixed-step controller, shared terrain and collision queries, match rules, registries, content schemas, and network message types. Keep data and simulation importable by Node. |
| `packages/server/src/flight/` | Queue and room lifecycle, authoritative combat, objective director and AI, slot and reconnect management, match results, and approved flight content catalog. |
| `packages/client/public/assets/flight/` and persistent server storage | Bundled stock models, textures, effects and audio plus separately versioned published aircraft packs. Keep private drafts in admin storage. |
| `tools/` | Validate and package aircraft, check content manifests, and drive browser and performance scenarios. |

Add the third game to the hub switcher and support proposed deep links `/?game=flight` and `/?flight=CODE`. Follow the existing scene disposal pattern and cancel stale preparation callbacks. Switching tabs or modes releases stage listeners and audio; leaving the game releases room and queue handles, workers, scenes, and GPU resources. Add an optional flight profile branch that takes defaults when existing guest records have never loaded flight. Scope the new WebSocket and API entry points to proposed routes such as `/ws/flight` and `/api/flight/catalog`. Exercise local Vite and production nginx routing in both connection modes. [Guest profile](../packages/client/src/state/UserProfileStore.ts) · [Deployment guide](./08-deployment.md)

### 8.2 Simulation, network, and match state

- **Simulation ownership.** Start at a fixed **60 Hz** server step and **20 Hz** snapshot cadence, matching the hub's shared tick defaults. Use shared rules for offline simulation and local prediction. Keep inputs sequenced. The server computes hits, launches, cooldowns, AI, capture, scoring, and equipment eligibility. Evaluate a different online step rate only if the mixed-room test shows a measurable need and replay and combat tests preserve gameplay quality. [Shared tick constants](../packages/shared/src/constants/tick.ts)
- **Rendering.** Interpolate remote aircraft and apply local corrections smoothly except for rule transitions such as a reset or spawn. Include server time, velocity, and last accepted input in snapshots. Begin with a **75 ms** interpolation delay and test using latency and correction telemetry. Bound any extrapolation to short snapshot gaps, then show a degraded or reconnecting state. Keep HUD state keyed to the current match and round IDs.
- **Room lifecycle.** Use lobby, preparing, countdown, live, results, and closed states with the match manifest revision and seats stored server-side. A `ready` event acknowledges the exact revision. A map, roster, or custom asset edit requires fresh readiness. Lock selections before the preparation clock starts. Use **75 seconds** for stock private rooms, matching Duel's 60-second local budget plus 15 seconds of coordination margin. Consider up to **90 seconds** for custom manifests only if measured preparation calls for it. On expiry, return to lobby and identify seats still loading. Public pairing has its own requeue behavior. Start the countdown as soon as all required seats are ready. [Air Duel flow](#41-1v1-air-duel) · [Race room](../packages/server/src/racing/RaceRoom.ts) · [Race protocol](../packages/shared/src/racing/RacingPacketCodec.ts)
- **Backpressure and interest.** Use bounded input history and coalesce obsolete snapshots before they enter the WebSocket send queue. Limit render-interest replication for faraway entities, with shared objective and teammate status available across the room. Keep confirmed events ordered and idempotent so reconnect or duplicate delivery cannot double-score a kill, objective, or capture. Reject out-of-range or incompatible input with an observable reason.
- **Recovery.** Reconnect uses a server-issued seat token scoped to the room. Send the current manifest, authoritative snapshot, round clock, seat status, and objective state before resuming input. Reserve the seat for a defined grace period. Keep clean disconnect, voluntary quit, reconnect expiry, and server shutdown as distinct outcomes. Apply expiration to inactive rooms and stale queue entries, and use idempotent cleanup on cancel or disconnect.

**Hits and lag compensation.** Sequence cannon inputs against the current round and enforce the fire-rate and heat rules on the server. Keep a ring of authoritative aircraft and relevant collider transforms; begin with **250 ms** of history. Estimate the current fire input time from the server's connection timing and use a bounded view offset tied to the allowed interpolation delay. For the first implementation, cap the total rewind at **150 ms**. Treat those durations as tunable. Use validated firing orientation and the aircraft's authoritative pose at the accepted fire tick, and ray-test against relevant collider state at the bounded view time with terrain occlusion. Apply the result once, to an eligible target in the current round. Clamp to the available history at round start. Offline uses the same ray and damage rules on current state.

Server-confirmed fire events drive remote cannon tracers and audio. Replicate firing cadence with events and keep individual cannon bullets out of snapshots. The server steps guided or falling ordnance through current authoritative state, uses swept collision, and replicates launches and consequential events. Test cannon hits and missile outcomes with two browsers at different latencies. Use the shooter's rewind buffer design as a structural reference. [Shooter lag compensation](../packages/server/src/systems/LagCompensator.ts)

### 8.3 Published content and hosting

Use the existing same-origin Docker and nginx topology. The `/api/` and `/ws` proxies already cover the proposed paths; the application defines the flight handlers. Keep private drafts on the server and serve published optimized artifacts through a dedicated server route under `/api/flight/` with a small revalidating catalog. Name publicly cacheable binaries by hash and give immutable URLs long-lived cache headers. Use access checks and private caching for room-scoped assets. Keep deployment assets and dynamic catalog data independently versioned. Store accepted content, draft state, and catalog metadata in persistent storage under the mounted data volume. Include it in backup and restore verification. Confirm published revisions and authorized room assets remain available for the lifetime of each pinned match. [Docker Compose configuration](../docker-compose.yml) · [nginx configuration](../deploy/nginx.conf)

## 9. Loading and performance

### 9.1 Preflight and streaming

Aim for **30 seconds** cold and **5 seconds** warm on the reference setup. Allow up to **60 seconds** for local preparation under those conditions to protect in-flight frame pacing. Launch as soon as preparation and online readiness finish. The clock for local preparation starts when the match manifest and aircraft selections are locked. Record selection, matchmaking, and waiting for peers as separate timings. The preparation screen has cancel, retry, a stage label derived from real work, and briefing details. Start likely asset fetches while the player is in the flight hangar. The cold-load path prepares the resolved match manifest for the selected mode and allowed aircraft. A warm repeat reuses cached immutable content while still preparing the next scene as needed.

| Stage | Work before readiness |
| --- | --- |
| Resolve match content | Pin the manifest, selected airframes, starting scenery, region collision data, effects, and required audio. Display what the player is loading and verify content availability. |
| Prepare and decode | Fetch the initial asset set, decode needed resources, build the opening sector and immediate safety ring, and make collision ready. Load all competitive airspace before a Duel or Domination match. |
| Allocate and warm | Initialize bounded entity and effect pools, upload required geometry and textures, and render representative views and effects to warm material variants. Include first fire, damage, capture and airfield service variants where the mode uses them. |
| Ready and deploy | Wait for the final mode dependencies and input readiness, confirm scene teardown and replacement, and report the pinned revision to the server. The online countdown starts when all required seats are ready. |

**World streaming.** Keep sector ownership and simulation state in canonical sector and local coordinates. Start with a two-sector low-detail safety ring around each relevant pilot, deduplicating overlapping sectors, and prefetch at least three sectors ahead on likely flight paths. A sector is about **5.7 seconds** of travel at the **360 m/s** speed ceiling. Keep objectives, target routes, and imminent ordnance collision paths ready before engagement. Extend the look-ahead when maximum travel during the measured 99th-percentile sector preparation time plus **3 seconds** of turn and scheduling margin exceeds the baseline. Generate CPU terrain buffers in a bounded worker pool and transfer their ownership to the render thread. Limit new Babylon meshes and GPU uploads to small batches. Prioritize collision and low-detail terrain, then replace distant visuals gradually. [World scale](#51-world-design) · [Transferable buffers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)

**Fallback under load.** Retain a low-detail ring around the party and predict the next sectors from planned objectives as well as current movement. Keep collision valid before an entity can reach a sector. If visual detail arrives late, preserve the low-detail fallback through distance haze. Hold encounters behind a visible approach gate until their location and required colliders are ready. Cancel stale jobs when the pilot changes direction. Bound cache size by bytes and release distant meshes, textures, audio, and queued work. Retain sparse run events and base ownership independently of the render cache.

**Frame work.** Reuse projectile, effect, and entity-view storage and keep per-frame allocation low. Combine repeated static props per chunk and use model and effect levels of detail at measured distances. Begin from the hub's existing adaptive resolution and device-pixel-ratio handling. Reduce render scale, shadow distance, reflection quality, volumetric effects, and particles in lower presets. Preserve gameplay visibility, flight simulation, and warning timing across presets. Profile main thread, GPU, worker backlog, per-frame upload cost, cache memory, and reported server correction separately. [Engine scaling](../packages/client/src/core/EngineApp.ts)

### 9.2 Reference performance targets

The following are **candidate release gates** to confirm during the first benchmark milestone. Record hardware, operating system, browser version, graphics preset, actual render resolution, and refresh rate in each run. Suggested primary reference is an i5-11400-class desktop CPU, a GTX 1650-class GPU, 16 GB RAM, and a 60 Hz 1080p display on Balanced. Add a representative integrated-GPU laptop on Low and publish the measured experience. Run on the production build with hardware acceleration enabled and a foreground tab. For cold loading, throttle to a repeatable test profile of 20 Mbps and 60 ms round-trip latency.

| Metric | Proposed launch gate |
| --- | --- |
| Cold first deploy | Aim for **30 seconds** from locked selections and manifest to local ready. In five fresh-cache runs per critical scenario, require each to finish within **60 seconds** under the reference conditions. Measure queue and remote-player waits separately. |
| Warm repeat | Aim for **5 seconds** on the same reference setup when region and match assets are already cached. Record shader warm-up and local ready separately. |
| Frame pacing on Balanced | Aim for 60 FPS at 1080p and a 95th-percentile frame interval at or below 18 ms, with 99th percentile at or below 25 ms in the core scenarios. During each five-minute steady-state capture, investigate every frame over 50 ms before accepting the build. |
| Gameplay and streaming | Verify first weapon use, capture, landing, and incoming threats during the capture. Test repeated sector crossings and U-turns. Terrain stays present at the minimum visual detail and collision remains continuous. |
| Long-run resources | At least one 45-minute, four-pilot Frontier soak. The high-detail working set and worker backlog stay bounded, with sparse run-state growth measured separately. A hub switch releases flight scene resources. |
| Compressed transfer | Target at most **32 MiB** of match-critical downloads for a stock cold match. Plan **1–4 MiB** per stock aircraft pack. Count assets delivered for the selected region and match manifest. |
| GPU resource residency | Track estimated peak bytes for resident textures, geometry buffers, and render targets separately from compressed delivery size. Start with the preset ceilings below and measure at maximum populated scenes and sector transitions. |
| Decode and transcode | Aim for **3 seconds** of wall time for critical asset decode and transcode on Balanced. Report the costs for the cold and warm paths, along with upload and shader warm-up durations, so improvements can be measured against local readiness. |
| Aircraft art starting tier | Target roughly **15,000–30,000** triangles for a close flight mesh, a simpler middle tier, and a strongly reduced far tier. Start with **1K** textures and selectively test **2K** on close aircraft materials. |
| Online capacity | Keep 95th-percentile aggregate simulation work inside the **16.7 ms** step interval on the target host and leave headroom for snapshots and room traffic. Verify cadence, event-loop delay, queue buildup, and reconnects across the mixed-room benchmark. |

### 9.3 Scene budgets

Use these as starting ceilings for the first profiling pass. Count draw calls across the rendered passes. Count submitted visible triangles in the main view. Count sprites and effect particles at peak overlap. Estimate GPU bytes for the flight scene, including shadow and post-processing targets, and record peak allocations during scene transitions.

| Render budget | Low | Balanced | High |
| --- | --- | --- | --- |
| Draw calls per frame | 100 | 180 | 260 |
| Submitted visible triangles | 250,000 | 600,000 | 1,000,000 |
| Visible sprites and effects particles | 384 | 768 | 1,536 |
| Estimated resident GPU resources | 192 MiB | 320 MiB | 512 MiB |
| Terrain upload limit per frame | 1 batch and 0.5 MiB | 1 batch and 1 MiB | 2 batches and 2 MiB |

Start with shared room limits of **12 AI aircraft** and **12 active ground defenses** in PvE, alongside the mode's allowed human pilots, and **64 simultaneous gameplay ordnance entities**. PvP follows its seat limit, including bot fill. Treat far-off encounter and airfield states as lightweight data until they activate. Limit launches and reinforcements in the authoritative rules, and prioritize existing projectiles and warning cues up to the cap. Use the same simulation limits across graphics presets. Cap terrain batch size and tune the amount of render-thread time it takes as well as the bytes uploaded.

Profile a full-human 4v4 match and a bot-filled 4v4 under equivalent settings. Also capture a pass over an active airfield, a four-player co-op objective under effects load, a long Frontier route across streamed sectors, and a public duel with introduced latency. Separate load-time work from frame-time work and compare first-use events against subsequent passes. If a scenario misses the gate, identify the bottleneck and adjust effects, LOD, upload pacing, encounter budgets, or server room limits based on the measurements. [Browser frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing)

### 9.4 Shared server benchmark

Run the production deployment build on the intended host with actual shooter, racer, and flight rooms in one Node process. Start with one populated shooter room, one eight-seat race with bot fill, one public flight Duel, one bot-heavy Air Domination room, and one four-pilot Frontier room running scripted inputs and objective events. Measure single-mode baselines first. Then ramp the mixed workload in complete groups, sustaining each step for at least **10 minutes** and introducing joins and reconnects during combat. Run a separate upload-processing job while the server is near its candidate capacity. Track tick interval and deadline misses, p95 and p99 per-room and aggregate update time, event-loop delay, CPU and resident memory, send queue growth, and reconnect time. Record the first sustained miss and choose a supported room count with headroom below it.

## 10. Build milestones and release criteria

Each milestone delivers a usable slice of the final design. Air Duel is the first complete internal online milestone. Plan the first public release around all four modes and the acceptance criteria below.

| Milestone | Build and verify |
| --- | --- |
| **Flight feel and integration** | Add the flight entry and lifecycle. Implement the Meridian with arcade handling, near and far chase, remappable input, basic HUD, a runway, and takeoff and landing assists. Establish the engine and asset benchmark. Validate scene disposal through game switching. |
| **Air Duel and combat** | Finish shared combat, airspace layouts, scoring, public queue and preparation, authoritative rounds, reconnects, and rematches. Test two actual browsers and both input methods. |
| **Operations, Domination, and Frontier** | Build shared objectives, teams and bot fill, capture and service, authored missions, and terrain streaming on both regions. Verify solo and four-player Frontier, including landing after returning to a previously unloaded field. |
| **Fleet and creators** | Complete all stock aircraft and AI airframes, animation and sounds, the upload and publish path, and the custom sortie editor. Publish a representative new aircraft from the admin UI and use it in a private hosted sortie. |
| **Release polish** | Run mixed content and device playtests, tune the handling and balance, finalize art and audio attribution, benchmark frame pacing and cold loads, fix regressions, and verify deploy and rollback on a test environment. |

### 10.1 Acceptance checklist

- **Complete loop.** A first-time player can choose a jet, finish the training sortie, enter each launch mode, read the outcome, and return to the hub with settings saved. The game offers readable control hints and warnings with both supported inputs. Verify at least one complete playthrough with reduced-motion and alternate HUD settings.
- **Public pairing.** Two separate guests queue, accept, load, play the complete best-of-three, and mutually rematch. Exercise the acceptance and loadout deadlines, one absent opponent, one late loader, duplicate readiness, a reconnect, a forfeit, tied rounds, and queue cancellation. Each player ends up in exactly one valid queue or match state, and each completed match produces one result.
- **Teams and missions.** Private 4v4 works with human and bot mixes, handles vacancies and overtime, and reports objective scoring. All six authored Operations have a tested success path and failure result. Solo and four-player Frontier can complete each dynamic objective, capture a field, service there, continue into new sectors, and debrief with a coherent score. Closing and reopening a solo session restores the last serviced checkpoint with matching inventory, territory, and score.
- **Assets and custom content.** Four stock jets are distinct in both handling and silhouette. A representative valid third-party or newly authored GLB can be fitted and published, selected in a permitted private room, and tested end to end without a deploy. Invalid imports are recoverable. Replacing or retiring a model preserves active rooms pinned to it. A custom sortie can be saved, exported, imported, launched, shared, and completed with validated settings.
- **Performance and recovery.** Cold preparation, warm repeat, foreground flight, and co-op soak meet the agreed targets. Simulate a slow connection, interrupted download, late terrain, and reconnect during an objective. Readiness and progress remain truthful and players can retry or exit. Higher art presets retain clear targets and warnings under the heaviest supported effects.
- **Hub and deployment.** Switching between flight, shooter, and racer disposes the prior stage and restores the selected mode. Existing guest profiles load with sensible defaults. Typecheck and the existing test suite pass when implementation is ready. Confirm production WebSocket routing, a clean browser console on primary flows, published asset persistence across deployment, and catalog rollback.

### 10.2 Playtest decisions

Confirm the final title and fleet visual direction with the first complete hangar and airfield scene. Use beginner and experienced-player sessions to tune mouse and controller defaults, mid-speed handling, lock timing, rewind cap, and 1v1 round duration. Adjust capture and objective timers after co-op playtests that include failed approaches and mixed loadouts. Set final depth configuration, asset ceilings, supported browsers, and room capacity after measuring the reference scenes and server workload. Record the outcome and the test that supported it in this file.

### 10.3 Release contingency

Review the schedule after Air Duel and again after the mixed-room benchmark. If eight-player performance, balance, or QA is on the critical path, price **4v4 Air Domination** as the first candidate for deferral. Estimate remaining mode-specific engineering, content, QA, and hosting work against the calendar time the move would recover. Count a task as a saving only if Duel, Operations, Frontier, or shared flight systems can launch without it. Retain the four-mode plan until the owner explicitly approves a scope change. Present the estimate and measured blockers at that decision point.

### 10.4 Repeatable test plan

| Suite | Coverage |
| --- | --- |
| Shared unit tests | Fixed-step and input ranges, speed and turn curves, quaternion normalization, ground-to-air and approach transitions, heightfield borders, swept collision, cannon timing and occlusion, and bounded sortie validation. |
| Seeded replay | Record the rules revision, seed, initial state, and tick inputs. Replay scenarios in Node and the browser, comparing numerical state within tolerance and checking identical gameplay outcomes. Include a sector-boundary crossing, a capture, and a saved solo checkpoint. |
| Two-browser online | Public queue, match offer expiry, selection lock, matching manifests, late readiness, reconnect, scoring and round resets, and mutual rematch. Measure hits and corrections on a clean connection, at **100 ms RTT** with jitter, and with **5% packet loss** as a stress case. Apply loss below the WebSocket layer to exercise retransmission and delivery delay. [WebSocket protocol](https://www.rfc-editor.org/rfc/rfc6455.html) |
| Room and capacity soak | Script clients and bots through sustained Domination and Frontier play, plus joins, exits, and reconnects. Check stable active resources, retained territory, room cleanup, mixed-room deadlines, and the impact of a concurrent aircraft processing job. [Shared server benchmark](#94-shared-server-benchmark) |
| Asset and browser checks | Run clean and cached preflight profiles in the production browser build. Exercise malformed and oversized submissions, processing failure and timeout, an off-axis animated aircraft, revision pinning and rollback, and a custom sortie shared with a second client. |
