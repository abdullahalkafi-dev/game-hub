# 03 — Tactical Shooter Guide

## Default controls

| Input | Action |
| --- | --- |
| `WASD` or arrow keys | Move |
| `Shift` | Sprint forward |
| `Space` | Jump or vault low cover |
| `C` or left `Ctrl` | Crouch. Crouch while sprinting forward to slide. |
| `Q` / `E` | Lean left or right |
| Left mouse button | Fire |
| Right mouse button | Aim down sights. During a throw preview, cancel the throw. |
| `1` / `2` | Select primary or secondary weapon |
| `X` or mouse wheel | Swap between the two weapons |
| `R` / `B` | Reload / cycle the weapon's available fire modes |
| `V` | Cycle compatible optics on the current weapon while keeping ammo. Gunfight uses its mirrored kit. |
| `K` / `I` | Quick knife / inspect the held weapon |
| `3` / `4` / `5` | Select frag / flashbang / smoke |
| Hold `G`, then release | Preview the throw arc, then throw |
| `Shift` while using 6x | Steady the scope for up to three seconds |
| `F` | Plant or defuse in Tactical Wipeout when in range |
| `Z` or middle mouse button | Send a team danger ping |
| `Tab` / `L` / `M` | Scoreboard / Loadout / match menu |
| `Escape` / `F2` | Release mouse capture / lock mouse aim again |

The **Lock mouse** button also restores aim. Under **Settings → Combat keys**, you can change the weapon, throwable, reload, crouch, knife, and inspect bindings or reset them to defaults. **Toggle crouch** switches between a press and a hold.

## Team Deathmatch

Choose **4v4 Team Deathmatch** in the lobby. The first team to 30 eliminations wins, or the team ahead at seven minutes. Equal scores at timeout produce a draw. An elimination adds a point while the surviving player stays in place and keeps their current health and equipment.

- **Respawn.** The defeated player returns after three seconds. The server favors unoccupied team spawns out of enemy sight and farther from opponents. Spawn protection lasts up to two seconds and ends if you shoot or throw a grenade.
- **Loadout.** The Loadout menu has two editable saved kits. Edits during the match apply on the next life. Each life starts with one of each of the two throwables selected for that kit. The HUD tracks each type's remaining stock.

## Movement, cover, and character animation

Crouching lowers stance and tightens spread. Leaning moves the camera and hitboxes sideways so players can peek around cover. Sliding carries sprint momentum for a short burst. Low cover supports vaulting.

The first-person view uses distance-based stepping and damped bob. Remote soldiers blend walking, running, strafing, backpedaling, jumping, and crouch poses from movement snapshots. Footsteps follow distance traveled, and the rig aligns both hands with the primary weapon grips. Spawn screens and low center cover on all three maps give players a place to stop and peek before entering sightlines.

The first-person arm rig uses full-finger gloves, woven sleeves, and fitted cuffs. The Kar98k and AWM use grip points on the imported stock and wooden fore-end. The rig follows reloads, sprints, weapon swaps, inspections, and throws, with procedural arms as a fallback. [WRAD ARMS, CC0](https://github.com/wwwriks/wrad-arms)

## Healing, pickups, and match feedback

- **Auto-healing.** In every mode, during Warm-Up, live play, or overtime, HP regenerates at 10 per second after five seconds without damage. A new hit restarts the timer. The HUD shows **Recovery in …** and **Recovering health**.
- **Pickups.** Walk over the blue armor kit or gold ammo crate. Armor adds up to 25 points. Ammo recovers reserve ammunition for both slots. Pickups reappear after 25 seconds.
- **Close combat.** The quick knife uses server-checked range, facing, and line of sight. A hit from behind deals bonus damage.
- **Death view.** A short killcam shows the killer's recorded view when history is available. Press Space to skip, then click to cycle living teammates while waiting to respawn.
- **Match results.** The scoreboard shows accuracy. The result panel shows MVP, accuracy, headshot-kill percentage, and longest kill streak. Scoring successive kills can trigger multikill and streak notices. Completing matches earns XP toward levels and weapon skins.

## Gunplay and scopes

- **Spread and recoil.** Weapon and attachment stats control aim, recoil, and reloads. The HUD and server use the same stance and movement spread rules. Short taps register in automatic fire mode.
- **Hits and impacts.** The server resolves head, chest, and limb hitboxes, armor, cover, and thin-material penetration. Tracers and surface impacts follow the confirmed shot path. The M870 fires eight pellets with one gunfire report and grouped hit feedback.
- **Sniper trajectories.** Sniper shots start to fall at distance. The server tests the bent path against world geometry and hitboxes and carries reduced damage through thin cover.
- **Optics.** Red dots, 2x, and 6x are available on compatible weapons. At full aim, the 2x and 6x reticles are drawn in the HUD and first-person weapon geometry is hidden from the magnified view. Compatible attachments replace imported built-in optics so they do not overlap. The 6x supports breath control.
- **Feedback.** Body hits, armor breaks, headshots, and eliminations have distinct hit feedback and confirmed damage numbers. A directional arc points toward incoming damage. Steel practice targets flash and play a metallic ping when hit in Warm-Up.

## Throwables

The frag damages nearby players, the flashbang affects visibility and sound based on facing and line of sight, and smoke creates a temporary screen. Select the type before holding the throw key. The preview shows the path up to the first surface contact, and the thrown grenade bounces on map geometry. Right-click cancels the preview and keeps the grenade in stock.

In TDM, the fuse starts on release. In the other modes, holding the throw key cooks eligible grenades.

## Maps and modes

| Mode | Rules |
| --- | --- |
| **1v1 Aim Duel** | First to five rounds, with a 45-second round timer |
| **2v2 Gunfight** | First to four rounds, with a 60-second timer and a mirrored kit that changes every two rounds |
| **4v4 Tactical Wipeout** | First to four rounds, with a 75-second timer and a bomb objective. Planting takes three seconds and defusing takes four. |
| **4v4 Team Deathmatch** | Continuous respawns, first to 30 eliminations, seven-minute limit |
| **Warm-Up Aim Range** | Standalone practice with reactive steel targets and respawns |

In round-based play, a round still underway at 45 seconds can activate the capture zone while there is no planted bomb. Holding the zone for three seconds wins the round.

- **Cargo Docks** has container lanes, elevated catwalks, thin crates, and explosive drums.
- **Desert Outpost** has sandstone cover, rooftop routes, and market lanes.
- **Neon Rooftop** has a rooftop helipad, glass cover, and elevated lanes.

Rooms can use **Easy**, **Normal**, or **Pro** bots. Easy bots take longer to acquire targets, turn more slowly, and pause longer between shorter bursts. The room host can change bot difficulty from the in-match Settings.

Normal and Pro bots can throw frags or shoot an explosive barrel near an opponent. Custom rooms can set a time limit and enable friendly fire. Ranked TDM uses its standard timer, disables friendly fire and bots, and starts when eight human players are connected.

## Audio and accessibility settings

- **Master**, **Gunfire**, and **Hit feedback** have separate volume controls. The defaults are 75%, 55%, and 70%, respectively. Gunfire volume affects local and remote weapon reports. Hit feedback controls confirms and the steel-target ping.
- The default headshot cue is a short nonverbal impact. **Spoken headshot callout** adds an optional voice cue. Source attribution is in [Audio credits](../packages/client/public/assets/audio/CREDITS.md).
- **HRTF** toggles binaural spatial panning. Directional panning and distance attenuation are available with HRTF off.
- Metal, sandstone, and concrete footsteps have different sounds. Teammates hear an enemy-spotted callout for a visible enemy ping. Hit-marker styles are **Cross**, **Dot**, and **Minimal**.
- Settings also include an 80–110° FOV range, separate hip-fire and ADS sensitivity, raw mouse input, crosshair presets and customization, and four graphics quality levels. The live HUD shows FPS, ping, snapshot age, and movement corrections.
