import {
  ARMOR_ABSORB_RATIO,
  COUNTDOWN_SEC,
  BASE_ARMOR,
  BASE_HP,
  FIXED_DT,
  HEAL_DELAY_SEC,
  HEAL_HP_PER_SEC,
  INPUT_FLAG_ADS,
  INPUT_FLAG_RELOAD,
  INTERPOLATION_DELAY_MS,
  MAP_LIST,
  MAP_REGISTRY,
  MELEE_COOLDOWN_MS,
  MELEE_RANGE,
  MODE_CONFIGS,
  PRACTICE_TARGET_RADIUS,
  PRIMARY_WEAPON_IDS,
  RECONNECT_GRACE_SEC,
  REPLAY_SAMPLE_HZ,
  SKIN_LIST,
  SPAWN_PROTECTION_SEC,
  RESPAWN_SEC,
  THROWABLE_ORDER,
  THROWABLE_REGISTRY,
  WEAPON_REGISTRY,
  computeEffectiveWeaponStats,
  getAttachmentsForWeaponSlot,
  computePlayerHitboxes,
  createCharacterPhysics,
  createEmptyInputCommand,
  createInitialFpsState,
  createThrowableStock,
  destroyCharacterPhysics,
  distPointToRay,
  encodeWorldSnapshotBinary,
  emptyCombatStats,
  clamp,
  getCameraEyePosition,
  intersectRayHitboxes,
  isCombatPhase,
  normalizeMatchRules,
  sampleShotCone,
  shotSpreadRadians,
  stepFpsCharacter,
  teleportCharacterPhysics,
  yawPitchToDir,
  type BinaryPlayerSnapshot,
  type BotDifficulty,
  type CharacterPhysicsHandle,
  type ClientToServerMessage,
  type CombatStats,
  type DamageBreakdownPayload,
  type EffectiveWeaponStats,
  type FpsPlayerState,
  type GameMode,
  type HitMarkerTier,
  type HitZone,
  type InputCommand,
  type MapBlueprint,
  type MatchResultPlayer,
  type MatchRules,
  type PlayerHitboxes,
  type PlayerLoadoutPayload,
  type RoomPlayerSummary,
  type RoomStateBroadcast,
  type RoundPhase,
  type ServerToClientMessage,
  type ShotPath,
  type SmokeCloudVolume,
  type TeamId,
  type ThrowableStock,
  type ThrowableType,
  type Vec3,
  PhysicsWorld,
} from "@game/shared";
import { LagCompensator } from "../systems/LagCompensator.js";
import { createBotMemory, stepBotAiDecision, type BotAiMemory } from "../systems/TacticalBotAi.js";
import { ArenaPickups } from "../systems/ArenaPickups.js";
import { DeathReplay } from "../systems/DeathReplay.js";
import type { Rankings } from "../systems/Rankings.js";

const INPUT_STEP_MS = FIXED_DT * 1000;
const MAX_MOVEMENT_CREDIT_TICKS = 12;
const MAX_INPUTS_PER_ROOM_TICK = 3;
type HitConfirmation = Extract<ServerToClientMessage, { type: "HIT_CONFIRM" }>;
type ShotTarget = { player: RoomPlayer; hitboxes: PlayerHitboxes };
const HIT_PRIORITY: Record<HitMarkerTier, number> = { PROTECTED: 0, BODY: 1, ARMOR_BREAK: 2, HEADSHOT: 3, KILL: 4 };

export interface ClientSender {
  sendJson: (msg: ServerToClientMessage) => void;
  sendBinary: (buf: ArrayBuffer) => void;
}

const BARREL_FUSE_SEC = 0.32;
const BARREL_BLAST_RADIUS = 7;
const BARREL_BLAST_DAMAGE = 130;

interface ActiveThrowable {
  id: string;
  throwable: ThrowableType;
  ownerId: string;
  ownerName: string;
  ownerTeam: TeamId;
  position: Vec3;
  velocity: Vec3;
  fuseRemaining: number;
  detonated: boolean;
  smokeTimer: number;
}

interface DamageLedger {
  dealtTotal: number;
  dealtHits: number;
  dealtHeadshots: number;
  takenTotal: number;
  takenHits: number;
  takenHeadshots: number;
  killerName?: string;
  killerWeaponId?: string;
  killerHpLeft?: number;
  distanceM?: number;
}

interface RoomPlayer {
  id: string;
  guestUuid: string;
  playerIndex: number;
  callsign: string;
  team: TeamId;
  isHost: boolean;
  isBot: boolean;
  joinedAtMs: number;
  sender: ClientSender | null;
  pingMs: number;
  kills: number;
  deaths: number;
  assists: number;
  combatStats: CombatStats;
  streak: number;
  multikill: number;
  lastKillAt: number;
  nextMeleeAt: number;
  nextPingAt: number;
  nextBotUtilityTick: number;
  alive: boolean;
  hp: number;
  armor: number;
  loadout: PlayerLoadoutPayload;
  pendingLoadout?: PlayerLoadoutPayload;
  effectivePrimary: EffectiveWeaponStats;
  effectiveSecondary: EffectiveWeaponStats;
  ammoInMag: [number, number];
  ammoReserve: [number, number];
  reloadTimer: number;
  reloadSlot: 0 | 1;
  nextShotAllowedAtMs: number;
  lastShotAtMs: number;
  throwablesLeft: number;
  throwableStock: ThrowableStock;
  respawnTimer: number;
  healingDelay: number;
  spawnProtection: number;
  state: FpsPlayerState;
  physics: CharacterPhysicsHandle;
  latestInput: InputCommand;
  inputQueue: InputCommand[];
  lastReceivedInput: number;
  lastInputAtMs: number;
  movementCreditTicks: number;
  movementCreditAtMs: number;
  movementEpoch: number;
  lastShotSeq: number;
  botMemory?: BotAiMemory;
  ledger: DamageLedger;
}

function emptyLedger(): DamageLedger {
  return {
    dealtTotal: 0,
    dealtHits: 0,
    dealtHeadshots: 0,
    takenTotal: 0,
    takenHits: 0,
    takenHeadshots: 0,
  };
}

export function defaultPlayerLoadout(): PlayerLoadoutPayload {
  return {
    primary: {
      weaponId: "m416",
      skinId: "standard_issue",
      attachments: { optic: "optic_red_dot" },
    },
    secondary: {
      weaponId: "deagle",
      skinId: "standard_issue",
      attachments: {},
    },
    throwable: "frag",
  };
}

/**
 * Authoritative headless FPS arena room supporting:
 * - Continuous deathmatch (1v1, 2v2, 4v4 TDM) with respawns, a score limit and an optional time limit, & Warm-Up
 * - 60Hz Rapier character & ballistic simulation with 1-second Lag Rewind
 * - 20s Guest UUID reconnection grace & Automatic Host Migration
 * - Thin-cover wallbangs, destructible glass/barrels, & Frag/Smoke/Flashbang
 */
export class FpsArenaRoom {
  public readonly code: string;
  public isPublic: boolean;
  public mode: GameMode;
  public mapId: string;
  public botFill: boolean;
  public botDifficulty: BotDifficulty;
  public matchRules: MatchRules;

  private map: MapBlueprint;
  private physWorld: PhysicsWorld;
  private readonly lagComp = new LagCompensator();
  private readonly replay = new DeathReplay();
  private readonly pickups = new ArenaPickups();
  private readonly rankings?: Rankings;
  private rankedLineup: Pick<RoomPlayer, "guestUuid" | "callsign" | "team">[] = [];
  private readonly players = new Map<string, RoomPlayer>();
  private readonly pendingReconnects = new Map<
    string,
    { player: RoomPlayer; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly throwables: ActiveThrowable[] = [];
  private readonly barrelFuses = new Map<string, { timer: number; attacker: RoomPlayer }>();

  private phase: RoundPhase = "WARMUP";
  private phaseTimerSec = 0;
  private matchElapsedSec = 0;
  private scoreA = 0;
  private scoreB = 0;

  private mapVoteOptions: string[] = [];
  private mapVotes = new Map<string, string>(); // playerId -> mapId
  private nextPlayerIndex = 1;
  private tickCounter = 0;
  private nextThrowableId = 1;
  private afkFullTimerSec = 0;
  private loopHandle: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private onEmptyCallback?: (code: string) => void;

  constructor(options: {
    code: string;
    isPublic: boolean;
    mode: GameMode;
    mapId: string;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
    matchRules?: Partial<MatchRules>;
    rankings?: Rankings;
    onEmpty?: (code: string) => void;
  }) {
    this.code = options.code;
    this.isPublic = options.isPublic;
    this.mode = options.mode;
    this.mapId = MAP_REGISTRY[options.mapId] ? options.mapId : "cargo_docks";
    this.matchRules = normalizeMatchRules(this.mode, options.matchRules);
    this.rankings = options.rankings;
    this.botFill = !this.matchRules.ranked && options.botFill;
    this.botDifficulty = options.botDifficulty === "EASY" || options.botDifficulty === "PRO" ? options.botDifficulty : "NORMAL";
    this.onEmptyCallback = options.onEmpty;
    this.map = MAP_REGISTRY[this.mapId];
    this.physWorld = new PhysicsWorld(this.map);
    this.pickups.reset(this.map);
  }

  startLoop(): void {
    if (this.stopped || this.loopHandle) return;
    let nextTick = performance.now() + INPUT_STEP_MS;
    this.loopHandle = setInterval(() => {
      const now = performance.now();
      nextTick = Math.max(nextTick, now - INPUT_STEP_MS * 4);
      while (nextTick <= now) {
        this.tick(now);
        nextTick += INPUT_STEP_MS;
      }
    }, 8);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
    for (const entry of this.pendingReconnects.values()) {
      clearTimeout(entry.timeout);
    }
    this.pendingReconnects.clear();
    this.physWorld.dispose();
  }

  getSummary() {
    const humanCount = this.getHumanCount();
    return {
      code: this.code,
      isPublic: this.isPublic,
      mode: this.mode,
      mapId: this.mapId,
      mapName: this.map.name,
      phase: this.phase,
      playerCount: this.players.size,
      humanCount,
      maxPlayers: MODE_CONFIGS[this.mode].maxPlayers,
      ranked: this.matchRules.ranked,
      timeLimitSeconds: this.matchRules.timeLimitSeconds,
      scoreLimit: this.matchRules.scoreLimit,
      timeRemainingSec: this.timeRemainingSec(),
      scoreA: this.scoreA,
      scoreB: this.scoreB,
    };
  }

  private timeRemainingSec(): number {
    if (this.phase === "COUNTDOWN") return Math.max(0, Math.ceil(this.phaseTimerSec));
    if (this.phase === "LIVE" && this.matchRules.timeLimitSeconds > 0) return Math.max(0, Math.ceil(this.phaseTimerSec));
    return this.phase === "WARMUP" ? this.matchRules.timeLimitSeconds : 0;
  }

  getHumanCount(): number {
    let count = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) count++;
    }
    return count;
  }

  canJoin(guestUuid?: string): boolean {
    if (guestUuid && this.pendingReconnects.has(guestUuid)) return true;
    if (this.matchRules.ranked && this.phase !== "WARMUP") return false;
    const maxP = MODE_CONFIGS[this.mode].maxPlayers;
    if (this.getHumanCount() < maxP) return true;
    return false;
  }

  addOrReconnectPlayer(params: {
    guestUuid: string;
    callsign: string;
    loadout: PlayerLoadoutPayload;
    sender: ClientSender;
  }): { player: RoomPlayer; reconnected: boolean } {
    // Check 20s reconnect slot first
    const pending = this.pendingReconnects.get(params.guestUuid);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingReconnects.delete(params.guestUuid);
      pending.player.sender = params.sender;
      pending.player.callsign = params.callsign || pending.player.callsign;
      this.resetMovementStream(pending.player);
      if (!Array.from(this.players.values()).some((p) => p.isHost)) pending.player.isHost = true;
      this.checkAutoMatchStart();
      this.broadcastRoomState();
      return { player: pending.player, reconnected: true };
    }

    // Evict a bot if room is full of bots and a human joins
    if (this.matchRules.ranked && Array.from(this.players.values()).some((p) => p.guestUuid === params.guestUuid)) {
      throw new Error("This guest profile already has a seat in the ranked match.");
    }
    const maxPlayers = MODE_CONFIGS[this.mode].maxPlayers;
    if (this.players.size >= maxPlayers) {
      const botToEvict = Array.from(this.players.values()).find((p) => p.isBot);
      if (botToEvict) {
        this.removePlayerInternal(botToEvict.id);
      }
    }

    const team = this.pickBalancedTeam();
    const joiningLive = this.phase === "LIVE";
    const spawn = joiningLive
      ? this.pickSafeSpawn(team, this.nextPlayerIndex)
      : this.getSpawnForTeam(team, this.players.size);
    const id = `p_${this.nextPlayerIndex}`;
    const playerIndex = this.nextPlayerIndex++;
    const hasHumanHost = Array.from(this.players.values()).some((p) => !p.isBot && p.isHost);

    const player = this.createRoomPlayer({
      id,
      guestUuid: params.guestUuid,
      playerIndex,
      callsign: params.callsign || `Operator-${playerIndex}`,
      team,
      isHost: !hasHumanHost,
      isBot: false,
      sender: params.sender,
      loadout: params.loadout,
      spawn,
    });

    if (joiningLive) player.spawnProtection = SPAWN_PROTECTION_SEC;
    this.players.set(id, player);
    this.syncBotFill();
    this.checkAutoMatchStart();
    this.broadcastRoomState();
    return { player, reconnected: false };
  }

  handleDisconnect(playerId: string): void {
    if (this.stopped) return;
    const player = this.players.get(playerId);
    if (!player?.sender || player.isBot) return;

    player.sender = null;
    this.resetMovementStream(player);
    const wasHost = player.isHost;
    player.isHost = false;

    if (wasHost) {
      this.migrateHost();
    }

    // Reserve slot for 20 seconds so browser refresh doesn't kick them
    const timeout = setTimeout(() => {
      this.pendingReconnects.delete(player.guestUuid);
      this.removePlayerInternal(player.id);
      if (this.matchRules.ranked && this.phase === "LIVE" &&
        !Array.from(this.players.values()).some((other) => other.team === player.team)) {
        this.finishMatch("Opponent team forfeited", player.team === "A" ? "B" : "A");
      }
      this.syncBotFill();
      this.broadcastRoomState();
      if (this.getHumanCount() === 0 && this.pendingReconnects.size === 0) {
        this.onEmptyCallback?.(this.code);
      }
    }, RECONNECT_GRACE_SEC * 1000);

    this.pendingReconnects.set(player.guestUuid, { player, timeout });
    this.broadcastRoomState();
  }

  private migrateHost(): void {
    let oldestHuman: RoomPlayer | null = null;
    for (const p of this.players.values()) {
      if (p.isBot || !p.sender) continue;
      if (!oldestHuman || p.joinedAtMs < oldestHuman.joinedAtMs) {
        oldestHuman = p;
      }
    }
    if (oldestHuman) {
      oldestHuman.isHost = true;
    }
  }

  private removePlayerInternal(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    destroyCharacterPhysics(this.physWorld, p.physics);
    this.players.delete(playerId);
  }

  private createRoomPlayer(opts: {
    id: string;
    guestUuid: string;
    playerIndex: number;
    callsign: string;
    team: TeamId;
    isHost: boolean;
    isBot: boolean;
    sender: ClientSender | null;
    loadout: PlayerLoadoutPayload;
    spawn: { position: Vec3; yaw: number };
  }): RoomPlayer {
    const activeKit = opts.loadout;
    const effPrimary = computeEffectiveWeaponStats(
      activeKit.primary.weaponId,
      activeKit.primary.attachments
    );
    const effSecondary = computeEffectiveWeaponStats(
      activeKit.secondary.weaponId,
      activeKit.secondary.attachments
    );

    const state = createInitialFpsState(opts.spawn.position, opts.spawn.yaw);
    const physics = createCharacterPhysics(this.physWorld, opts.spawn.position);

    return {
      id: opts.id,
      guestUuid: opts.guestUuid,
      playerIndex: opts.playerIndex,
      callsign: opts.callsign,
      team: opts.team,
      isHost: opts.isHost,
      isBot: opts.isBot,
      joinedAtMs: Date.now(),
      sender: opts.sender,
      pingMs: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      combatStats: emptyCombatStats(),
      streak: 0,
      multikill: 0,
      lastKillAt: -Infinity,
      nextMeleeAt: 0,
      nextPingAt: 0,
      nextBotUtilityTick: 0,
      alive: true,
      hp: BASE_HP,
      armor: BASE_ARMOR,
      loadout: opts.loadout,
      effectivePrimary: effPrimary,
      effectiveSecondary: effSecondary,
      ammoInMag: [effPrimary.magSize, effSecondary.magSize],
      ammoReserve: [effPrimary.reserveAmmoMax, effSecondary.reserveAmmoMax],
      reloadTimer: 0,
      reloadSlot: 0,
      nextShotAllowedAtMs: 0,
      lastShotAtMs: 0,
      throwablesLeft: 2,
      throwableStock: createThrowableStock(opts.loadout.throwable, opts.loadout.tdmThrowables),
      respawnTimer: 0,
      healingDelay: 0,
      spawnProtection: 0,
      state,
      physics,
      latestInput: { ...createEmptyInputCommand(), yaw: state.yaw },
      inputQueue: [],
      lastReceivedInput: 0,
      lastInputAtMs: 0,
      movementCreditTicks: 1,
      movementCreditAtMs: performance.now(),
      movementEpoch: 0,
      lastShotSeq: 0,
      botMemory: opts.isBot ? createBotMemory(opts.playerIndex) : undefined,
      ledger: emptyLedger(),
    };
  }

  private pickBalancedTeam(): TeamId {
    let countA = 0;
    let countB = 0;
    for (const p of this.players.values()) {
      if (p.team === "A") countA++;
      else countB++;
    }
    return countA <= countB ? "A" : "B";
  }

  private getSpawnForTeam(team: TeamId, slotSeed: number): { position: Vec3; yaw: number } {
    const list = team === "A" ? this.map.spawnsA : this.map.spawnsB;
    return list[Math.abs(slotSeed) % list.length];
  }

  private pickSafeSpawn(team: TeamId, seed: number) {
    const spawns = team === "A" ? this.map.spawnsA : this.map.spawnsB;
    let best = this.getSpawnForTeam(team, seed);
    let bestScore = -Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const spawn = this.getSpawnForTeam(team, seed + i);
      const eye = { ...spawn.position, y: spawn.position.y + 1.62 };
      let closestEnemy = Infinity;
      let exposed = 0;
      let occupied = false;
      for (const other of this.players.values()) {
        if (!other.alive) continue;
        const position = other.state.position;
        const distance = Math.hypot(eye.x - position.x, spawn.position.y - position.y, eye.z - position.z);
        if (distance < 1.25) occupied = true;
        if (other.team === team) continue;
        closestEnemy = Math.min(closestEnemy, distance);
        if (this.physWorld.hasLineOfSight(getCameraEyePosition(other.state), eye)) exposed++;
      }
      const score = (occupied ? -5000 : 0) - exposed * 1000 + Math.min(closestEnemy, 80);
      if (score > bestScore) {
        best = spawn;
        bestScore = score;
      }
    }
    return best;
  }

  private syncBotFill(): void {
    const maxP = MODE_CONFIGS[this.mode].maxPlayers;
    if (!this.botFill) {
      for (const p of Array.from(this.players.values())) {
        if (p.isBot) this.removePlayerInternal(p.id);
      }
      return;
    }

    const desiredTotal = this.mode === "WARMUP" ? Math.min(4, maxP) : maxP;
    const botNames = [
      "Viper-AI",
      "Ghost-AI",
      "Reaper-AI",
      "Kestrel-AI",
      "Nomad-AI",
      "Spectre-AI",
      "Titan-AI",
      "Falcon-AI",
    ];

    while (this.players.size < desiredTotal) {
      const team = this.pickBalancedTeam();
      const idx = this.nextPlayerIndex++;
      const joiningLive = this.phase === "LIVE";
      const spawn = joiningLive ? this.pickSafeSpawn(team, idx) : this.getSpawnForTeam(team, idx);
      const id = `bot_${idx}`;
      const botWeapon = PRIMARY_WEAPON_IDS[idx % PRIMARY_WEAPON_IDS.length];
      const botLoadout: PlayerLoadoutPayload = {
        primary: {
          weaponId: botWeapon,
          skinId: SKIN_LIST[idx % SKIN_LIST.length].id,
          attachments: { optic: "optic_red_dot" },
        },
        secondary: { weaponId: "deagle", skinId: "standard_issue", attachments: {} },
        throwable: "frag",
      };
      const bot = this.createRoomPlayer({
        id,
        guestUuid: id,
        playerIndex: idx,
        callsign: botNames[(idx - 1) % botNames.length],
        team,
        isHost: false,
        isBot: true,
        sender: null,
        loadout: botLoadout,
        spawn,
      });
      if (joiningLive) bot.spawnProtection = SPAWN_PROTECTION_SEC;
      this.players.set(id, bot);
    }
  }

  private checkAutoMatchStart(): void {
    if (this.mode === "WARMUP") return;
    const cfg = MODE_CONFIGS[this.mode];
    if (this.phase === "WARMUP" && this.players.size >= cfg.maxPlayers &&
      (this.botFill || (this.matchRules.ranked && this.rankedRosterReady()))) {
      this.beginMatch();
    }
  }

  private rankedRosterReady(): boolean {
    return this.players.size === MODE_CONFIGS.TDM.maxPlayers && Array.from(this.players.values()).every((p) => p.sender && !p.isBot);
  }

  handleClientMessage(playerId: string, msg: ClientToServerMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (msg.type) {
      case "SET_LOADOUT": {
        player.pendingLoadout = undefined;
        this.applyPlayerLoadout(player, msg.loadout);
        if (this.mode !== "WARMUP") {
          player.throwableStock = createThrowableStock(msg.loadout.throwable, msg.loadout.tdmThrowables);
        }
        this.sendLocalState(player.id);
        this.broadcastRoomState();
        break;
      }
      case "SET_OPTIC": {
        if (!player.alive) break;
        const slot = msg.slot === 1 ? 1 : 0;
        const cfg = slot === 0 ? player.loadout.primary : player.loadout.secondary;
        const category = (slot === 0 ? player.effectivePrimary : player.effectiveSecondary).blueprint.category;
        const allowed = getAttachmentsForWeaponSlot(category, "optic").map((a) => a.id);
        if (msg.optic !== null && !allowed.includes(msg.optic)) break;
        const attachments = { ...cfg.attachments };
        if (msg.optic === null) delete attachments.optic;
        else attachments.optic = msg.optic;
        const nextCfg = { ...cfg, attachments };
        player.loadout = {
          ...player.loadout,
          ...(slot === 0 ? { primary: nextCfg } : { secondary: nextCfg }),
        };
        if (player.pendingLoadout) {
          player.pendingLoadout = {
            ...player.pendingLoadout,
            ...(slot === 0 ? { primary: nextCfg } : { secondary: nextCfg }),
          };
        }
        const eff = computeEffectiveWeaponStats(nextCfg.weaponId, nextCfg.attachments);
        if (slot === 0) player.effectivePrimary = eff;
        else player.effectiveSecondary = eff;
        this.broadcastRoomState();
        break;
      }
      case "UPDATE_ROOM_SETTINGS": {
        if (!player.isHost || this.matchRules.ranked) return;
        let mapChanged = false;
        const tdmLocked = this.phase !== "WARMUP";
        if (!tdmLocked && msg.mapId && MAP_REGISTRY[msg.mapId] && msg.mapId !== this.mapId) {
          this.mapId = msg.mapId;
          this.map = MAP_REGISTRY[this.mapId];
          this.rebuildWorldForMap();
          mapChanged = true;
        }
        if (!tdmLocked && msg.mode && MODE_CONFIGS[msg.mode]) {
          this.mode = msg.mode;
        }
        if (this.phase === "WARMUP" && (msg.matchRules || msg.mode)) {
          this.matchRules = normalizeMatchRules(this.mode, { ...this.matchRules, ...msg.matchRules, ranked: false });
        }
        if (msg.botFill !== undefined) this.botFill = msg.botFill;
        if ((msg.botDifficulty === "EASY" || msg.botDifficulty === "NORMAL" || msg.botDifficulty === "PRO") &&
          msg.botDifficulty !== this.botDifficulty) {
          this.botDifficulty = msg.botDifficulty;
          for (const p of this.players.values()) {
            if (!p.botMemory) continue;
            p.botMemory.lastSeenEnemyId = null;
            p.botMemory.burstTimer = 0;
            p.botMemory.leanSign = 0;
          }
        }
        if (msg.isPublic !== undefined) this.isPublic = msg.isPublic;
        this.syncBotFill();
        if (mapChanged) {
          this.resetPlayersToSpawns();
        }
        this.broadcastRoomState();
        break;
      }
      case "START_MATCH": {
        if (!player.isHost || this.mode === "WARMUP" || this.phase !== "WARMUP") return;
        if (this.matchRules.ranked && !this.rankedRosterReady()) return;
        this.beginMatch();
        break;
      }
      case "INPUT": {
        if (!player.alive || !Number.isSafeInteger(msg.seq) || msg.seq <= player.lastReceivedInput ||
          (msg.movementEpoch !== undefined && msg.movementEpoch !== player.movementEpoch) ||
          !Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch) ||
          (msg.activeSlot !== 0 && msg.activeSlot !== 1)) break;
        if (player.inputQueue.length >= 120) break;
        player.lastReceivedInput = msg.seq;
        player.lastInputAtMs = performance.now();
        player.inputQueue.push({
          seq: msg.seq,
          flags: msg.flags,
          yaw: msg.yaw,
          pitch: msg.pitch,
          dt: FIXED_DT,
          activeSlot: msg.activeSlot,
        });
        break;
      }
      case "FIRE_SHOT": {
        if (!Number.isSafeInteger(msg.seq) || msg.seq <= player.lastShotSeq || (msg.activeSlot !== 0 && msg.activeSlot !== 1)) break;
        if (msg.movementEpoch !== undefined && msg.movementEpoch !== player.movementEpoch) break;
        player.lastShotSeq = msg.seq;
        this.processPlayerShot(player, msg);
        break;
      }
      case "THROW_GRENADE": {
        this.processThrowGrenade(player, msg);
        break;
      }
      case "MELEE": {
        if (msg.movementEpoch === undefined || msg.movementEpoch === player.movementEpoch) this.processMelee(player);
        break;
      }
      case "DANGER_PING": {
        const now = Date.now();
        if (!player.alive || now < player.nextPingAt || !Number.isFinite(Math.hypot(msg.position?.x, msg.position?.y, msg.position?.z))) break;
        player.nextPingAt = now + 850;
        const eye = getCameraEyePosition(player.state);
        const enemySpotted = Array.from(this.players.values()).some((target) =>
          target.alive && target.team !== player.team &&
          Math.hypot(target.state.position.x - msg.position.x, target.state.position.z - msg.position.z) < 2.5 &&
          this.physWorld.hasLineOfSight(eye, getCameraEyePosition(target.state)));
        for (const p of this.players.values()) {
          if (p.team === player.team && p.sender) {
            p.sender.sendJson({
              type: "DANGER_PING",
              playerId: player.id,
              callsign: player.callsign,
              team: player.team,
              position: msg.position,
              enemySpotted,
            });
          }
        }
        break;
      }
      case "VOTE_MAP": {
        if (this.phase === "MATCH_END" && MAP_REGISTRY[msg.mapId]) {
          this.mapVotes.set(player.id, msg.mapId);
          this.broadcastRoomState();
        }
        break;
      }
      case "REMATCH_NOW": {
        if (this.phase === "MATCH_END") {
          this.finishMatchEndVotes();
        }
        break;
      }
      case "PING_CHECK": {
        const now = Date.now();
        player.sender?.sendJson({ type: "PONG_CHECK", t0: msg.t0, serverTimeMs: now });
        break;
      }
    }
  }

  recordRoundTripTime(playerId: string, rttMs: number): void {
    const player = this.players.get(playerId);
    if (player) player.pingMs = clamp(rttMs, 0, 800);
  }

  private resetMovementStream(player: RoomPlayer): void {
    player.movementEpoch++;
    player.inputQueue.length = 0;
    player.lastReceivedInput = player.latestInput.seq;
    player.movementCreditTicks = 1;
    player.movementCreditAtMs = performance.now();
    player.latestInput = { ...createEmptyInputCommand(player.latestInput.seq), yaw: player.state.yaw, pitch: player.state.pitch };
  }

  private applyPlayerLoadout(player: RoomPlayer, loadout: PlayerLoadoutPayload): void {
    player.loadout = loadout;
    const effectiveKit = loadout;
    player.effectivePrimary = computeEffectiveWeaponStats(
      effectiveKit.primary.weaponId,
      effectiveKit.primary.attachments
    );
    player.effectiveSecondary = computeEffectiveWeaponStats(
      effectiveKit.secondary.weaponId,
      effectiveKit.secondary.attachments
    );
    player.ammoInMag = [player.effectivePrimary.magSize, player.effectiveSecondary.magSize];
    player.ammoReserve = [player.effectivePrimary.reserveAmmoMax, player.effectiveSecondary.reserveAmmoMax];
    player.reloadTimer = 0;
  }

  private rebuildWorldForMap(): void {
    const newWorld = new PhysicsWorld(this.map);
    for (const p of this.players.values()) {
      destroyCharacterPhysics(this.physWorld, p.physics);
      p.physics = createCharacterPhysics(newWorld, p.state.position);
    }
    this.physWorld.dispose();
    this.physWorld = newWorld;
    this.lagComp.clear();
    this.replay.clear();
    this.pickups.reset(this.map);
  }

  public beginMatch(): void {
    if (this.matchRules.ranked && !this.rankedRosterReady()) return;
    this.rankedLineup = this.matchRules.ranked
      ? Array.from(this.players.values(), ({ guestUuid, callsign, team }) => ({ guestUuid, callsign, team }))
      : [];
    this.scoreA = 0;
    this.scoreB = 0;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.assists = 0;
      p.combatStats = emptyCombatStats();
    }
    this.phase = "COUNTDOWN";
    this.phaseTimerSec = COUNTDOWN_SEC;
    this.matchElapsedSec = 0;
    this.throwables.length = 0;
    this.replay.clear();
    this.pickups.reset(this.map);
    this.barrelFuses.clear();
    this.physWorld.resetDestructibles();
    this.resetPlayersToSpawns();
    this.broadcastRoomState();
  }

  private resetPlayersToSpawns(): void {
    let idxA = 0;
    let idxB = 0;
    for (const p of this.players.values()) {
      const spawn = this.getSpawnForTeam(p.team, p.team === "A" ? idxA++ : idxB++);
      this.spawnPlayer(p, spawn);
    }
  }

  private spawnPlayer(player: RoomPlayer, spawn: { position: Vec3; yaw: number }, protectedSpawn = false): void {
    teleportCharacterPhysics(player.physics, player.state, spawn.position, spawn.yaw);
    this.resetMovementStream(player);
    player.alive = true;
    player.hp = BASE_HP;
    player.armor = BASE_ARMOR;
    player.throwablesLeft = 2;
    player.respawnTimer = 0;
    player.healingDelay = 0;
    player.spawnProtection = protectedSpawn ? SPAWN_PROTECTION_SEC : 0;
    player.nextShotAllowedAtMs = 0;
    player.lastShotAtMs = 0;
    player.nextMeleeAt = 0;
    player.nextBotUtilityTick = this.tickCounter + 240 + player.playerIndex % 60;
    player.streak = 0;
    player.multikill = 0;
    player.lastKillAt = -Infinity;
    player.ledger = emptyLedger();
    this.applyPlayerLoadout(player, player.pendingLoadout ?? player.loadout);
    player.pendingLoadout = undefined;
    player.throwableStock = createThrowableStock(player.loadout.throwable, player.loadout.tdmThrowables);
  }

  private tick(movementClockMs: number): void {
    this.tickCounter++;
    const nowMs = Date.now();
    const canMove = this.phase !== "COUNTDOWN" && this.phase !== "MATCH_END";
    const canShoot = isCombatPhase(this.phase);
    const live = this.phase === "LIVE";

    const activeSmokes: SmokeCloudVolume[] = [];
    for (const t of this.throwables) {
      if (t.detonated && t.throwable === "smoke" && t.smokeTimer > 0) {
        activeSmokes.push({ position: t.position, radius: THROWABLE_REGISTRY.smoke.effectRadius });
      }
    }

    const botCandidates = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      team: p.team,
      alive: p.alive,
      state: p.state,
      hp: p.hp,
    }));

    // Advance the room at 60 Hz. Human input may catch up within its elapsed budget.
    const frameHitboxes = new Map<string, PlayerHitboxes>();
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.phase === "WARMUP" || live) {
          p.respawnTimer -= FIXED_DT;
          if (p.respawnTimer <= 1e-6) {
            const seed = p.playerIndex + this.tickCounter;
            const spawn = live ? this.pickSafeSpawn(p.team, seed) : this.getSpawnForTeam(p.team, seed);
            this.spawnPlayer(p, spawn, live);
            this.broadcastRoomState();
          }
        }
        continue;
      }

      if (live) {
        p.spawnProtection = Math.max(0, p.spawnProtection - FIXED_DT);
      }
      if (canShoot) {
        if (p.healingDelay > 0) p.healingDelay = Math.max(0, p.healingDelay - FIXED_DT);
        else if (p.hp < BASE_HP) p.hp = Math.min(BASE_HP, p.hp + HEAL_HP_PER_SEC * FIXED_DT);
      }

      if (p.isBot && p.botMemory) {
        this.stepPlayerReload(p);
        const ai = stepBotAiDecision(
          p.id,
          p.team,
          p.hp,
          p.state,
          p.botMemory,
          botCandidates,
          this.physWorld,
          this.map,
          activeSmokes,
          canShoot && canMove,
          this.botDifficulty,
          FIXED_DT
        );
        p.latestInput = ai.input;
        const usedUtility = ai.wantsFire && ai.target && this.tryBotUtility(p, ai.fireOrigin, ai.target, nowMs);
        if (ai.wantsFire && canShoot && canMove && !usedUtility) {
          this.tryBotFire(p, ai.fireOrigin, ai.fireDir, nowMs);
        }
        this.stepPlayerMovement(p, canMove);
      } else {
        this.stepHumanInputs(p, movementClockMs, canMove);
      }

      frameHitboxes.set(p.id, computePlayerHitboxes(p.id, p.state));
    }

    this.lagComp.recordFrame(nowMs, frameHitboxes);
    if (canShoot && this.tickCounter % (60 / REPLAY_SAMPLE_HZ) === 0) {
      this.replay.record(this.tickCounter * INPUT_STEP_MS, this.players.values());
      if (this.pickups.step(this.players.values(), this.tickCounter, (player, kind) => {
        player.sender?.sendJson({ type: "PICKUP_COLLECTED", kind });
      })) this.broadcastRoomState();
    }
    if (this.phase === "MATCH_END") this.throwables.length = 0;
    else this.stepThrowables(FIXED_DT);
    this.stepBarrelFuses(FIXED_DT);
    this.stepMatchClock(FIXED_DT);

    // Broadcast 20Hz binary transform snapshots (every 3rd physics tick)
    if (this.tickCounter % 3 === 0) {
      this.broadcastBinarySnapshot(nowMs);
    }
    // Sync room HUD timers every 30 ticks (2Hz)
    if (this.tickCounter % 30 === 0) {
      this.broadcastRoomState();
    }
  }

  private stepHumanInputs(player: RoomPlayer, nowMs: number, canMove: boolean): void {
    // Bank a short share of unused wall-clock steps so jitter cannot leave a permanent queue
    // behind a 60 Hz stream. Extra packets cannot increase the rate at which credit accrues.
    const elapsedSteps = Math.max(0, nowMs - player.movementCreditAtMs) / INPUT_STEP_MS;
    player.movementCreditAtMs = Math.max(nowMs, player.movementCreditAtMs);
    player.movementCreditTicks = Math.min(MAX_MOVEMENT_CREDIT_TICKS, player.movementCreditTicks + elapsedSteps);
    const steps = Math.min(
      Math.floor(player.movementCreditTicks + 1e-6),
      player.inputQueue.length,
      MAX_INPUTS_PER_ROOM_TICK,
    );

    if (!steps) {
      if (nowMs - player.lastInputAtMs > 250) player.latestInput.flags = 0;
      this.stepPlayerReload(player);
      return;
    }

    player.movementCreditTicks = Math.max(0, player.movementCreditTicks - steps);
    for (let i = 0; i < steps; i++) {
      const input = player.inputQueue.shift()!;
      if (input.activeSlot !== player.latestInput.activeSlot) player.reloadTimer = 0;
      player.latestInput = input;
      this.stepPlayerReload(player, (input.flags & INPUT_FLAG_RELOAD) !== 0, i === 0);
      this.stepPlayerMovement(player, canMove);
    }
  }

  private stepPlayerMovement(player: RoomPlayer, canMove: boolean): void {
    const stats = player.latestInput.activeSlot === 0 ? player.effectivePrimary : player.effectiveSecondary;
    stepFpsCharacter(this.physWorld, player.physics, player.state, player.latestInput,
      stats.moveSpeedMultiplier, FIXED_DT, canMove);
  }

  private stepPlayerReload(player: RoomPlayer, reloadPressed = false, advanceTimer = true): void {
    if (player.reloadTimer > 0) {
      if (!advanceTimer) return;
      player.reloadTimer -= FIXED_DT;
      if (player.reloadTimer <= 0) {
        const slot = player.reloadSlot;
        const stats = slot === 0 ? player.effectivePrimary : player.effectiveSecondary;
        const needed = stats.magSize - player.ammoInMag[slot];
        const take = Math.min(needed, player.ammoReserve[slot]);
        player.ammoInMag[slot] += take;
        player.ammoReserve[slot] -= take;
      }
    } else if (reloadPressed) {
      const slot = player.latestInput.activeSlot;
      const stats = slot === 0 ? player.effectivePrimary : player.effectiveSecondary;
      if (player.ammoInMag[slot] < stats.magSize && player.ammoReserve[slot] > 0) {
        player.reloadSlot = slot;
        player.reloadTimer = player.ammoInMag[slot] === 0 ? stats.reloadEmptySec : stats.reloadTacticalSec;
      }
    }
  }

  private tryBotFire(bot: RoomPlayer, origin: Vec3, dir: Vec3, nowMs: number): void {
    const stats = bot.effectivePrimary;
    if (nowMs < bot.nextShotAllowedAtMs || bot.reloadTimer > 0) return;
    if (bot.ammoInMag[0] <= 0) {
      bot.reloadTimer = stats.reloadEmptySec;
      return;
    }
    this.processPlayerShot(bot, {
      type: "FIRE_SHOT",
      seq: 0,
      origin,
      dir,
      activeSlot: 0,
      ads: true,
      crouching: bot.state.crouching,
      grounded: bot.state.grounded,
      clientTimeMs: nowMs,
    });
  }

  private tryBotUtility(bot: RoomPlayer, eye: Vec3, target: Vec3, now: number): boolean {
    if (this.botDifficulty === "EASY" || this.phase === "WARMUP" ||
      this.tickCounter < bot.nextBotUtilityTick || now < bot.nextShotAllowedAtMs) return false;
    bot.nextBotUtilityTick = this.tickCounter + (this.botDifficulty === "PRO" ? 275 : 480);
    for (const block of this.map.blocks) {
      if (block.material !== "EXPLOSIVE_BARREL" ||
        Math.hypot(block.position.x - target.x, block.position.z - target.z) > 4 ||
        Math.hypot(block.position.x - eye.x, block.position.z - eye.z) < 8 ||
        !this.physWorld.getBlockById(block.id) || this.barrelFuses.has(block.id)) continue;
      const dir = { x: block.position.x - eye.x, y: block.position.y - eye.y, z: block.position.z - eye.z };
      const distance = Math.hypot(dir.x, dir.y, dir.z);
      const aim = { x: dir.x / distance, y: dir.y / distance, z: dir.z / distance };
      if (this.physWorld.castBallisticWorldRay(eye, aim, distance + 0.1, 0).primaryHit?.blockId !== block.id) continue;
      this.tryBotFire(bot, eye, aim, now);
      return true;
    }
    if (bot.throwableStock.frag <= 0) return false;
    const dx = target.x - eye.x;
    const dz = target.z - eye.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 10 || distance > 21) return false;
    this.processThrowGrenade(bot, {
      type: "THROW_GRENADE", throwable: "frag", origin: eye,
      dir: { x: dx / distance, y: (target.y - eye.y) / distance + 0.10, z: dz / distance }, cookElapsedSec: 0,
    });
    return true;
  }

  private processMelee(attacker: RoomPlayer): void {
    const now = Date.now();
    if (!attacker.alive || !isCombatPhase(this.phase) || now < attacker.nextMeleeAt) return;
    attacker.nextMeleeAt = now + MELEE_COOLDOWN_MS;
    attacker.nextShotAllowedAtMs = Math.max(attacker.nextShotAllowedAtMs, now + 300);
    attacker.spawnProtection = 0;
    const eye = getCameraEyePosition(attacker.state);
    const aim = yawPitchToDir({ x: 0, y: 0, z: 1 }, attacker.state.yaw, attacker.state.pitch);
    let nearest: RoomPlayer | undefined;
    let range = MELEE_RANGE;
    for (const other of this.players.values()) {
      if (!other.alive || other.id === attacker.id || other.spawnProtection > 0 ||
        (other.team === attacker.team && !this.matchRules.friendlyFire)) continue;
      const p = other.state.position;
      const delta = { x: p.x - eye.x, y: p.y + (other.state.crouching ? 0.8 : 1.2) - eye.y, z: p.z - eye.z };
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      if (distance >= range || distance < 0.001 ||
        (delta.x * aim.x + delta.y * aim.y + delta.z * aim.z) / distance < 0.62) continue;
      const direction = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
      if (this.physWorld.castBallisticWorldRay(eye, direction, distance, 0).primaryHit) continue;
      nearest = other;
      range = distance;
    }
    if (!nearest) return;
    const dx = eye.x - nearest.state.position.x;
    const dz = eye.z - nearest.state.position.z;
    const facing = (Math.sin(nearest.state.yaw) * dx + Math.cos(nearest.state.yaw) * dz) / Math.max(0.01, Math.hypot(dx, dz));
    this.applyDamageToPlayer(attacker, nearest, facing < -0.62 ? 150 : 48, "CHEST", "knife", 0.8, false, range);
  }

  private processPlayerShot(
    shooter: RoomPlayer,
    msg: Extract<ClientToServerMessage, { type: "FIRE_SHOT" }>
  ): void {
    if (!shooter.alive) return;
    if (!isCombatPhase(this.phase)) return;

    const slot = msg.activeSlot;
    const stats = slot === 0 ? shooter.effectivePrimary : shooter.effectiveSecondary;
    const nowMs = Date.now();

    if (shooter.reloadTimer > 0 && shooter.reloadSlot === slot) return;
    if (nowMs + 25 < shooter.nextShotAllowedAtMs) return; // RPM anti-cheat guard
    if (shooter.ammoInMag[slot] <= 0) return;

    const length = Math.hypot(msg.dir?.x, msg.dir?.y, msg.dir?.z);
    if (!Number.isFinite(length) || length < 0.001 || !Number.isFinite(Math.hypot(msg.origin?.x, msg.origin?.y, msg.origin?.z))) return;
    const forward = { x: msg.dir.x / length, y: msg.dir.y / length, z: msg.dir.z / length };

    shooter.ammoInMag[slot]--;
    shooter.combatStats.shots++;
    shooter.spawnProtection = 0;
    shooter.nextShotAllowedAtMs = nowMs + stats.shotIntervalSec * 1000 * 0.92;
    const firstShot = nowMs - shooter.lastShotAtMs > 350;
    shooter.lastShotAtMs = nowMs;

    const adsInput = typeof msg.adsAlpha === "number" && Number.isFinite(msg.adsAlpha) ? msg.adsAlpha : msg.ads;
    const spread = shooter.isBot
      ? (stats.pellets > 1 ? 0.035 : 0)
      : shotSpreadRadians(
          stats,
          adsInput,
          {
            crouching: shooter.state.crouching,
            grounded: shooter.state.grounded,
            speed: Math.hypot(shooter.state.velocity.x, shooter.state.velocity.z),
          },
          firstShot
        );
    const paths: ShotPath[] = [];
    const hits: HitConfirmation[] = [];
    const targets: ShotTarget[] = [];
    const rewind = shooter.isBot ? 0 : shooter.pingMs / 2 + INTERPOLATION_DELAY_MS;
    for (const target of this.players.values()) {
      if (!target.alive || target.id === shooter.id ||
        (target.team === shooter.team && !this.matchRules.friendlyFire)) continue;
      const hitboxes = this.lagComp.getRewoundHitboxes(target.id, rewind, nowMs) ?? computePlayerHitboxes(target.id, target.state);
      targets.push({ player: target, hitboxes });
    }
    for (let i = 0; i < stats.pellets; i++) {
      const dir = sampleShotCone(forward, spread, Math.random(), Math.random());
      paths.push(stats.blueprint.category === "SNIPER"
        ? this.resolveSniperShot(shooter, stats, msg.origin, dir, targets, hits)
        : this.resolveSingleBallisticRay(shooter, stats, msg.origin, dir, targets, hits).path);
    }
    if (
      paths.some(({ playerId }) => {
        const target = playerId ? this.players.get(playerId) : undefined;
        return target && target.team !== shooter.team && target.spawnProtection <= 0;
      })
    ) {
      shooter.combatStats.shotsHit++;
    }
    this.broadcastJson({ type: "SHOT_FIRED", shooterId: shooter.id, shooterIndex: shooter.playerIndex,
      weaponId: stats.weaponId, suppressed: stats.useSuppressedAudio, origin: msg.origin, seq: msg.seq, paths });
    if (hits.length) {
      const strongest = hits.reduce((best, hit) => HIT_PRIORITY[hit.tier] > HIT_PRIORITY[best.tier] ? hit : best);
      shooter.sender?.sendJson({
        ...strongest,
        damage: hits.reduce((total, hit) => total + hit.damage, 0),
        isHeadshot: hits.some((hit) => hit.tier !== "PROTECTED" && hit.hitZone === "HEAD"),
        isWallbang: hits.some((hit) => hit.isWallbang),
      });
    }
  }

  private resolveSniperShot(shooter: RoomPlayer, stats: EffectiveWeaponStats, origin: Vec3,
    dir: Vec3, targets: readonly ShotTarget[], hits: HitConfirmation[]): ShotPath {
    const bends: Vec3[] = [];
    const surfaces: ShotPath["surfaces"] = [];
    let start = origin;
    let energy = 1;
    const limit = stats.maxRangeMeters;
    for (const boundary of [12, 32, 56, limit]) {
      const distance = Math.min(limit, boundary);
      const fall = 0.00018 * Math.max(0, distance - 12) ** 2;
      const end = { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance - fall, z: origin.z + dir.z * distance };
      const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
      const length = Math.hypot(delta.x, delta.y, delta.z);
      const segment = this.resolveSingleBallisticRay(shooter, stats, start,
        { x: delta.x / length, y: delta.y / length, z: delta.z / length }, targets, hits, length, energy);
      surfaces.push(...segment.path.surfaces);
      if (!segment.continues || distance >= limit) return { ...segment.path, surfaces, bends };
      bends.push(end);
      energy = segment.energy;
      start = end;
    }
    return { end: start, surfaces, bends };
  }

  private resolveSingleBallisticRay(
    shooter: RoomPlayer,
    stats: EffectiveWeaponStats,
    origin: Vec3,
    dir: Vec3,
    targets: readonly ShotTarget[],
    hits: HitConfirmation[],
    range = stats.maxRangeMeters,
    energy = 1
  ): { path: ShotPath; continues: boolean; energy: number } {
    const worldCast = this.physWorld.castBallisticWorldRay(
      origin,
      dir,
      range,
      energy < 1 ? 0 : stats.wallbangPower
    );

    const maxWorldDist = worldCast.penetrationHit
      ? worldCast.penetrationHit.distance
      : worldCast.primaryHit && !worldCast.penetrationExit
        ? worldCast.primaryHit.distance
        : range;

    // Check lag-rewound hitboxes of all opposing alive players
    let bestTarget: RoomPlayer | null = null;
    let bestZone: HitZone = "CHEST";
    let bestDist = maxWorldDist;
    let bestPoint: Vec3 = {
      x: origin.x + dir.x * maxWorldDist,
      y: origin.y + dir.y * maxWorldDist,
      z: origin.z + dir.z * maxWorldDist,
    };

    for (const { player: target, hitboxes } of targets) {
      if (!target.alive) continue;
      const hit = intersectRayHitboxes(origin, dir, bestDist, hitboxes);
      if (hit && hit.distance < bestDist) {
        if (worldCast.primaryHit && hit.distance >= worldCast.primaryHit.distance &&
          (!worldCast.penetrationExit || hit.distance < worldCast.penetrationExit.distance)) continue;
        bestDist = hit.distance;
        bestTarget = target;
        bestZone = hit.hitZone;
        bestPoint = hit.point;
      }
    }

    let practiceTarget: number | undefined;
    if (this.phase === "WARMUP" && !shooter.isBot && Math.abs(dir.z) > 1e-6) {
      for (const [index, target] of this.map.warmupTargets.entries()) {
        const z = target.z - Math.sign(dir.z) * 0.04;
        const distance = (z - origin.z) / dir.z;
        if (distance <= 0 || distance >= Math.min(bestDist, worldCast.primaryHit?.distance ?? Infinity)) continue;
        const x = origin.x + dir.x * distance;
        const y = origin.y + dir.y * distance;
        if (Math.hypot(x - target.x, y - target.y) > PRACTICE_TARGET_RADIUS) continue;
        bestTarget = null;
        bestDist = distance;
        bestPoint = { x, y, z };
        practiceTarget = index;
      }
    }

    const isWallbang = energy < 1 || (
      bestTarget !== null &&
      worldCast.primaryHit !== null &&
      bestDist > worldCast.primaryHit.distance &&
      worldCast.penetrationExit !== undefined);

    // Check destructible prop hit before target
    if (
      worldCast.primaryHit &&
      worldCast.primaryHit.distance <= bestDist
    ) {
      this.damageDestructibleProp(
        worldCast.primaryHit.blockId,
        stats.damageChest,
        shooter
      );
    }

    const surfaces: ShotPath["surfaces"] = [];
    for (const surface of [worldCast.primaryHit, worldCast.penetrationHit]) {
      if (surface && surface.distance <= bestDist) {
        surfaces.push({ point: surface.hitPoint, normal: surface.hitNormal, material: surface.material, blockId: surface.blockId });
      }
    }

    if (bestTarget) {
      if (bestTarget.spawnProtection > 0) {
        hits.push({
          type: "HIT_CONFIRM",
          tier: "PROTECTED",
          damage: 0,
          victimName: bestTarget.callsign,
          hitZone: bestZone,
          isHeadshot: false,
          isWallbang,
        });
      } else {
        const baseDmg =
          bestZone === "HEAD"
            ? stats.damageHead
            : bestZone === "CHEST"
              ? stats.damageChest
              : stats.damageLimb;
        const wbMult = (isWallbang ? worldCast.penetrationExit?.damageMultiplier ?? 1.0 : 1.0) * energy;
        const dist = Math.hypot(
          bestTarget.state.position.x - shooter.state.position.x,
          bestTarget.state.position.z - shooter.state.position.z
        );

        this.applyDamageToPlayer(
          shooter,
          bestTarget,
          Math.round(baseDmg * wbMult),
          bestZone,
          stats.weaponId,
          stats.armorPenetration,
          isWallbang,
          dist,
          hits
        );
      }
    }
    return {
      path: { end: bestPoint, surfaces, playerId: bestTarget?.id, practiceTarget },
      continues: !bestTarget && practiceTarget === undefined && maxWorldDist >= range - 1e-6,
      energy: energy * (worldCast.penetrationExit?.damageMultiplier ?? 1),
    };
  }

  private damageDestructibleProp(blockId: string, damage: number, shooter: RoomPlayer, fuseSec = BARREL_FUSE_SEC): void {
    const meta = this.physWorld.getBlockById(blockId);
    if (!meta || !meta.destructible) return;
    // A barrel that is already burning towards detonation cannot be damaged further.
    if (this.barrelFuses.has(blockId)) return;
    meta.hp -= damage;

    if (meta.material === "EXPLOSIVE_BARREL") {
      const hpFraction = Math.max(0, meta.hp / meta.maxHp);
      this.broadcastJson({
        type: "PROP_DAMAGED",
        blockId,
        material: meta.material,
        position: meta.spec.position,
        hpFraction,
      });
      // Barrels ignite first and blow up after a short fuse (gives chain reactions a readable rhythm).
      if (meta.hp <= 0) this.barrelFuses.set(blockId, { timer: fuseSec, attacker: shooter });
      return;
    }
    if (meta.hp > 0) return;

    const destroyed = this.physWorld.destroyBlock(blockId);
    if (!destroyed) return;

    this.broadcastJson({
      type: "PROP_DESTROYED",
      blockId,
      material: destroyed.material,
      position: destroyed.spec.position,
    });
  }

  private stepBarrelFuses(dt: number): void {
    for (const [blockId, fuse] of this.barrelFuses) {
      fuse.timer -= dt;
      if (fuse.timer > 0) continue;
      this.barrelFuses.delete(blockId);
      this.detonateBarrel(blockId, fuse.attacker);
    }
  }

  private detonateBarrel(blockId: string, attacker: RoomPlayer): void {
    const destroyed = this.physWorld.destroyBlock(blockId);
    if (!destroyed) return;
    this.broadcastJson({
      type: "PROP_DESTROYED",
      blockId,
      material: destroyed.material,
      position: destroyed.spec.position,
    });
    const center = { ...destroyed.spec.position, y: destroyed.spec.position.y + 0.3 };
    this.applyRadialExplosion(center, BARREL_BLAST_RADIUS, BARREL_BLAST_DAMAGE, attacker, "barrel");
  }

  /** Explosions chip away at (and chain-ignite) nearby destructible props such as barrels and glass. */
  private damageDestructiblesInRadius(center: Vec3, radius: number, maxDmg: number, attacker: RoomPlayer): void {
    for (const block of this.map.blocks) {
      if (!block.destructible) continue;
      if (!this.physWorld.getBlockById(block.id)) continue;
      const dist = Math.hypot(block.position.x - center.x, block.position.y - center.y, block.position.z - center.z);
      if (dist > radius) continue;
      const dmg = Math.max(1, Math.round(maxDmg * (1 - dist / radius)));
      // Farther barrels cook off slightly later, so a row of barrels pops in sequence.
      this.damageDestructibleProp(block.id, dmg, attacker, BARREL_FUSE_SEC + dist * 0.04);
    }
  }

  private applyDamageToPlayer(
    attacker: RoomPlayer,
    victim: RoomPlayer,
    rawDamage: number,
    hitZone: HitZone,
    weaponId: string,
    armorPen: number,
    isWallbang: boolean,
    distanceM: number,
    shotHits?: HitConfirmation[]
  ): void {
    if (!victim.alive || rawDamage <= 0 || victim.spawnProtection > 0 || !isCombatPhase(this.phase)) return;
    const live = this.phase === "LIVE";
    const enemyHit = attacker.team !== victim.team;
    if (!enemyHit && attacker.id !== victim.id && !this.matchRules.friendlyFire) return;

    const prevArmor = victim.armor;
    let hpDamage = rawDamage;
    if (victim.armor > 0 && hitZone !== "HEAD") {
      const absorb = Math.min(victim.armor, Math.round(rawDamage * ARMOR_ABSORB_RATIO * (1 - armorPen * 0.45)));
      victim.armor -= absorb;
      hpDamage = Math.max(1, rawDamage - absorb);
    }

    const applied = Math.min(victim.hp, hpDamage);
    victim.hp = Math.max(0, victim.hp - hpDamage);
    victim.healingDelay = HEAL_DELAY_SEC;
    if (enemyHit) attacker.combatStats.damage += applied;
    const armorBroken = prevArmor > 0 && victim.armor <= 0;
    const killed = victim.hp <= 0;

    attacker.ledger.dealtTotal += hpDamage;
    attacker.ledger.dealtHits++;
    if (hitZone === "HEAD") attacker.ledger.dealtHeadshots++;

    victim.ledger.takenTotal += hpDamage;
    victim.ledger.takenHits++;
    if (hitZone === "HEAD") victim.ledger.takenHeadshots++;

    const tier: HitMarkerTier = killed
      ? "KILL"
      : hitZone === "HEAD"
        ? "HEADSHOT"
        : armorBroken
          ? "ARMOR_BREAK"
          : "BODY";

    const confirm: HitConfirmation = {
      type: "HIT_CONFIRM",
      tier,
      damage: hpDamage,
      victimName: victim.callsign,
      hitZone,
      isWallbang,
    };
    if (enemyHit) {
      if (shotHits) shotHits.push(confirm);
      else attacker.sender?.sendJson(confirm);
    }

    victim.sender?.sendJson({
      type: "DAMAGE_TAKEN",
      attackerPosition: attacker.state.position,
      damage: hpDamage,
      armorRemaining: victim.armor,
      hpRemaining: victim.hp,
      isHeadshot: hitZone === "HEAD",
    });

    if (killed) {
      victim.alive = false;
      victim.inputQueue.length = 0;
      victim.deaths++;
      victim.streak = 0;
      victim.multikill = 0;
      victim.lastKillAt = -Infinity;
      if (enemyHit) {
        attacker.kills++;
        if (hitZone === "HEAD") attacker.combatStats.headshotKills++;
        attacker.streak++;
        attacker.combatStats.longestStreak = Math.max(attacker.combatStats.longestStreak, attacker.streak);
        const now = Date.now();
        attacker.multikill = now - attacker.lastKillAt <= 4200 ? attacker.multikill + 1 : 1;
        attacker.lastKillAt = now;
        if (attacker.multikill >= 2 || attacker.streak % 5 === 0) {
          attacker.sender?.sendJson({ type: "COMBAT_STREAK", run: attacker.streak, multi: attacker.multikill });
        }
        if (victim.sender) {
          const frames = this.replay.capture(attacker, victim);
          if (frames.length) victim.sender.sendJson({ type: "DEATH_REPLAY", killerId: attacker.id, killerName: attacker.callsign, frames });
        }
      }
      victim.respawnTimer = live ? RESPAWN_SEC : 1.8;
      if (live && attacker.team !== victim.team) {
        if (attacker.team === "A") this.scoreA++;
        else this.scoreB++;
      }

      victim.ledger.killerName = attacker.callsign;
      victim.ledger.killerWeaponId = weaponId;
      victim.ledger.killerHpLeft = attacker.hp;
      victim.ledger.distanceM = Math.round(distanceM);

      const scoreLimit = this.matchRules.scoreLimit;
      const isMatchWinningKill = live && scoreLimit > 0 && (this.scoreA >= scoreLimit || this.scoreB >= scoreLimit);

      this.broadcastJson({
        type: "KILL_FEED",
        killerName: attacker.callsign,
        killerTeam: attacker.team,
        victimName: victim.callsign,
        victimTeam: victim.team,
        weaponId,
        isHeadshot: hitZone === "HEAD",
        isWallbang,
        distanceM: Math.round(distanceM),
        isMatchWinningKill,
        killerHpLeft: attacker.hp,
        streak: enemyHit ? attacker.streak : 0,
        multi: enemyHit ? attacker.multikill : 0,
      });

      victim.sender?.sendJson({
        type: "DAMAGE_BREAKDOWN",
        breakdown: { ...victim.ledger },
      });

      if (live) {
        if (isMatchWinningKill) this.finishMatch("Kill limit reached");
        else this.broadcastRoomState();
      }
    }
  }

  private processThrowGrenade(
    thrower: RoomPlayer,
    msg: Extract<ClientToServerMessage, { type: "THROW_GRENADE" }>
  ): void {
    const usesStock = this.mode !== "WARMUP";
    if (!thrower.alive || (msg.movementEpoch !== undefined && msg.movementEpoch !== thrower.movementEpoch)) return;
    if (!isCombatPhase(this.phase)) return;
    if (!THROWABLE_ORDER.includes(msg.throwable)) return;
    const spec = THROWABLE_REGISTRY[msg.throwable];
    if (usesStock ? thrower.throwableStock[spec.id] <= 0 : thrower.throwablesLeft <= 0) return;
    const length = Math.hypot(msg.dir?.x, msg.dir?.y, msg.dir?.z);
    const eye = getCameraEyePosition(thrower.state);
    const eyeDistance = Math.hypot(msg.origin?.x - eye.x, msg.origin?.y - eye.y, msg.origin?.z - eye.z);
    if (!Number.isFinite(length) || length < 0.001 || !Number.isFinite(eyeDistance) || !Number.isFinite(msg.cookElapsedSec)) return;
    if (usesStock && (eyeDistance > 2 || !this.physWorld.hasLineOfSight(eye, msg.origin))) return;

    if (usesStock) thrower.throwableStock[spec.id]--;
    else thrower.throwablesLeft--;
    thrower.spawnProtection = 0;

    const id = `gren_${this.nextThrowableId++}`;
    const cookElapsed = !usesStock && spec.cookable ? Math.max(0, msg.cookElapsedSec) : 0;
    const fuseRemaining = Math.max(0.15, spec.fuseSec - cookElapsed);
    const velocity = {
      x: msg.dir.x / length * spec.throwSpeed,
      y: msg.dir.y / length * spec.throwSpeed + 2.8,
      z: msg.dir.z / length * spec.throwSpeed,
    };

    const g: ActiveThrowable = {
      id,
      throwable: spec.id,
      ownerId: thrower.id,
      ownerName: thrower.callsign,
      ownerTeam: thrower.team,
      position: { ...msg.origin },
      velocity,
      fuseRemaining,
      detonated: false,
      smokeTimer: spec.durationSec,
    };
    this.throwables.push(g);

    this.broadcastJson({
      type: "THROWABLE_SPAWNED",
      id,
      throwable: spec.id,
      ownerTeam: thrower.team,
      position: g.position,
      velocity: g.velocity,
      fuseRemainingSec: fuseRemaining,
    });
  }

  private stepThrowables(dt: number): void {
    for (let i = this.throwables.length - 1; i >= 0; i--) {
      const t = this.throwables[i];
      if (!t.detonated) {
        this.physWorld.stepThrowable(t.position, t.velocity, THROWABLE_REGISTRY[t.throwable].restitution, dt);

        t.fuseRemaining -= dt;
        if (t.fuseRemaining <= 0) {
          this.detonateThrowable(t);
          if (this.phase === "MATCH_END") return;
        }
      } else if (t.throwable === "smoke") {
        t.smokeTimer -= dt;
        if (t.smokeTimer <= 0) {
          this.throwables.splice(i, 1);
        }
      } else {
        this.throwables.splice(i, 1);
      }
    }
  }

  private detonateThrowable(t: ActiveThrowable): void {
    t.detonated = true;
    const spec = THROWABLE_REGISTRY[t.throwable];
    this.broadcastJson({
      type: "THROWABLE_DETONATED",
      id: t.id,
      throwable: t.throwable,
      position: t.position,
      durationSec: spec.durationSec,
      radius: spec.effectRadius,
    });

    const owner = this.players.get(t.ownerId);

    if (t.throwable === "frag" && owner) {
      this.applyRadialExplosion(t.position, spec.effectRadius, spec.maxDamage, owner, "frag");
    } else if (t.throwable === "flashbang") {
      for (const p of this.players.values()) {
        if (!p.alive || p.spawnProtection > 0) continue;
        if (!this.matchRules.friendlyFire && p.team === t.ownerTeam && p.id !== t.ownerId) continue;
        const eye = getCameraEyePosition(p.state);
        const dx = t.position.x - eye.x;
        const dy = t.position.y - eye.y;
        const dz = t.position.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > spec.effectRadius) continue;
        if (!this.physWorld.hasLineOfSight(eye, t.position)) continue;

        const lookX = Math.sin(p.state.yaw) * Math.cos(p.state.pitch);
        const lookY = Math.sin(p.state.pitch);
        const lookZ = Math.cos(p.state.yaw) * Math.cos(p.state.pitch);
        const dot = (dx * lookX + dy * lookY + dz * lookZ) / Math.max(0.01, dist);
        const viewFactor = dot > 0.25 ? 1.0 : 0.35;
        const distFactor = 1 - dist / spec.effectRadius;
        const intensity = Math.min(1, viewFactor * distFactor * 1.15);
        if (intensity > 0.12) {
          p.sender?.sendJson({
            type: "FLASHED",
            intensity,
            durationSec: spec.durationSec * intensity,
          });
        }
      }
    }
  }

  private applyRadialExplosion(
    center: Vec3,
    radius: number,
    maxDmg: number,
    attacker: RoomPlayer,
    weaponId: string
  ): void {
    this.damageDestructiblesInRadius(center, radius, maxDmg, attacker);
    for (const target of this.players.values()) {
      if (!target.alive) continue;
      const dist = Math.hypot(
        target.state.position.x - center.x,
        target.state.position.y + 0.9 - center.y,
        target.state.position.z - center.z
      );
      if (dist > radius) continue;
      if (!this.physWorld.hasLineOfSight(center, getCameraEyePosition(target.state))) continue;
      const dmg = Math.round(maxDmg * (1 - dist / radius));
      if (dmg > 0) {
        this.applyDamageToPlayer(attacker, target, dmg, "CHEST", weaponId, 0.4, false, dist);
      }
    }
  }

  private stepMatchClock(dt: number): void {
    if (this.phase === "WARMUP") {
      // AFK Host auto-start rule for full public rooms
      const cfg = MODE_CONFIGS[this.mode];
      if (this.isPublic && this.players.size >= cfg.maxPlayers && this.mode !== "WARMUP") {
        this.afkFullTimerSec += dt;
        if (this.afkFullTimerSec >= 45) {
          this.afkFullTimerSec = 0;
          this.beginMatch();
        }
      } else {
        this.afkFullTimerSec = 0;
      }
      return;
    }

    if (this.phase === "COUNTDOWN") {
      this.phaseTimerSec -= dt;
      if (this.phaseTimerSec <= 0) {
        this.phase = "LIVE";
        this.matchElapsedSec = 0;
        this.phaseTimerSec = this.matchRules.timeLimitSeconds;
        this.broadcastRoomState();
      }
      return;
    }

    if (this.phase === "LIVE") {
      this.matchElapsedSec += dt;
      if (this.matchRules.timeLimitSeconds > 0) {
        this.phaseTimerSec -= dt;
        if (this.phaseTimerSec <= 1e-6) this.finishMatch("Time expired");
      }
      return;
    }

    if (this.phase === "MATCH_END") {
      this.phaseTimerSec -= dt;
      if (this.phaseTimerSec <= 0) this.finishMatchEndVotes();
    }
  }

  private enterMatchEnd(winner?: TeamId | "DRAW"): void {
    this.phase = "MATCH_END";
    this.phaseTimerSec = 10;
    this.mapVotes.clear();
    const otherMaps = MAP_LIST.map((m) => m.id).filter((id) => id !== this.mapId);
    this.mapVoteOptions = this.matchRules.ranked ? [] : [this.mapId, otherMaps[0] ?? this.mapId];
    this.broadcastMatchResults(winner);
    this.broadcastRoomState();
  }

  private broadcastMatchResults(winner?: TeamId | "DRAW"): void {
    const winnerTeam = winner ?? (this.scoreA === this.scoreB ? "DRAW" : this.scoreA > this.scoreB ? "A" : "B");
    const ratingChanges = this.matchRules.ranked ? this.rankings?.record(this.rankedLineup, winnerTeam,
      new Set(Array.from(this.players.values()).filter((p) => p.sender).map((p) => p.guestUuid))) : undefined;
    const players: MatchResultPlayer[] = Array.from(this.players.values(), (p) => ({
      id: p.id, callsign: p.callsign, team: p.team, kills: p.kills, deaths: p.deaths, combatStats: p.combatStats,
      xpEarned: p.isBot || p.combatStats.shots + p.kills === 0 ? 0 : 40 + p.kills * 8 + (p.team === winnerTeam ? 35 : 0),
      rating: ratingChanges ? this.rankings?.ratingOf(p.guestUuid) : undefined,
      ratingChange: ratingChanges?.get(p.guestUuid),
    }));
    const mvp = players.filter((p) => p.kills > 0 || p.combatStats.damage > 0)
      .sort((a, b) => b.kills - a.kills || b.combatStats.damage - a.combatStats.damage || a.deaths - b.deaths)[0];
    this.broadcastJson({ type: "MATCH_RESULTS", winnerTeam, mvpId: mvp?.id, players });
  }

  private finishMatch(reason: string, winner?: TeamId): void {
    if (this.phase === "MATCH_END") return;
    const winnerTeam = winner ?? (this.scoreA === this.scoreB ? "DRAW" : this.scoreA > this.scoreB ? "A" : "B");
    this.broadcastJson({ type: "MATCH_ENDED", winnerTeam, reason });
    this.enterMatchEnd(winnerTeam);
  }

  private finishMatchEndVotes(): void {
    if (this.matchRules.ranked) {
      if (this.rankedRosterReady()) this.beginMatch();
      else {
        this.phase = "WARMUP";
        this.phaseTimerSec = 0;
        this.scoreA = this.scoreB = 0;
        this.resetPlayersToSpawns();
        this.broadcastRoomState();
      }
      return;
    }
    const counts: Record<string, number> = {};
    for (const m of this.mapVoteOptions) counts[m] = 0;
    for (const m of this.mapVotes.values()) counts[m] = (counts[m] ?? 0) + 1;

    let bestMap = this.mapId;
    let bestCount = -1;
    for (const [m, c] of Object.entries(counts)) {
      if (c > bestCount) {
        bestCount = c;
        bestMap = m;
      }
    }
    if (bestMap !== this.mapId && MAP_REGISTRY[bestMap]) {
      this.mapId = bestMap;
      this.map = MAP_REGISTRY[bestMap];
      this.rebuildWorldForMap();
    }
    this.beginMatch();
  }

  private broadcastBinarySnapshot(nowMs: number): void {
    const list: BinaryPlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      list.push({
        playerIndex: p.playerIndex,
        x: p.state.position.x,
        y: p.state.position.y,
        z: p.state.position.z,
        yaw: p.state.yaw,
        pitch: p.state.pitch,
        lean: p.state.lean,
        crouching: p.state.crouching,
        sliding: p.state.sliding,
        alive: p.alive,
        ads: (p.latestInput.flags & INPUT_FLAG_ADS) !== 0,
        isBot: p.isBot,
        vaulting: p.state.vaulting,
        grounded: p.state.grounded,
        activeSlot: p.latestInput.activeSlot,
        hp: p.hp,
        armor: p.armor,
        vx: p.state.velocity.x,
        vz: p.state.velocity.z,
      });
    }
    const buf = encodeWorldSnapshotBinary(nowMs, list);
    for (const p of this.players.values()) {
      if (!p.sender) continue;
      p.sender.sendBinary(buf);
      this.sendLocalState(p.id);
    }
  }

  public sendLocalState(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player?.sender) return;
    player.sender.sendJson({
      type: "LOCAL_STATE",
      serverTick: this.tickCounter,
      movementEpoch: player.movementEpoch,
      inputAck: player.latestInput.seq,
      shotAck: player.lastShotSeq,
      movement: player.state,
      alive: player.alive,
      hp: player.hp,
      armor: player.armor,
      respawnSeconds: player.respawnTimer,
      ...(this.mode !== "WARMUP" ? {
        throwableStock: { ...player.throwableStock },
        spawnProtectionSeconds: player.spawnProtection,
      } : {}),
      healingDelaySeconds: isCombatPhase(this.phase) ? player.healingDelay : undefined,
      ammoInMag: player.ammoInMag,
      ammoReserve: player.ammoReserve,
      reloadSeconds: player.reloadTimer,
      activeSlot: player.latestInput.activeSlot,
    });
  }

  public getRoomStateBroadcast(): RoomStateBroadcast {
    const mapVotesRecord: Record<string, number> = {};
    for (const m of this.mapVoteOptions) mapVotesRecord[m] = 0;
    for (const m of this.mapVotes.values()) mapVotesRecord[m] = (mapVotesRecord[m] ?? 0) + 1;

    const players: RoomPlayerSummary[] = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      playerIndex: p.playerIndex,
      callsign: p.callsign,
      team: p.team,
      isHost: p.isHost,
      isBot: p.isBot,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      alive: p.alive,
      hp: p.hp,
      armor: p.armor,
      loadout: p.loadout,
      combatStats: p.combatStats,
      rating: this.matchRules.ranked ? this.rankings?.ratingOf(p.guestUuid) : undefined,
    }));

    return {
      code: this.code,
      isPublic: this.isPublic,
      mode: this.mode,
      mapId: this.mapId,
      phase: this.phase,
      timeRemainingSec: this.timeRemainingSec(),
      elapsedSec: Math.floor(this.matchElapsedSec),
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      botFill: this.botFill,
      botDifficulty: this.botDifficulty,
      matchRules: this.matchRules,
      pickups: this.pickups.snapshot(),
      players,
      mapVoteOptions: this.phase === "MATCH_END" ? this.mapVoteOptions : undefined,
      mapVotes: this.phase === "MATCH_END" ? mapVotesRecord : undefined,
    };
  }

  private broadcastRoomState(): void {
    this.broadcastJson({ type: "ROOM_STATE", room: this.getRoomStateBroadcast() });
  }

  private broadcastJson(msg: ServerToClientMessage): void {
    for (const p of this.players.values()) {
      p.sender?.sendJson(msg);
    }
  }
}
