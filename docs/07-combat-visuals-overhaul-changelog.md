# 07 — Combat and visuals overhaul (changelog and handover)

This is the historical handover for the earlier visuals pass. See the [current shooter guide](./03-game1-tactical-shooter.md) for the follow-up features and current rules.

This document records one round of work on weapons, hands, grenades, explosive barrels, particle effects, and the optic quick-swap. It explains what changed, where, why, how it was verified, and what is still open, so the next person (or AI) can continue without re-deriving it.

Status at the end of this round: `pnpm typecheck` is clean and `pnpm test` passes (36 tests, one of them new). All visual checks were done in a headless browser at roughly 5–10 FPS, not on a real GPU.

## Summary

| Area | Result |
| --- | --- |
| Explosions and all particles | Root-cause fix: particles now age correctly. Blasts have fireball, smoke, embers, shockwave, debris, scorch, and light. |
| Explosive barrels | Damage states, a short fuse, chain reactions, and grenade damage to props. |
| Grenades and flashbang | Real grenade models, held-grenade rig, pin pull, throw animation, spin and trail, world flash burst, longer screen white-out. |
| Weapons | New procedural builder with real proportions and detail for rifles, SMGs, shotgun, bolt rifle, and pistol. |
| First-person hands | Rebuilt gloved hands and shorter, slimmer forearms anchored to each gun's grip points. |
| Optic quick-swap | `V` cycles optics on the held weapon, server-validated, ammo kept. |
| Small UI fixes | HP rounding, kill-feed width, gunsmith framing, controls text. |

## 1. Root cause: particles never aged

The game runs its own `requestAnimationFrame` loop (`GameLoop`) and calls `scene.render()` directly. Babylon never saw a frame boundary, so `engine.getDeltaTime()` stayed stale and every `ParticleSystem` aged almost not at all. This is why explosions, sparks, and smoke looked dead.

- Fix: `ShooterScene.ts` now wraps the render call with `this.app.engine.beginFrame()` and `endFrame()`.
- Second cause: a new `ParticleSystem` per explosion is not ready until its shader compiles, and a short burst had already ended by then.
- Fix: burst systems are created once in the `VfxSystem` constructor (`BURST_DEFS` table, `createBurstSystem`) and re-triggered with `manualEmitCount` through `emitBurst`.
- Babylon particles default to additive blending, so dark smoke was invisible. Smoke systems now set `BLENDMODE_STANDARD` explicitly.
- `spawnBulletImpact` still creates one system per shot. It works once its shader has been compiled, but it could be pooled the same way.

## 2. Explosive barrels and props

Server logic is in `packages/server/src/rooms/FpsArenaRoom.ts`.

- New constants: `BARREL_FUSE_SEC = 0.32`, `BARREL_BLAST_RADIUS = 7`, `BARREL_BLAST_DAMAGE = 130`.
- `damageDestructibleProp` now handles barrels differently from glass. A hit broadcasts the new `PROP_DAMAGED` message with `hpFraction`. At 0 HP the barrel starts a fuse instead of vanishing.
- `barrelFuses` is a map of blockId to timer and attacker. `stepBarrelFuses(dt)` runs every tick; on expiry `detonateBarrel` destroys the collider, broadcasts `PROP_DESTROYED`, and calls `applyRadialExplosion`.
- `applyRadialExplosion` now also calls `damageDestructiblesInRadius`, so every explosion (barrel or frag grenade) damages nearby props. Farther barrels cook off slightly later, which gives a visible chain reaction.
- Fuses are cleared on round reset.
- Shared protocol: `PROP_DAMAGED { blockId, material, position, hpFraction }` was added to `ServerToClientMessage` in `packages/shared/src/net/PacketCodec.ts`.
- Test: the existing barrel test in `server.test.ts` now expects `PROP_DAMAGED`, then steps the fuses before asserting `PROP_DESTROYED` and splash damage.

Client visuals (`packages/client/src/core/VfxSystem.ts`):

- `setBarrelDamage(blockId, position, hpFraction)` shows leaking smoke at first, flames below 60% health, and raging fire when the fuse is lit. `clearBarrelDamage` removes it (also called on destroy and on round reset).
- `spawnExplosionVfx(position, scale, groundY)` produces a white-hot flash sprite, fireball, rolling dark smoke, embers, an expanding shockwave dome and ground ring, flying debris with bounce, a fading scorch mark, and a light pulse. It uses one persistent pooled `PointLight`, because creating lights per blast forces shader recompiles.
- Camera shake distance and strength were increased for barrel and frag blasts.

## 3. Grenades and flashbang

- `GrenadeModels.ts` (new): `createGrenadeModel(scene, type, name)` builds a frag (ribbed olive body), flashbang (steel canister, yellow band), or smoke (grey canister) with neck, fuse head, spoon lever, pin, and ring. Materials are shared per scene, so dispose meshes with `dispose(false, false)`.
- Thrown grenades (`THROWABLE_SPAWNED` in `ShooterScene.ts`) now use the real model, tumble in flight, and emit a particle trail. `disposeGrenadeVisual` cleans up the mesh and trail.
- `ViewModelWeapon.ts` has a held-grenade rig with states `none`, `cook`, `throw`, `cancel`. The weapon lowers, a gloved hand holds the grenade, the pin and ring fly off, the hand trembles as the fuse burns down (`cookFraction`), and a wind-up and fling play on release. `notifyThrow()` is called from `releaseThrowGrenade` so a real throw is distinguished from a cancelled cook.
- Flashbang detonation now calls `vfx.spawnFlashbangVfx` (white sprite, ring, sparks, puff, light) as well as the sound.
- Screen white-out: `FLASHED` sets `flashHoldSec` (35% of the duration at full white) and `flashFadePerSec`, then fades. Previously it faded at a fixed rate from the start.
- The frag explosion now uses `spawnExplosionVfx` at scale 0.9, grounded at the grenade position.

## 4. Procedural weapons

- `ProceduralGuns.ts` (new): `buildProceduralGun` builds M416-style carbines, the AKM, the UMP-45, the Kriss Vector, the shotgun, a bolt-action fallback, and a pistol.
- Coordinate frame: +Z is the muzzle, the bore axis is y = 0, and the receiver is centred on z = 0. Static parts are merged per material to keep draw calls low (first-person view plus every remote soldier).
- It returns `railTop`, `muzzleZ`, magazine socket, eject and bolt positions, and the firing and support grip points. `WeaponAssembler.ts` uses these to place the optic, muzzle, underbarrel, and mag sockets and the hand grips. It also exposes `boltRestZ`, which `ViewModelWeapon` uses for the bolt-kick animation.
- Iron sights are only built when no optic is attached; the sight line is at y = 0.064.
- The bundled pistol glTF is an exploded parts sheet (slide, frame, and magazine float apart), so pistols now use the procedural build. The Kar98k and AWM still use the real sniper model.
- Gunsmith preview camera (`GunsmithPreviewScene.ts`): radius and target were changed so the longer guns are not cropped, and the pedestal was enlarged.

## 5. First-person hands and arms

`ViewModelWeapon.ts` was rewritten.

- Capsule-based gloved hands with a palm, knuckle plate, per-finger capsules, thumb, and a cuff with a strap. The firing hand wraps the pistol grip with the index finger by the trigger guard. The support hand cradles the handguard with fingers curling up the far side.
- The forearm is a tapered lathe. Elbows were moved closer and the long left upper-arm tube was removed.
- Hip position is `(0.2, -0.19, 0.5)`. Weapon lowering for grenades is driven by `grenadeLower`.
- Known limitation: the hands are still stylised primitives. The user rated them as looking robotic. Follow-up options are in the section 9.

## 6. Optic quick-swap

- Key: `V` (reserved in `FIXED_GAME_KEYS` so it cannot be rebound). `B` remains fire mode.
- Client: `cycleOptic()` in `ShooterScene.ts` cycles none, then every optic allowed for the weapon category (from `getAttachmentsForWeaponSlot`). It has a 350 ms cooldown, is disabled during reload, cooking, pause, and loadout, and is disabled in 2v2. The choice is saved to the guest profile when the held weapon matches the saved loadout.
- Protocol: new client message `SET_OPTIC { slot: 0 | 1; optic: string | null }`.
- Server: validates the optic against the weapon category, updates `player.loadout` and `pendingLoadout`, recomputes only that slot's effective stats, and broadcasts room state. Ammo is not touched. Test added in `server.test.ts`.
- Client sync: `syncEquippedWeapons` now keeps ammo when the weapon id and magazine attachment are unchanged, so a sight swap refreshes the model and stats without refilling the magazine.
- HUD: the weapon panel shows the current optic and `[V]`, and the control hint line includes `V Optic`. The lobby controls list was updated.

## 7. Smaller fixes

- Nametag HP is rounded (`ShooterHud.ts`); it used to show values like `78.83333HP`.
- `.killfeed-item` has a max width with ellipsis (`main.css`).
- A dev-only hook sets `window.__shooter` inside `warmUpAndStart` when `import.meta.env.DEV` is true. It is used by the browser verification scripts and is inactive in production builds.

## 8. Operational notes

- The game server runs from compiled output (`node --watch dist/index.js`, port 2569, set by `GAME_SERVER_PORT` in the client `.env`). After changing server or shared code, run `pnpm --filter @game/shared build` and `pnpm --filter @game/server build`; the watcher then restarts the server.
- Vite (port 5173) hot-reloads client changes.
- Headless verification uses `playwright-core` with Edge and SwiftShader, and runs at very low FPS, so animation timing in screenshots is only approximate.

## 9. Open items and agreed next steps

- **Hands realism (highest user priority):** replace the primitive hands with a rigged first-person arms model (a CC0 glTF if licensing allows) plus finger-bone poses for idle, reload, grenade, sprint, and swap, with procedural hands as the fallback. Fix grip wrapping and elbow and forearm length.
- **Auto-heal in every mode:** healing exists but is TDM-only. `allowsHealthRecovery()` in `FpsArenaRoom.ts` returns true only for TDM in warm-up and live round. The constants `TDM_HEAL_DELAY_SEC = 5` and `TDM_HEAL_HP_PER_SEC = 10` already match the requested behaviour (5 s after damage, then 10 HP per second). Make it apply to all modes in every fightable phase, rename the constants neutrally, and add a test. Open question: whether the competitive modes (1v1, 2v2, 4v4) should heal.
- **Not verified on a real GPU:** the additive fireball, the burning-barrel smoke and fire, grenade-to-barrel chains in a live match, and remote soldiers holding the new guns.
- **Possible follow-ups:** pool the per-shot impact particles like the burst systems; HUD redesign (ammo panel, damage indicators); the suggested feature list (hit feedback, directional damage, knife, weapon inspect, surface footsteps, spectate, killcam).

## Files touched

New: `packages/client/src/games/shooter/GrenadeModels.ts`, `packages/client/src/games/shooter/ProceduralGuns.ts`.

Changed: `packages/shared/src/net/PacketCodec.ts`, `packages/server/src/rooms/FpsArenaRoom.ts`, `packages/server/src/__tests__/server.test.ts`, `packages/client/src/core/VfxSystem.ts`, `packages/client/src/games/shooter/ShooterScene.ts`, `ViewModelWeapon.ts`, `WeaponAssembler.ts`, `GunsmithPreviewScene.ts`, `packages/client/src/ui/ShooterHud.ts`, `packages/client/src/ui/LobbyScreen.ts`, `packages/client/src/state/UserProfileStore.ts`, `packages/client/src/styles/main.css`.
