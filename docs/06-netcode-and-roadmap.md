# 06 — Multiplayer Netcode & Roadmap

## Current transport

The game runs a headless Node.js HTTP server with `ws` WebSockets. The room manager keeps room state in memory, handles room codes, and selects matching public rooms. Each arena room owns player movement, damage, scores, loadouts, bots, and map interactions. [GameServer](../packages/server/src/GameServer.ts) · [RoomManager](../packages/server/src/rooms/RoomManager.ts) · [FpsArenaRoom](../packages/server/src/rooms/FpsArenaRoom.ts)

~~~text
Browser → /ws → GameServer → RoomManager → FpsArenaRoom → shared Rapier world
Browser → /api/rooms → public room summaries
Browser → /api/health → liveness and movement protocol version
~~~

The current **movement protocol version is 4**. Clients and servers should ship together. The WebSocket carries JSON room and combat events, input commands, and local-player snapshots alongside binary world snapshots. [PacketCodec.ts](../packages/shared/src/net/PacketCodec.ts)

## Movement and synchronization

- The room simulates at **60 Hz** and sends world and local-player snapshots at **20 Hz**. Room summaries and timers are also broadcast twice a second and when relevant events occur.
- The client immediately predicts movement with the same [character controller](../packages/shared/src/physics/FpsCharacterController.ts) used by the server. The server processes queued input within a time budget. `LOCAL_STATE` acknowledges processed movement and shots. The client restores authoritative movement when needed and replays unacknowledged inputs, smoothing the visible correction.
- A movement epoch identifies the current stream. Spawn, match start, and reconnect reset the stream. The server rejects commands tagged with an old epoch.
- The client draws remote players through a **100 ms interpolation buffer**. A binary world snapshot has a **12-byte header** and **26 bytes per player** for position, angles, lean, stance and grounded flags, weapon slot, health, armor, and horizontal velocity. The grounded and movement data drive remote gait and footsteps.

## Authoritative firing and TDM state

The client predicts immediate feedback such as muzzle flash, recoil, and local gunfire. The server validates rate of fire and ammo, samples the shot cone, tests collisions, and resolves damage and penetration. It keeps up to **60 hitbox frames** and clamps the rewind request to **400 ms**. Human shots use roughly half the measured round-trip time plus the client interpolation delay.

`SHOT_FIRED` carries the confirmed paths for one physical shot. Shotguns put all pellets in that same message so remote audio plays once. The client uses confirmed path endpoints and surfaces for tracers and impacts. `HIT_CONFIRM` reports the shooter's grouped hit feedback. Practice target hits are checked on the server during Warm-Up.

TDM counts points, chooses safer spawns, tracks spawn protection, and checks grenade inventory on the server. `LOCAL_STATE` includes the authoritative throwable counts and spawn-protection timer for TDM, and the healing timer during each mode's fightable phases. Live TDM loadout changes are queued and applied at respawn. Each valid grenade throw consumes the selected type, and the shared physics world is used to bounce grenades off cover.

Melee and pickup effects are validated on the server. The room samples up to 2.5 seconds of replay history at 12 Hz and sends only the relevant camera and target poses to the victim on elimination. Gunfire accuracy counts each physical shot once. Ranked match ratings are recorded by guest ID and are stored on the server at the path configured by `STRIKECORE_RATINGS_PATH`. The default is `.strikecore-ratings.json` in the server's working directory. The ladder is available at `GET /api/leaderboard`.

The server reserves a disconnected player's seat for up to **20 seconds** by guest ID. The active host role migrates to a connected human. The expected lobby and reconnect behavior is in [Match flow](./02-onboarding-and-match-flow.md#reconnects-host-changes-and-rematches).

## ApexDrive race synchronization

ApexDrive uses racing protocol **version 2** on `/ws/race` and lists public lobbies on `/api/race-rooms`. The server simulates vehicles at 60 Hz and publishes snapshots at 20 Hz. The owning client predicts locally and reconciles against acknowledged inputs. Grid readiness carries a revision so a delayed ready message for the previous circuit cannot start the new grid.

The server clears held driving input on disconnect and retires stale held input after 250 ms. The driver can reconnect to their reserved seat with a fresh input sequence. Results and records come from the final server standings. Regression coverage includes real lap crossings on all three circuits, readiness, reconnects, rematches, and Time Trial. [ApexDrive specification](./05-game2-street-racer.md)

## Maintenance and roadmap

- Use `pnpm test` for shared controller and packet coverage, authoritative room rules, and real WebSocket transport tests. Use `pnpm build` to verify that all three packages compile together.
- Browser checks should cover input and pointer recapture, weapon swaps, optics, grenade preview and cancel, and both Warm-Up and live TDM recovery. To verify healing, survive a hit and confirm that the countdown resets after a second hit and that HP rises when the timer expires.
- Future transport experiments can evaluate an unreliable channel for snapshots. Any evaluation should compare latency, recovery, and browser support against the current WebSocket transport.
