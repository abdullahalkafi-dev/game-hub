# 04 — Modular Registries for Weapons, Attachments, Skins, and Maps

The client and server share gameplay data in `packages/shared/src/registries/`. Use the live TypeScript definitions as the reference when adding content. Match rules and timers such as TDM recovery live in [gameRules.ts](../packages/shared/src/constants/gameRules.ts).

## Weapons and attachments

The weapon registry defines each weapon's category, damage by hit zone, armor penetration, pellet count, fire modes, magazine and reserve sizes, ADS timing and FOV, spread, recoil pattern, and maximum range. The gunsmith draws its choices from the registry. Categories distinguish primary weapons from pistols. [WeaponRegistry.ts](../packages/shared/src/registries/WeaponRegistry.ts)

The attachment registry defines compatible categories, slots, sockets, and stat modifiers. The shared stat calculator applies valid attachments for both gameplay and UI. [AttachmentRegistry.ts](../packages/shared/src/registries/AttachmentRegistry.ts) · [WeaponStatCalculator.ts](../packages/shared/src/systems/WeaponStatCalculator.ts)

| Slot | Socket | Examples |
| --- | --- | --- |
| `optic` | `socket_optic` | Red dot, 2x prism, 6x scope |
| `muzzle` | `socket_muzzle` | Suppressor, compensator |
| `underbarrel` | `socket_underbarrel` | Vertical and angled grips |
| `mag` | `socket_mag` | Extended quick magazine |

A loadout stores attachment IDs by slot.

~~~ts
const primary = {
  weaponId: "m416",
  skinId: "standard_issue",
  attachments: {
    optic: "optic_red_dot",
    muzzle: "muzzle_compensator",
  },
};
~~~

To add a weapon or attachment, follow an existing blueprint's required fields and update the compatible categories or slots. The weapon assembler creates the geometry and sets sight alignment. For imported assets, update the model cache and asset manifest as needed. Test the item in the gunsmith and in a match, checking ADS alignment and keeping the optic bore clear. [WeaponAssembler](../packages/client/src/games/shooter/WeaponAssembler.ts) · [ModelAssetCache](../packages/client/src/games/shooter/ModelAssetCache.ts) · [Asset manifest](../packages/client/public/assets/asset-manifest.json)

The client and server use a shared spread modifier. For a multi-pellet blueprint such as the M870, the server resolves a ray per pellet and groups the paths under one shot. [ShotSpread.ts](../packages/shared/src/systems/ShotSpread.ts)

## Skins and material zones

The skin registry defines display names, rarity, preview gradients, optional weapon restrictions, and material overrides. Universal skins apply across weapons. Use the primary, secondary, and accent zones for the body, exposed metal, and grip or trim. Overrides can set color, emissive properties, roughness, metallic response, and camo pattern. Review both the gunsmith and the first-person view when changing materials. [SkinRegistry.ts](../packages/shared/src/registries/SkinRegistry.ts)

## Throwables and TDM kits

The throwable registry defines frag, flashbang, and smoke fuses, throw speeds, restitution, radii, and effect durations. The server, projectile visuals, and initial throw preview use the same collision step. [ThrowableRegistry.ts](../packages/shared/src/registries/ThrowableRegistry.ts) · [PhysicsWorld](../packages/shared/src/physics/PhysicsWorld.ts)

The TDM loadout can specify a pair of distinct throwable IDs through `tdmThrowables`. If the pair is absent, the server uses the preferred throwable and a second type. Each available type starts with a count of one, and the server decrements its own count when a throw is accepted.

## Maps and spawn cover

The map registry defines each arena's floor, lighting, themed block geometry, team spawn locations, practice targets, bot waypoints, bomb site, and capture zone. The renderer and Rapier derive their map geometry from the same definitions. Material tags and geometry control surface effects and thin-cover penetration. [MapRegistry.ts](../packages/shared/src/registries/MapRegistry.ts)

When changing team spawns, keep routes out of spawn usable and check sightlines for both teams. TDM ranks each team's spawn candidates by occupancy, enemy visibility, and distance. Check practice targets for clear approaches and make sure crouch-height cover still works with the shared character controller.
