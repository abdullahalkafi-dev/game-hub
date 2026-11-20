import {
  INPUT_FLAG_ADS,
  INPUT_FLAG_BACK,
  INPUT_FLAG_CROUCH,
  INPUT_FLAG_FIRE,
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_LEAN_LEFT,
  INPUT_FLAG_LEAN_RIGHT,
  INPUT_FLAG_LEFT,
  INPUT_FLAG_RIGHT,
  INPUT_FLAG_SPRINT,
  clamp,
  getCameraEyePosition,
  getRapierSync,
  yawPitchToDir,
  type BotDifficulty,
  type FpsPlayerState,
  type InputCommand,
  type MapBlueprint,
  type PhysicsWorld,
  type SmokeCloudVolume,
  type TeamId,
  type Vec3,
} from "@game/shared";

const BOT_SKILL = {
  EASY: { range: 34, halfFov: 50, reaction: 1.0, turn: 2.1, aimTolerance: 0.13, yawSpread: 0.15, pitchSpread: 0.07, burst: 0.18, pause: 1.05 },
  NORMAL: { range: 50, halfFov: 59, reaction: 0.40, turn: 3.8, aimTolerance: 0.10, yawSpread: 0.059, pitchSpread: 0.037, burst: 0.32, pause: 0.50 },
  PRO: { range: 65, halfFov: 71, reaction: 0.18, turn: 6.3, aimTolerance: 0.065, yawSpread: 0.025, pitchSpread: 0.018, burst: 0.43, pause: 0.27 },
} satisfies Record<BotDifficulty, Record<string, number>>;

function angleDifference(target: number, current: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

function getSpawnExitTarget(map: MapBlueprint, position: Vec3): Vec3 | null {
  const screenZ = map.spawnScreenZ;
  const depth = Math.abs(position.z);
  if (screenZ === undefined || depth < screenZ - 3.25) return null;

  const end = Math.sign(position.z);
  const side = position.x < 0 ? -1 : 1;
  // Turn between the tall screen and the low cover, rather than aiming through either.
  const outerExit = Math.abs(position.x) > 9.5;
  const crossingScreen = depth > screenZ - 0.85;
  const laneX = outerExit ? side * 15.1 : crossingScreen ? 0 : side * 2.7;
  const laneDistance = Math.abs(position.x - laneX);
  return {
    x: laneX,
    y: position.y,
    z: laneDistance > 0.65
      ? position.z
      : end * (crossingScreen && !outerExit ? screenZ - 1.45 : screenZ - 4),
  };
}

export interface BotTargetCandidate {
  id: string;
  team: TeamId;
  alive: boolean;
  state: FpsPlayerState;
  hp: number;
}

export interface BotAiMemory {
  waypointIndex: number;
  decisionTimer: number;
  strafeSign: -1 | 0 | 1;
  leanSign: -1 | 0 | 1;
  burstTimer: number;
  fireCooldown: number;
  reactionTimer: number;
  lastSeenEnemyId: string | null;
  avoidTurnBias: number;
  stuckTimer: number;
  lastX: number;
  lastZ: number;
}

export function createBotMemory(seedIndex: number): BotAiMemory {
  return {
    waypointIndex: seedIndex,
    decisionTimer: 0.4 + (seedIndex % 3) * 0.25,
    strafeSign: seedIndex % 2 === 0 ? 1 : -1,
    leanSign: 0,
    burstTimer: 0,
    fireCooldown: 0,
    reactionTimer: 0.32,
    lastSeenEnemyId: null,
    avoidTurnBias: 0,
    stuckTimer: 0,
    lastX: 0,
    lastZ: 0,
  };
}

function castNavigationWhisker(
  physWorld: PhysicsWorld,
  origin: Readonly<Vec3>,
  yaw: number,
  angleOffset: number,
  dist: number
): number {
  const RapierApi = getRapierSync();
  const a = yaw + angleOffset;
  const dir = { x: Math.sin(a), y: 0, z: Math.cos(a) };
  const hit = physWorld.world.castRay(new RapierApi.Ray(origin, dir), dist, true,
    undefined, undefined, undefined, undefined, physWorld.isWorldCollider);
  return hit ? hit.timeOfImpact : dist;
}

/**
 * Smart Tactical AI Bot Controller:
 * - 3-Ray Rapier obstacle avoidance whiskers so bots steer cleanly around containers & walls
 * - True target acquisition reactionDelay based on difficulty (EASY / NORMAL / PRO)
 * - Dynamic combat strafing, Q/E corner leaning, crouch-bursts, and low-HP cover retreat
 * - Respects smoke grenade clouds and patrols the map waypoints
 */
export function stepBotAiDecision(
  botId: string,
  botTeam: TeamId,
  botHp: number,
  botState: FpsPlayerState,
  memory: BotAiMemory,
  candidates: readonly BotTargetCandidate[],
  physWorld: PhysicsWorld,
  map: MapBlueprint,
  activeSmokes: readonly SmokeCloudVolume[],
  canShoot: boolean,
  difficulty: BotDifficulty,
  dt: number
): { input: InputCommand; wantsFire: boolean; fireOrigin: Vec3; fireDir: Vec3; target?: Vec3 } {
  memory.decisionTimer -= dt;
  if (memory.fireCooldown > 0) memory.fireCooldown -= dt;
  const skill = BOT_SKILL[difficulty];
  const halfFov = skill.halfFov * Math.PI / 180;

  const botEye = getCameraEyePosition(botState);
  let nearestVisible: BotTargetCandidate | null = null;
  let nearestDist = Infinity;

  for (const c of canShoot ? candidates : []) {
    if (!c.alive || c.team === botTeam || c.id === botId) continue;
    const enemyEye = getCameraEyePosition(c.state);
    const d = Math.hypot(
      enemyEye.x - botEye.x,
      enemyEye.y - botEye.y,
      enemyEye.z - botEye.z
    );
    const yawToEnemy = Math.atan2(enemyEye.x - botEye.x, enemyEye.z - botEye.z);
    if (d < nearestDist && d < skill.range && Math.abs(angleDifference(yawToEnemy, botState.yaw)) <= halfFov) {
      if (physWorld.hasLineOfSight(botEye, enemyEye, activeSmokes)) {
        nearestDist = d;
        nearestVisible = c;
      }
    }
  }

  let flags = 0;
  let targetYaw = botState.yaw;
  let targetPitch = 0;
  let wantsFire = false;
  const fireDir: Vec3 = { x: 0, y: 0, z: 1 };

  if (nearestVisible) {
    if (memory.lastSeenEnemyId !== nearestVisible.id) {
      memory.lastSeenEnemyId = nearestVisible.id;
      memory.reactionTimer = skill.reaction;
      memory.burstTimer = 0;
    } else if (memory.reactionTimer > 0) {
      memory.reactionTimer = Math.max(0, memory.reactionTimer - dt);
    }

    const enemyChest = {
      x: nearestVisible.state.position.x,
      y: nearestVisible.state.position.y + (nearestVisible.state.crouching ? 0.9 : 1.32),
      z: nearestVisible.state.position.z,
    };
    const dx = enemyChest.x - botEye.x;
    const dy = enemyChest.y - botEye.y;
    const dz = enemyChest.z - botEye.z;
    const horizDist = Math.max(0.001, Math.hypot(dx, dz));

    targetYaw = Math.atan2(dx, dz);
    targetPitch = Math.atan2(dy, horizDist);

    flags |= INPUT_FLAG_ADS;
    // Dynamic combat strafing / low-HP retreat
    if (botHp < 35) {
      flags |= INPUT_FLAG_BACK;
      flags |= memory.strafeSign > 0 ? INPUT_FLAG_RIGHT : INPUT_FLAG_LEFT;
    } else if (difficulty !== "EASY" && nearestDist > 16) {
      flags |= INPUT_FLAG_CROUCH;
      if (memory.strafeSign !== 0) {
        flags |= memory.strafeSign > 0 ? INPUT_FLAG_RIGHT : INPUT_FLAG_LEFT;
      }
    } else if (difficulty !== "EASY") {
      flags |= memory.strafeSign > 0 ? INPUT_FLAG_RIGHT : INPUT_FLAG_LEFT;
    }

    if (memory.leanSign < 0) flags |= INPUT_FLAG_LEAN_LEFT;
    else if (memory.leanSign > 0) flags |= INPUT_FLAG_LEAN_RIGHT;

    if (memory.decisionTimer <= 0) {
      memory.decisionTimer = 0.55 + Math.random() * 0.75;
      memory.strafeSign = Math.random() < 0.5 ? 1 : -1;
      memory.leanSign = difficulty === "EASY" ? 0 : Math.random() < 0.35 ? -1 : Math.random() < 0.7 ? 1 : 0;
    }

    const aligned = Math.abs(angleDifference(targetYaw, botState.yaw)) <= skill.aimTolerance &&
      Math.abs(targetPitch - botState.pitch) <= skill.aimTolerance;
    if (aligned && memory.reactionTimer <= 0 && memory.fireCooldown <= 0 && memory.burstTimer <= 0) {
      memory.burstTimer = skill.burst + Math.random() * 0.08;
    }
    if (memory.burstTimer > 0) {
      memory.burstTimer -= dt;
      if (memory.burstTimer <= 0) memory.fireCooldown = skill.pause + Math.random() * 0.25;
      wantsFire = aligned && memory.reactionTimer <= 0;
      if (wantsFire) flags |= INPUT_FLAG_FIRE;
    }
  } else {
    memory.lastSeenEnemyId = null;
    if (memory.burstTimer > 0) memory.fireCooldown = skill.pause;
    memory.burstTimer = 0;

    const waypoints = map.botWaypoints;
    const spawnExit = getSpawnExitTarget(map, botState.position);
    const targetPoint = spawnExit ?? waypoints[memory.waypointIndex % waypoints.length] ?? { x: 0, y: 0, z: 0 };

    const dx = targetPoint.x - botState.position.x;
    const dz = targetPoint.z - botState.position.z;
    const distXZ = Math.hypot(dx, dz);

    if (distXZ < (spawnExit ? 0.35 : 2.2)) {
      memory.waypointIndex =
        (memory.waypointIndex + 1 + Math.floor(Math.random() * 2)) % waypoints.length;
    } else {
      const desiredYaw = Math.atan2(dx, dz);

      // 3-Ray Rapier obstacle avoidance whiskers at waist height
      const waist = { x: botState.position.x, y: botState.position.y + 0.9, z: botState.position.z };
      const dCenter = castNavigationWhisker(physWorld, waist, desiredYaw, 0, 2.8);
      const dLeft = castNavigationWhisker(physWorld, waist, desiredYaw, -0.62, 2.8);
      const dRight = castNavigationWhisker(physWorld, waist, desiredYaw, 0.62, 2.8);

      let steerOffset = 0;
      if (dCenter < 2.2) {
        steerOffset = dLeft > dRight ? -0.95 : 0.95;
        memory.avoidTurnBias = steerOffset;
      } else if (Math.abs(memory.avoidTurnBias) > 0.05) {
        memory.avoidTurnBias *= 0.85;
        steerOffset = memory.avoidTurnBias;
      }

      targetYaw = desiredYaw + steerOffset;
      if (Math.abs(angleDifference(targetYaw, botState.yaw)) < 0.60) flags |= INPUT_FLAG_FORWARD;
      if (distXZ > 7 && canShoot && difficulty !== "EASY") {
        flags |= INPUT_FLAG_SPRINT;
      }
    }

    // Stuck recovery check
    const moved = Math.hypot(botState.position.x - memory.lastX, botState.position.z - memory.lastZ);
    memory.lastX = botState.position.x;
    memory.lastZ = botState.position.z;
    if (moved < 0.015) {
      memory.stuckTimer += dt;
      if (memory.stuckTimer > 1.0) {
        memory.stuckTimer = 0;
        memory.waypointIndex = (memory.waypointIndex + 1) % waypoints.length;
      }
    } else {
      memory.stuckTimer = 0;
    }

    if (memory.decisionTimer <= 0) {
      memory.decisionTimer = 1.0 + Math.random() * 1.0;
      memory.leanSign = 0;
    }
  }

  const maxTurn = skill.turn * dt;
  const nextYaw = botState.yaw + clamp(angleDifference(targetYaw, botState.yaw), -maxTurn, maxTurn);
  const nextPitch = botState.pitch + clamp(targetPitch - botState.pitch, -maxTurn, maxTurn);
  if (wantsFire) {
    yawPitchToDir(fireDir, nextYaw + (Math.random() * 2 - 1) * skill.yawSpread,
      nextPitch + (Math.random() * 2 - 1) * skill.pitchSpread);
  }

  return {
    input: {
      seq: 0,
      flags,
      yaw: nextYaw,
      pitch: nextPitch,
      dt,
      activeSlot: 0,
    },
    wantsFire,
    fireOrigin: botEye,
    fireDir,
    target: nearestVisible?.state.position,
  };
}
