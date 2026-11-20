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
| `V` | Cycle compatible optics on the current weapon while keeping ammo. |
| `K` / `I` | Quick knife / inspect the held weapon |
| `3` / `4` / `5` | Select frag / flashbang / smoke |
| Hold `G`, then release | Preview the throw arc, then throw |
| `Shift` while using 6x | Steady the scope for up to three seconds |
| `Z` or middle mouse button | Send a team danger ping |
| `Tab` / `L` / `M` | Scoreboard / Loadout / match menu |
| `Escape` / `F2` | Release mouse capture / lock mouse aim again |
| `-` / `=` | Master volume down / up (5% steps, with an on-screen indicator). The match menu also has a volume slider. |
| `F8` | Mute or unmute all sound |

The **Lock mouse** button also restores aim. Under **Settings → Combat keys**, you can change the weapon, throwable, reload, crouch, knife, and inspect bindings or reset them to defaults. **Toggle crouch** switches between a press and a hold.

## Deathmatch

Every mode is a continuous deathmatch. An elimination adds a point to the killer's team while the killer stays in place and keeps current health and equipment. The match ends at the kill limit (default 20) or when the timer (default 8 minutes) runs out, and the team with the most kills wins. Equal scores at timeout produce a draw. The host chooses the time and kill limit when creating a room.

- **Respawn.** The defeated player returns after three seconds. The server favors unoccupied team spawns out of enemy sight and farther from opponents. Spawn protection lasts up to two seconds and ends if you shoot or throw a grenade.
- **Loadout.** The Loadout menu has two editable saved kits. Edits during the match apply on the next life. Each life starts with one of each of the two throwables selected for that kit. The HUD tracks each type's remaining stock.
- **Kill banners.** Your own kills show a large centre banner with the victim's name and tags for headshots, wallbangs, long range, multi-kills, and streaks. A death banner names who killed you, with their weapon, distance, and remaining health. The kill feed in the top right fades after a few seconds and highlights kills involving you.

## Throwables

The frag damages nearby players, the flashbang affects visibility and sound based on facing and line of sight, and smoke creates a temporary screen. Select the type before holding the throw key. The preview shows the path up to the first surface contact, and the thrown grenade bounces on map geometry. Right-click cancels the preview and keeps the grenade in stock.

In matches, the fuse starts on release. In the Warm-Up range, holding the throw key cooks eligible grenades.

## Maps and modes

| Mode | Rules |
| --- | --- |
| **1v1 Duel** | Continuous deathmatch for two players |
| **2v2 Team Duel** | Continuous deathmatch, two teams of two |
| **4v4 Team Deathmatch** | Continuous deathmatch, two teams of four |
| **Warm-Up Aim Range** | Standalone practice with reactive steel targets and respawns |

All competitive modes share the same room settings: 5, 8, 10, or 15 minutes (or unlimited) and a kill limit of 10, 15, 20, 30, or 50 (or none). The default is 8 minutes and 20 kills.

- **Cargo Docks** has container lanes, elevated catwalks, thin crates, and explosive drums.
- **Desert Outpost** has sandstone cover, rooftop routes, and market lanes.
- **Neon Rooftop** has a rooftop helipad, glass cover, and elevated lanes.

Rooms can use **Easy**, **Normal**, or **Pro** bots. Easy bots take longer to acquire targets, turn more slowly, and pause longer between shorter bursts. The room host can change bot difficulty from the in-match Settings.

Normal and Pro bots can throw frags or shoot an explosive barrel near an opponent. Custom rooms can set a time limit and enable friendly fire. Ranked TDM uses its standard timer, disables friendly fire and bots, and starts when eight human players are connected.

## Audio and accessibility settings

- **Master**, **Gunfire**, and **Hit feedback** have separate volume controls. The defaults are 75%, 55%, and 70%, respectively. Gunfire volume affects local and remote weapon reports. Hit feedback controls confirms and the steel-target ping.
- The default headshot cue is a short nonverbal impact. **Spoken headshot callout** adds an optional voice cue. Source attribution is in [Audio credits](../packages/client/public/assets/audio/CREDITS.md).
- **HRTF** toggles binaural spatial panning. Directional panning and distance attenuation are available with HRTF off.
- Footsteps use recorded concrete, sand, and metal sounds with several variations each. Enemy steps come from their real direction, carry farther when they sprint, fade to almost nothing when they crouch, and sound dull and quieter when a wall is between you. Gunshots and explosions get the same distance and wall muffling. Teammates hear an enemy-spotted callout for a visible enemy ping. Hit-marker styles are **Cross**, **Dot**, and **Minimal**.
- Settings also include an 80–110° FOV range, separate hip-fire and ADS sensitivity, raw mouse input, crosshair presets and customization, and four graphics quality levels. The live HUD shows FPS, ping, snapshot age, and movement corrections.
