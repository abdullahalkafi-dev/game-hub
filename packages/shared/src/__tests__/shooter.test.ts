import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIST,
  FIXED_DT,
  INPUT_FLAG_CROUCH,
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_JUMP,
  INPUT_FLAG_LEAN_LEFT,
  INPUT_FLAG_LEAN_RIGHT,
  INPUT_FLAG_SPRINT,
  MAP_LIST,
  MAP_REGISTRY,
  ObjectPool,
  PLAYER_BINARY_STRIDE,
  PhysicsWorld,
  RingBuffer,
  SKIN_LIST,
  skinsForWeapon,
  THROWABLE_LIST,
  WEAPON_LIST,
  WEAPON_REGISTRY,
  computeEffectiveWeaponStats,
  computePlayerHitboxes,
  createCharacterPhysics,
  createEmptyInputCommand,
  createInitialFpsState,
  decodeWorldSnapshotBinary,
  destroyCharacterPhysics,
  encodeWorldSnapshotBinary,
  initRapier,
  intersectRayHitboxes,
  sampleShotCone,
  shotSpreadMultiplier,
  stepFpsCharacter,
} from "../index.js";

describe("Modular Registries & Weapon Stat Calculator", () => {
  it("uses the same movement spread multiplier in aim space for all directions", () => {
    expect(shotSpreadMultiplier({ crouching: false, grounded: true, speed: 5.4 })).toBe(1.5);
    expect(shotSpreadMultiplier({ crouching: true, grounded: true, speed: 0 })).toBe(0.7);
    const angle = 0.1;
    for (const forward of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }]) {
      const direction = sampleShotCone(forward, angle, 1, 0.37);
      expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 6);
      const dot = direction.x * forward.x + direction.y * forward.y + direction.z * forward.z;
      expect(Math.acos(dot)).toBeCloseTo(angle, 6);
    }
  });
  it("contains 8 weapons, 8 attachments, the base and progression skins, 3 throwables, and 3 maps", () => {
    expect(WEAPON_LIST).toHaveLength(8);
    expect(ATTACHMENT_LIST).toHaveLength(8);
    expect(SKIN_LIST).toHaveLength(11);
    expect(SKIN_LIST.filter((skin) => skin.unlockLevel).map((skin) => skin.unlockLevel)).toEqual([2, 4]);
    expect(THROWABLE_LIST).toHaveLength(3);
    expect(MAP_LIST).toHaveLength(3);
    expect(PLAYER_BINARY_STRIDE).toBeLessThan(28);
  });

  it("offers model skins only on the weapon they were made for", () => {
    const modelSkins = SKIN_LIST.filter((skin) => skin.model);
    expect(modelSkins.length).toBeGreaterThan(0);
    for (const skin of modelSkins) {
      expect(skin.targetWeaponId).toBeDefined();
      expect(skin.model!.url).toMatch(/^\/assets\/models\/weapons\/[a-z0-9_]+\.glb$/);
      expect(skinsForWeapon(skin.targetWeaponId!).map((s) => s.id)).toContain(skin.id);
      expect(skinsForWeapon("akm").map((s) => s.id)).not.toContain(skin.id);
    }
    expect(skinsForWeapon("akm").length).toBe(SKIN_LIST.filter((skin) => !skin.targetWeaponId).length);
  });

  it("computes effective weapon stats from socket attachments without mutating base blueprints", () => {
    const baseMag = WEAPON_REGISTRY.m416.stats.magSize;
    const baseRecoil = WEAPON_REGISTRY.m416.recoilPattern.vertical;

    const eff = computeEffectiveWeaponStats("m416", {
      optic: "optic_2x_acog",
      muzzle: "muzzle_suppressor",
      underbarrel: "grip_vertical",
      mag: "mag_extended_quick",
    });

    expect(eff.adsFov).toBe(34);
    expect(eff.hideMuzzleFlash).toBe(true);
    expect(eff.useSuppressedAudio).toBe(true);
    expect(eff.recoilVertical).toBeCloseTo(baseRecoil * 0.9 * 0.8, 3);
    expect(eff.magSize).toBe(Math.round(baseMag * 1.35));
    expect(eff.reloadTacticalSec).toBeLessThan(WEAPON_REGISTRY.m416.stats.reloadTimeSec.tactical);

    // Base blueprint remains untouched
    expect(WEAPON_REGISTRY.m416.stats.magSize).toBe(baseMag);
    expect(WEAPON_REGISTRY.m416.recoilPattern.vertical).toBe(baseRecoil);
  });
});

describe("Zero-GC Pools, RingBuffer & Binary PacketCodec", () => {
  it("recycles pooled objects without exceeding fixed capacity", () => {
    const pool = new ObjectPool(3, (i) => ({ id: i, val: 0 }));
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    const d = pool.acquire();

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(d).toBeNull();
    expect(pool.activeCount).toBe(3);

    pool.release(b!);
    expect(pool.activeCount).toBe(2);
    expect(pool.acquire()).toBe(b);
  });

  it("maintains ordered circular history in RingBuffer", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(10);
    rb.push(20);
    rb.push(30);
    rb.push(40);
    expect(rb.toArray()).toEqual([20, 30, 40]);
    expect(rb.getLatest()).toBe(40);
  });

  it("round-trips binary player snapshots under 28 bytes per player", () => {
    const buf = encodeWorldSnapshotBinary(12345.5, [
      {
        playerIndex: 7,
        x: 12.25,
        y: 2.5,
        z: -8.75,
        yaw: 1.25,
        pitch: -0.35,
        lean: -0.8,
        crouching: true,
        sliding: false,
        alive: true,
        ads: true,
        isBot: false,
        vaulting: false,
        activeSlot: 1,
        hp: 84,
        armor: 22,
        vx: 3.2,
        vz: -1.4,
      },
    ]);

    expect(buf.byteLength).toBe(12 + PLAYER_BINARY_STRIDE);
    const decoded = decodeWorldSnapshotBinary(buf);
    expect(decoded.serverTimeMs).toBe(12345.5);
    expect(decoded.players).toHaveLength(1);
    const p = decoded.players[0];
    expect(p.playerIndex).toBe(7);
    expect(p.x).toBeCloseTo(12.25, 2);
    expect(p.lean).toBeCloseTo(-0.8, 1);
    expect(p.crouching).toBe(true);
    expect(p.ads).toBe(true);
    expect(p.activeSlot).toBe(1);
    expect(p.hp).toBe(84);
    expect(p.armor).toBe(22);
  });
});

describe("Rapier3D PhysicsWorld & Tactical FpsCharacterController", () => {
  it("keeps contact on flat ground at idle and while walking, and lands once after a jump", async () => {
    await initRapier();
    const world = new PhysicsWorld(MAP_REGISTRY.cargo_docks);
    try {
      const state = createInitialFpsState({ x: 15.1, y: 0, z: -26 });
      const handle = createCharacterPhysics(world, state.position);
      const command = createEmptyInputCommand();
      for (let i = 0; i < 180; i++) {
        command.flags = i < 90 ? 0 : INPUT_FLAG_FORWARD;
        stepFpsCharacter(world, handle, state, command, 1, FIXED_DT);
        expect(state.grounded).toBe(true);
      }

      command.flags = INPUT_FLAG_JUMP;
      stepFpsCharacter(world, handle, state, command, 1, FIXED_DT);
      expect(state.grounded).toBe(false);
      command.flags = 0;
      let landings = 0;
      for (let i = 0; i < 120; i++) {
        const wasGrounded = state.grounded;
        stepFpsCharacter(world, handle, state, command, 1, FIXED_DT);
        if (!wasGrounded && state.grounded) landings++;
      }
      expect(landings).toBe(1);
    } finally {
      world.dispose();
    }
  });

  it.each(MAP_LIST)("blocks spawn-to-spawn sightlines but leaves exits and low cover on $name", async (map) => {
    await initRapier();
    const world = new PhysicsWorld(map);
    try {
      for (const a of map.spawnsA) {
        for (const b of map.spawnsB) {
          const eyeA = { ...a.position, y: a.position.y + 1.62 };
          const eyeB = { ...b.position, y: b.position.y + 1.62 };
          expect(world.hasLineOfSight(eyeA, eyeB)).toBe(false);
          const distance = Math.hypot(eyeB.x - eyeA.x, eyeB.z - eyeA.z);
          const shot = world.castBallisticWorldRay(eyeA,
            { x: (eyeB.x - eyeA.x) / distance, y: 0, z: (eyeB.z - eyeA.z) / distance }, distance, 1);
          expect(shot.primaryHit?.blockId).toMatch(/^spawn_screen_/);
          expect(shot.penetrationHit).toBeNull();
        }
      }

      const screenZ = map.spawnScreenZ!;
      for (const side of [-1, 1]) {
        for (const x of [-15.1, 0, 15.1]) {
          expect(world.hasLineOfSight({ x, y: 1.62, z: side * (screenZ + 1) },
            { x, y: 1.62, z: side * (screenZ - 1.1) })).toBe(true);
        }
        const behind = { x: 0, y: 1.05, z: side * (screenZ - 1.5) };
        const ahead = { x: 0, y: 1.62, z: side * (screenZ - 4.7) };
        expect(world.hasLineOfSight(behind, ahead)).toBe(false);
        expect(world.hasLineOfSight({ ...behind, y: 1.62 }, ahead)).toBe(true);
      }
    } finally {
      world.dispose();
    }
  });

  it("detects the same vault surface with another player present on the server", async () => {
    await initRapier();
    const map = MAP_REGISTRY.cargo_docks;
    const localWorld = new PhysicsWorld(map);
    const serverWorld = new PhysicsWorld(map);
    try {
      const spawn = { x: 0, y: 0, z: -7.35 };
      const local = createInitialFpsState(spawn, 0);
      const server = createInitialFpsState(spawn, 0);
      const localHandle = createCharacterPhysics(localWorld, spawn);
      const serverHandle = createCharacterPhysics(serverWorld, spawn);
      createCharacterPhysics(serverWorld, { x: 0, y: 1.04, z: -6.5 });
      const input = { ...createEmptyInputCommand(1), flags: INPUT_FLAG_FORWARD | INPUT_FLAG_JUMP };

      stepFpsCharacter(localWorld, localHandle, local, input, 1, FIXED_DT);
      stepFpsCharacter(serverWorld, serverHandle, server, input, 1, FIXED_DT);

      expect(local.vaulting).toBe(true);
      expect(server.vaulting).toBe(true);
      expect(server.vaultEnd).toEqual(local.vaultEnd);
    } finally {
      localWorld.dispose();
      serverWorld.dispose();
    }
  });

  it("supports sprint-slide, auto-vaulting over waist-high cover, and Q/E lean hitboxes", async () => {
    await initRapier();
    const map = MAP_REGISTRY.cargo_docks;
    const world = new PhysicsWorld(map);

    // Spawn facing +Z directly in front of waist-high barrier vault_mid_s (z = -6.5, height 1.04)
    const state = createInitialFpsState({ x: 0, y: 0, z: -8.0 }, 0);
    const handle = createCharacterPhysics(world, state.position);

    // Sprint forward & trigger Shift+C slide
    const slideInput = createEmptyInputCommand(1);
    slideInput.flags = INPUT_FLAG_FORWARD | INPUT_FLAG_SPRINT | INPUT_FLAG_CROUCH;
    stepFpsCharacter(world, handle, state, slideInput, 1.0, FIXED_DT, true);
    expect(state.sliding).toBe(true);
    expect(state.slideCooldown).toBeGreaterThan(1.0);

    // Clear slide for vault test right near vault_mid_s (z = -7.35, barrier z = -6.5)
    state.sliding = false;
    state.crouching = false;
    state.position = { x: 0, y: 0, z: -7.35 };
    handle.body.setTranslation({ x: 0, y: 0.9, z: -7.35 }, true);

    const jumpInput = createEmptyInputCommand(2);
    jumpInput.flags = INPUT_FLAG_FORWARD | INPUT_FLAG_JUMP;
    stepFpsCharacter(world, handle, state, jumpInput, 1.0, FIXED_DT, true);
    expect(state.vaulting).toBe(true);

    // Step through vault duration
    for (let i = 0; i < 30; i++) {
      stepFpsCharacter(world, handle, state, createEmptyInputCommand(i + 3), 1.0, FIXED_DT, true);
    }
    expect(state.vaulting).toBe(false);
    expect(state.position.y).toBeGreaterThan(0.8);

    // Q/E Tactical Lean shifts head hitbox laterally
    const leanState = createInitialFpsState({ x: 0, y: 0, z: 0 }, 0);
    const leanHandle = createCharacterPhysics(world, leanState.position);
    const hbCenter = computePlayerHitboxes("p1", leanState);

    const leanRightInput = createEmptyInputCommand(10);
    leanRightInput.flags = INPUT_FLAG_LEAN_RIGHT;
    for (let i = 0; i < 30; i++) {
      stepFpsCharacter(world, leanHandle, leanState, leanRightInput, 1.0, FIXED_DT, true);
    }
    const hbRight = computePlayerHitboxes("p1", leanState);
    expect(hbRight.headCenter.x).toBeGreaterThan(hbCenter.headCenter.x + 0.25);

    const leanLeftInput = createEmptyInputCommand(11);
    leanLeftInput.flags = INPUT_FLAG_LEAN_LEFT;
    for (let i = 0; i < 60; i++) {
      stepFpsCharacter(world, leanHandle, leanState, leanLeftInput, 1.0, FIXED_DT, true);
    }
    const hbLeft = computePlayerHitboxes("p1", leanState);
    expect(hbLeft.headCenter.x).toBeLessThan(hbCenter.headCenter.x - 0.25);

    // 3-zone hitbox intersection checks HEAD, CHEST, LIMB accurately
    const headRayHit = intersectRayHitboxes(
      { x: hbLeft.headCenter.x, y: hbLeft.headCenter.y, z: -5 },
      { x: 0, y: 0, z: 1 },
      20,
      hbLeft
    );
    expect(headRayHit?.hitZone).toBe("HEAD");

    const limbRayHit = intersectRayHitboxes(
      { x: 0, y: 0.35, z: -5 },
      { x: 0, y: 0, z: 1 },
      20,
      hbLeft
    );
    expect(limbRayHit?.hitZone).toBe("LIMB");

    destroyCharacterPhysics(world, handle);
    destroyCharacterPhysics(world, leanHandle);
    world.dispose();
  });

  it("performs thin-cover wallbang penetration, destructible cleanup, and smoke LOS blocking", async () => {
    await initRapier();
    const world = new PhysicsWorld(MAP_REGISTRY.cargo_docks);

    // crate_wb_1 is at (-1.8, 0.85, 0) with thickness 0.25m (WOOD_THIN)
    // Behind it is wall_n at z = 32
    const cast = world.castBallisticWorldRay(
      { x: -1.8, y: 0.9, z: -4 },
      { x: 0, y: 0, z: 1 },
      80,
      0.7
    );
    expect(cast.primaryHit?.material).toBe("WOOD_THIN");
    expect(cast.penetrationHit).not.toBeNull();
    expect(cast.penetrationHit?.isWallbang).toBe(true);
    expect(cast.penetrationHit?.damageMultiplier).toBeLessThan(0.65);

    // Smoke cloud blocks line-of-sight
    const clearLos = world.hasLineOfSight({ x: 0, y: 1.5, z: -4 }, { x: 0, y: 1.5, z: 4 }, []);
    expect(clearLos).toBe(true);
    const smokedLos = world.hasLineOfSight(
      { x: 0, y: 1.5, z: -4 },
      { x: 0, y: 1.5, z: 4 },
      [{ position: { x: 0, y: 1.5, z: 0 }, radius: 4.5 }]
    );
    expect(smokedLos).toBe(false);

    // Destructible barrel removal and round reset
    expect(world.getBlockById("barrel_1")).toBeDefined();
    world.destroyBlock("barrel_1");
    expect(world.getBlockById("barrel_1")).toBeUndefined();
    world.resetDestructibles();
    expect(world.getBlockById("barrel_1")).toBeDefined();

    world.dispose();
  });
});
