# StrikeCore documentation

The game hub includes StrikeCore, a browser-based multiplayer tactical shooter, and ApexDrive Street Racer. Play 1v1 Duel, 2v2 Team Duel, 4v4 Team Deathmatch, or the Warm-Up Aim Range across Cargo Docks, Desert Outpost, and Neon Rooftop.

## Start here

- **Play locally** with the [development setup](./01-tech-stack-and-monorepo.md#run-locally).
- **Create or join a room** with the [match-flow guide](./02-onboarding-and-match-flow.md).
- **Race or practice** with the [ApexDrive guide](./05-game2-street-racer.md).
- **Look up controls, healing, or audio settings** in the [shooter guide](./03-game1-tactical-shooter.md).

## Documentation index

| Document | What it covers |
| --- | --- |
| [01 — Tech stack and monorepo](./01-tech-stack-and-monorepo.md) | Local setup, package layout, server endpoints, and the asset-loading path |
| [02 — Onboarding and match flow](./02-onboarding-and-match-flow.md) | Guest profiles, Quick Play, room invites, bot fill, Warm-Up, match starts, and reconnects |
| [03 — Tactical shooter](./03-game1-tactical-shooter.md) | Controls, TDM healing and respawns, gunplay, scopes, grenades, audio, maps, and bots |
| [04 — Modular registries](./04-modular-registries-guns-mods-skins.md) | Current weapon, attachment, skin, throwable, and map definitions |
| [05 — Street and track racer](./05-game2-street-racer.md) | Race modes, controls, tracks, garage, and Time Trial ghosts |
| [06 — Netcode and roadmap](./06-netcode-and-roadmap.md) | Current WebSocket protocol, movement prediction, authoritative combat, and future work |
| [07 — Combat and visuals overhaul](./07-combat-visuals-overhaul-changelog.md) | Latest changelog and handover: particle fix, barrels, grenades, procedural weapons, hands, optic quick-swap, and open items |
| [08 — Deployment](./08-deployment.md) | Docker stack, nginx and TLS layout, and how to ship an update to the VPS |
| [09 — Admin uploads](./09-admin-uploads.md) | The private `/admin` page for uploading weapon `.glb` models, its password, limits and the review workflow |
| [Audio credits](../packages/client/public/assets/audio/CREDITS.md) | Attribution for gunfire, reload, and the optional spoken headshot cue |
