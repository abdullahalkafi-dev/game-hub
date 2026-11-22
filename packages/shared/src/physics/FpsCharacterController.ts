import type RAPIER from "@dimforge/rapier3d-compat";
import {
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_SLIDE,
  EYE_HEIGHT_STAND,
  GRAVITY,
  LEAN_OFFSET_MAX,
  PLAYER_RADIUS,
  SLIDE_COOLDOWN_SEC,
  SLIDE_DURATION_SEC,
  VAULT_DURATION_SEC,
} from "../constants/gameRules.js";
import { clamp, damp, lerp, type Vec3 } from "../math/ScratchMath.js";
import {
  INPUT_FLAG_ADS,
  INPUT_FLAG_BACK,
  INPUT_FLAG_CROUCH,
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_JUMP,
  INPUT_FLAG_LEAN_LEFT,
  INPUT_FLAG_LEAN_RIGHT,
  INPUT_FLAG_LEFT,
  INPUT_FLAG_RIGHT,
  INPUT_FLAG_SPRINT,
  type InputCommand,
} from "../net/InputCommand.js";
import { getRapierSync, type PhysicsWorld } from "./PhysicsWorld.js";

export type HitZone = "HEAD" | "CHEST" | "LIMB";

export interface FpsPlayerState {
  position: Vec3; // Feet position in world space
  velocity: Vec3;
  yaw: number;
  pitch: number;
  lean: number; // -1 (left) to +1 (right)
  crouching: boolean;
  crouchHeld: boolean;
  sliding: boolean;
  slideTimer: number;
  slideCooldown: number;
  slideDirX: number;
  slideDirZ: number;
  vaulting: boolean;
  vaultTimer: number;
  vaultStart: Vec3;
  vaultEnd: Vec3;
  grounded: boolean;
  eyeHeight: number;
}

export interface PlayerHitboxes {
  playerId: string;
  headCenter: Vec3;
  headRadius: number;
  chestMin: Vec3;
  chestMax: Vec3;
  limbMin: Vec3;
  limbMax: Vec3;
}

export interface PlayerRaycastHit {
  hitZone: HitZone;
  distance: number;
  point: Vec3;
}

export interface CharacterPhysicsHandle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
}

export function createInitialFpsState(spawn: Readonly<Vec3>, yaw = 0): FpsPlayerState {
  return {
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    lean: 0,
    crouching: false,
    crouchHeld: false,
    sliding: false,
    slideTimer: 0,
    slideCooldown: 0,
    slideDirX: 0,
    slideDirZ: 0,
    vaulting: false,
    vaultTimer: 0,
    vaultStart: { x: 0, y: 0, z: 0 },
    vaultEnd: { x: 0, y: 0, z: 0 },
    grounded: true,
    eyeHeight: EYE_HEIGHT_STAND,
  };
}

export function createCharacterPhysics(
  physWorld: PhysicsWorld,
  spawn: Readonly<Vec3>
): CharacterPhysicsHandle {
  const RapierApi = getRapierSync();
  const bodyDesc = RapierApi.RigidBodyDesc.kinematicPositionBased().setTranslation(
    spawn.x,
    spawn.y + 0.9,
    spawn.z
  );
  const body = physWorld.world.createRigidBody(bodyDesc);
  // Capsule half-height 0.54 + radius 0.36 = total height 1.8m; center at feet.y + 0.9m
  const colliderDesc = RapierApi.ColliderDesc.capsule(0.54, PLAYER_RADIUS);
  const collider = physWorld.world.createCollider(colliderDesc, body);
  physWorld.registerPlayerCollider(collider.handle);

  const controller = physWorld.world.createCharacterController(0.02);
  controller.enableAutostep(0.32, 0.25, false);
  controller.enableSnapToGround(0.25);
  controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  controller.setMinSlopeSlideAngle((55 * Math.PI) / 180);
  controller.setSlideEnabled(true);

  return { body, collider, controller };
}

export function destroyCharacterPhysics(
  physWorld: PhysicsWorld,
  handle: CharacterPhysicsHandle
): void {
  physWorld.unregisterPlayerCollider(handle.collider.handle);
  physWorld.world.removeCharacterController(handle.controller);
  physWorld.world.removeRigidBody(handle.body);
}

export function teleportCharacterPhysics(
  handle: CharacterPhysicsHandle,
  state: FpsPlayerState,
  spawn: Readonly<Vec3>,
  yaw: number
): void {
  restoreCharacterPhysics(handle, state, createInitialFpsState(spawn, yaw));
}

export function restoreCharacterPhysics(
  handle: CharacterPhysicsHandle,
  state: FpsPlayerState,
  snapshot: Readonly<FpsPlayerState>
): void {
  Object.assign(state, snapshot, {
    position: { ...snapshot.position },
    velocity: { ...snapshot.velocity },
    vaultStart: { ...snapshot.vaultStart },
    vaultEnd: { ...snapshot.vaultEnd },
  });
  const centerHeight = setCharacterStance(handle, state.crouching || state.sliding);
  const { x, y, z } = state.position;
  handle.body.setTranslation({ x, y: y + centerHeight, z }, true);
}

function setCharacterStance(handle: CharacterPhysicsHandle, crouching: boolean): number {
  const halfHeight = crouching ? 0.31 : 0.54;
  if (Math.abs(handle.collider.halfHeight() - halfHeight) > 0.001) {
    handle.collider.setHalfHeight(halfHeight);
    const { x, y, z } = handle.body.translation();
    const previousHeight = crouching ? 0.54 : 0.31;
    handle.body.setTranslation({ x, y: y + halfHeight - previousHeight, z }, true);
  }
  return halfHeight + PLAYER_RADIUS;
}

/**
 * Deterministic 60Hz FPS movement step:
 * - Walk / Sprint / Crouch
 * - Sprint-to-Slide (Shift + C with 1.5s cooldown)
 * - Smart Auto-Vault / Mantle over waist-high obstacles (Space)
 * - Q / E Tactical Lean & Peek interpolation
 */
export function stepFpsCharacter(
  physWorld: PhysicsWorld,
  handle: CharacterPhysicsHandle,
  state: FpsPlayerState,
  input: Readonly<InputCommand>,
  moveSpeedMult: number,
  dt: number,
  canMove = true
): void {
  state.yaw = input.yaw;
  state.pitch = clamp(input.pitch, -1.52, 1.52);
  const wantsCrouch = (input.flags & INPUT_FLAG_CROUCH) !== 0;
  const crouchPressed = wantsCrouch && !state.crouchHeld;
  state.crouchHeld = wantsCrouch;
  const blocksMovement = physWorld.isWorldCollider;

  // Q/E Tactical Lean interpolation
  const leanInput =
    ((input.flags & INPUT_FLAG_LEAN_RIGHT) !== 0 ? 1 : 0) -
    ((input.flags & INPUT_FLAG_LEAN_LEFT) !== 0 ? 1 : 0);
  state.lean = damp(state.lean, canMove ? leanInput : 0, 14, dt);

  if (state.slideCooldown > 0) {
    state.slideCooldown = Math.max(0, state.slideCooldown - dt);
  }

  if (!canMove) {
    state.velocity.x = 0;
    state.velocity.z = 0;
    const targetEye = state.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
    state.eyeHeight = damp(state.eyeHeight, targetEye, 16, dt);
    return;
  }

  // Ongoing Auto-Vault interpolation
  if (state.vaulting) {
    state.vaultTimer += dt;
    const t = clamp(state.vaultTimer / VAULT_DURATION_SEC, 0, 1);
    const forward = clamp((t - 0.35) / 0.53, 0, 1);
    const lift = Math.min(t / 0.35, 1);
    const settle = clamp((t - 0.88) / 0.12, 0, 1);
    const feet = {
      x: lerp(state.vaultStart.x, state.vaultEnd.x, forward),
      y: lerp(state.vaultStart.y, state.vaultEnd.y + 0.12, lift) - settle * 0.10,
      z: lerp(state.vaultStart.z, state.vaultEnd.z, forward),
    };
    const centerHeight = setCharacterStance(handle, false);
    const from = handle.body.translation();
    const delta = { x: feet.x - from.x, y: feet.y + centerHeight - from.y, z: feet.z - from.z };
    const world = physWorld.world;
    world.updateSceneQueries();
    const blocked = world.castShape(from, { x: 0, y: 0, z: 0, w: 1 }, delta,
      handle.collider.shape, 0, 1, false, undefined, undefined, handle.collider, undefined, blocksMovement);
    if (blocked) {
      state.vaulting = false;
      state.grounded = false;
      return;
    }
    state.position = feet;
    handle.body.setTranslation({ x: feet.x, y: feet.y + centerHeight, z: feet.z }, true);
    state.eyeHeight = damp(state.eyeHeight, EYE_HEIGHT_STAND, 14, dt);
    if (t >= 1) {
      state.vaulting = false;
      state.grounded = true;
      state.velocity.y = 0;
    }
    return;
  }

  // Forward & right horizontal basis vectors in XZ plane
  const fwdX = Math.sin(state.yaw);
  const fwdZ = Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);

  const moveFwd =
    ((input.flags & INPUT_FLAG_FORWARD) !== 0 ? 1 : 0) -
    ((input.flags & INPUT_FLAG_BACK) !== 0 ? 1 : 0);
  const moveRight =
    ((input.flags & INPUT_FLAG_RIGHT) !== 0 ? 1 : 0) -
    ((input.flags & INPUT_FLAG_LEFT) !== 0 ? 1 : 0);

  let wishX = fwdX * moveFwd + rightX * moveRight;
  let wishZ = fwdZ * moveFwd + rightZ * moveRight;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1e-5) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  const wantsSprint = (input.flags & INPUT_FLAG_SPRINT) !== 0 && moveFwd > 0;
  const wantsAds = (input.flags & INPUT_FLAG_ADS) !== 0;

  // Trigger Sprint-to-Slide (Shift + C while moving forward on ground)
  if (
    !state.sliding &&
    wantsSprint &&
    crouchPressed &&
    state.grounded &&
    state.slideCooldown <= 0 &&
    wishLen > 0.1
  ) {
    state.sliding = true;
    state.slideTimer = SLIDE_DURATION_SEC;
    state.slideCooldown = SLIDE_COOLDOWN_SEC;
    state.slideDirX = wishX;
    state.slideDirZ = wishZ;
  }

  if (state.sliding) {
    state.slideTimer -= dt;
    const progress = clamp(state.slideTimer / SLIDE_DURATION_SEC, 0, 1);
    const slideSpeed = (8.8 * progress + 3.2) * moveSpeedMult;
    state.velocity.x = state.slideDirX * slideSpeed;
    state.velocity.z = state.slideDirZ * slideSpeed;
    state.crouching = true;
    if (state.slideTimer <= 0) {
      state.sliding = false;
    }
  } else {
    let canStand = true;
    if (state.crouching && !wantsCrouch) {
      const { x, y, z } = state.position;
      physWorld.world.updateSceneQueries();
      canStand = !physWorld.world.castShape(
        { x, y: y + PLAYER_RADIUS + 0.62, z }, { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0.46, z: 0 }, new (getRapierSync().Ball)(PLAYER_RADIUS - 0.01),
        0, 1, true, undefined, undefined, handle.collider, undefined, blocksMovement
      );
    }
    state.crouching = wantsCrouch || !canStand;
    let speed = 5.4 * moveSpeedMult;
    if (state.crouching) {
      speed = 3.15 * moveSpeedMult;
    } else if (wantsAds) {
      speed = 3.8 * moveSpeedMult;
    } else if (wantsSprint) {
      speed = 7.45 * moveSpeedMult;
    }
    const targetVx = wishX * speed;
    const targetVz = wishZ * speed;
    const accel = state.grounded ? (wishLen < 0.05 ? 26 : 18) : 6;
    state.velocity.x = damp(state.velocity.x, targetVx, accel, dt);
    state.velocity.z = damp(state.velocity.z, targetVz, accel, dt);
  }

  // Smart Auto-Vault / Mantle check on Jump near waist-high cover
  const wantsJump = (input.flags & INPUT_FLAG_JUMP) !== 0;
  if (wantsJump && state.grounded && !state.sliding && !state.crouching) {
    const vaultEnd = tryDetectVaultLedge(physWorld, handle.collider, state.position, fwdX, fwdZ);
    if (vaultEnd) {
      state.vaulting = true;
      state.vaultTimer = 0;
      state.vaultStart = { ...state.position };
      state.vaultEnd = vaultEnd;
      state.crouching = false;
      return;
    }
    state.velocity.y = 7.8;
    state.grounded = false;
  }

  if (!state.grounded) {
    state.velocity.y += GRAVITY * dt;
  }

  // Smooth eye height transition
  const targetEye = state.sliding
    ? EYE_HEIGHT_SLIDE
    : state.crouching
      ? EYE_HEIGHT_CROUCH
      : EYE_HEIGHT_STAND;
  state.eyeHeight = damp(state.eyeHeight, targetEye, 15, dt);

  const desiredDelta = {
    x: state.velocity.x * dt,
    // Rapier's ground snap needs downward motion to keep contact on level and descending surfaces.
    y: (state.grounded ? -0.6 : state.velocity.y) * dt,
    z: state.velocity.z * dt,
  };

  const centerHeight = setCharacterStance(handle, state.crouching || state.sliding);
  physWorld.world.propagateModifiedBodyPositionsToColliders();
  physWorld.world.updateSceneQueries();
  handle.controller.computeColliderMovement(handle.collider, desiredDelta, undefined, undefined, blocksMovement);
  const corrected = handle.controller.computedMovement();
  state.grounded = state.velocity.y <= 0 && handle.controller.computedGrounded();
  if (state.grounded) state.velocity.y = 0;

  const currTrans = handle.body.translation();
  const nextX = currTrans.x + corrected.x;
  const nextY = currTrans.y + corrected.y;
  const nextZ = currTrans.z + corrected.z;
  handle.body.setTranslation({ x: nextX, y: nextY, z: nextZ }, true);

  state.position.x = nextX;
  state.position.y = nextY - centerHeight;
  state.position.z = nextZ;
}

function tryDetectVaultLedge(
  physWorld: PhysicsWorld,
  playerCollider: RAPIER.Collider,
  feet: Readonly<Vec3>,
  fwdX: number,
  fwdZ: number
): Vec3 | null {
  const RapierApi = getRapierSync();
  physWorld.world.updateSceneQueries();

  const lowOrigin = { x: feet.x, y: feet.y + 0.45, z: feet.z };
  const dir = { x: fwdX, y: 0, z: fwdZ };
  const lowHit = physWorld.world.castRay(
    new RapierApi.Ray(lowOrigin, dir),
    1.05,
    true,
    undefined,
    undefined,
    playerCollider,
    undefined,
    physWorld.isWorldCollider
  );
  if (!lowHit) return null;

  // Ensure upper clearance at chest/head height
  const highOrigin = { x: feet.x, y: feet.y + 1.5, z: feet.z };
  const highHit = physWorld.world.castRay(
    new RapierApi.Ray(highOrigin, dir),
    1.15,
    true,
    undefined,
    undefined,
    playerCollider,
    undefined,
    physWorld.isWorldCollider
  );
  if (highHit) return null;

  // Cast down past the obstacle face to find top surface height
  const probeDist = Math.max(0.7, lowHit.timeOfImpact + 0.48);
  const downOrigin = {
    x: feet.x + fwdX * probeDist,
    y: feet.y + 1.55,
    z: feet.z + fwdZ * probeDist,
  };
  const downHit = physWorld.world.castRay(
    new RapierApi.Ray(downOrigin, { x: 0, y: -1, z: 0 }),
    1.25,
    true,
    undefined,
    undefined,
    playerCollider,
    undefined,
    physWorld.isWorldCollider
  );
  if (!downHit) return null;

  const ledgeY = downOrigin.y - downHit.timeOfImpact;
  const heightGain = ledgeY - feet.y;
  if (heightGain < 0.4 || heightGain > 1.38) return null;

  return {
    x: feet.x + fwdX * probeDist,
    y: ledgeY,
    z: feet.z + fwdZ * probeDist,
  };
}

/**
 * Computes exact camera eye position in world space including Q/E lean lateral shift.
 */
export function getCameraEyePosition(state: Readonly<FpsPlayerState>, out?: Vec3): Vec3 {
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);
  const leanShift = state.lean * LEAN_OFFSET_MAX;
  const drop = Math.abs(state.lean) * 0.04;
  const res = out ?? { x: 0, y: 0, z: 0 };
  res.x = state.position.x + rightX * leanShift;
  res.y = state.position.y + state.eyeHeight - drop;
  res.z = state.position.z + rightZ * leanShift;
  return res;
}

/**
 * Generates analytical 3-zone hitboxes (HEAD, CHEST, LIMBS) matching player stance & lean.
 */
export function computePlayerHitboxes(
  playerId: string,
  state: Readonly<FpsPlayerState>
): PlayerHitboxes {
  const rightX = Math.cos(state.yaw);
  const rightZ = -Math.sin(state.yaw);
  const leanShift = state.lean * LEAN_OFFSET_MAX;
  const crouchDrop = state.sliding ? 0.68 : state.crouching ? 0.52 : 0;

  const headY = state.position.y + 1.62 - crouchDrop;
  const chestCenterY = state.position.y + 1.12 - crouchDrop * 0.72;
  const limbHeight = state.crouching ? 0.55 : 0.78;

  return {
    playerId,
    headCenter: {
      x: state.position.x + rightX * leanShift,
      y: headY,
      z: state.position.z + rightZ * leanShift,
    },
    headRadius: 0.22,
    chestMin: {
      x: state.position.x + rightX * (leanShift * 0.65) - 0.33,
      y: chestCenterY - 0.34,
      z: state.position.z + rightZ * (leanShift * 0.65) - 0.33,
    },
    chestMax: {
      x: state.position.x + rightX * (leanShift * 0.65) + 0.33,
      y: chestCenterY + 0.34,
      z: state.position.z + rightZ * (leanShift * 0.65) + 0.33,
    },
    limbMin: {
      x: state.position.x - 0.29,
      y: state.position.y,
      z: state.position.z - 0.29,
    },
    limbMax: {
      x: state.position.x + 0.29,
      y: state.position.y + limbHeight,
      z: state.position.z + 0.29,
    },
  };
}

function raySphereIntersect(
  origin: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  center: Readonly<Vec3>,
  radius: number
): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const t = -b - sqrtD;
  if (t >= 0) return t;
  const t2 = -b + sqrtD;
  return t2 >= 0 ? t2 : null;
}

function rayAabbIntersect(
  origin: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  min: Readonly<Vec3>,
  max: Readonly<Vec3>
): number | null {
  let tmin = 0;
  let tmax = Infinity;

  const axes: ["x", "y", "z"] = ["x", "y", "z"];
  for (let i = 0; i < 3; i++) {
    const k = axes[i];
    const d = dir[k];
    const o = origin[k];
    if (Math.abs(d) < 1e-8) {
      if (o < min[k] || o > max[k]) return null;
    } else {
      const inv = 1 / d;
      let t1 = (min[k] - o) * inv;
      let t2 = (max[k] - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : null;
}

/**
 * Tests a ray against a player's 3-zone hitboxes and returns the closest hit zone.
 */
export function intersectRayHitboxes(
  origin: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  maxDist: number,
  hb: Readonly<PlayerHitboxes>
): PlayerRaycastHit | null {
  let bestDist = maxDist;
  let bestZone: HitZone | null = null;

  const headT = raySphereIntersect(origin, dir, hb.headCenter, hb.headRadius);
  if (headT !== null && headT < bestDist) {
    bestDist = headT;
    bestZone = "HEAD";
  }

  const chestT = rayAabbIntersect(origin, dir, hb.chestMin, hb.chestMax);
  if (chestT !== null && chestT < bestDist) {
    bestDist = chestT;
    bestZone = "CHEST";
  }

  const limbT = rayAabbIntersect(origin, dir, hb.limbMin, hb.limbMax);
  if (limbT !== null && limbT < bestDist) {
    bestDist = limbT;
    bestZone = "LIMB";
  }

  if (!bestZone) return null;
  return {
    hitZone: bestZone,
    distance: bestDist,
    point: {
      x: origin.x + dir.x * bestDist,
      y: origin.y + dir.y * bestDist,
      z: origin.z + dir.z * bestDist,
    },
  };
}
