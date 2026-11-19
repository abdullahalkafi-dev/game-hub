import {
  FIXED_DT,
  LIVERY_LIST,
  MAX_ACCUMULATOR_SEC,
  NET_TICK_INTERVAL_MS,
  RACE_MODE_CONFIGS,
  RACING_PROTOCOL_VERSION,
  RECONNECT_GRACE_SEC,
  RIM_LIST,
  SPOILER_LIST,
  TRACK_LIST,
  TUNE_LIST,
  UNDERGLOW_LIST,
  VEHICLE_LIST,
  computeEffectiveVehicleStats,
  createEmptyRaceInput,
  createInitialVehicleState,
  defaultCarSetup,
  getTrackBlueprint,
  isTrackId,
  sanitizeCarSetup,
  stepVehiclePhysics,
  vehicleStateToSnapshot,
  type BotDifficulty,
  type CarSetupConfig,
  type EffectiveVehicleStats,
  type RaceCarSnapshot,
  type RaceClientToServerMessage,
  type RaceInputCommand,
  type RaceMode,
  type RacePhase,
  type RacePlayerSummary,
  type RacePodiumEntry,
  type RacePublicRoomSummary,
  type RaceRoomStateBroadcast,
  type RaceServerToClientMessage,
  type RivalDraftSample,
  type TrackBlueprint,
  type TrackId,
  type VehiclePhysicsState,
} from "@game/shared";
import { createRaceBotMemory, stepRaceBotAi, type RaceBotMemory } from "./RaceBotAi.js";

export interface RaceClientSender {
  sendJson: (msg: RaceServerToClientMessage) => void;
}

interface RaceParticipant {
  id: string;
  guestUuid: string;
  playerIndex: number;
  callsign: string;
  isHost: boolean;
  isBot: boolean;
  connected: boolean;
  ready: boolean;
  sender?: RaceClientSender;
  gridSlot: number;
  setup: CarSetupConfig;
  stats: EffectiveVehicleStats;
  state: VehiclePhysicsState;
  inputQueue: RaceInputCommand[];
  latestInput: RaceInputCommand;
  lastQueuedSeq: number;
  lastProcessedSeq: number;
  inputIdleSec: number;
  position: number;
  pingMs: number;
  botMemory?: RaceBotMemory;
}

const BOT_CALLSIGNS = [
  "Takumi_86",
  "Valkyrie_GT",
  "Kuro_Drift",
  "Apex_Viper",
  "Sora_R34",
  "Maverick_RS",
  "Nitro_Kai",
  "Shiro_Turbo",
];

const COUNTDOWN_TOTAL_SEC = 3.5;
const GRID_READY_TIMEOUT_SEC = 25;
const FINISH_GRACE_SEC = 45;
const DRIFT_RUN_SEC = 120;
const CIRCUIT_RACE_LIMIT_SEC = 360;
const INPUT_HOLD_SEC = 0.25;
const PODIUM_AUTO_REMATCH_SEC = 18.0;
const MAX_INPUT_QUEUE = 64;

export class RaceRoom {
  public readonly code: string;
  public isPublic: boolean;
  public mode: RaceMode;
  public trackId: TrackId;
  public botFill: boolean;
  public botDifficulty: BotDifficulty;

  private track: TrackBlueprint;
  private readonly participants = new Map<string, RaceParticipant>();
  private readonly pendingReconnects = new Map<
    string,
    { participant: RaceParticipant; timeout: ReturnType<typeof setTimeout> }
  >();

  private phase: RacePhase = "LOBBY";
  private gridRevision = 1;
  private readyRemainingSec: number | null = null;
  private readyWaitExpired = false;
  private countdownRemainingSec = 0;
  private lastCountdownAnnounced = 4;
  private raceElapsedMs = 0;
  private finishGraceRemainingSec: number | null = null;
  private podiumAutoRematchSec = 0;
  private podium: RacePodiumEntry[] = [];
  private trackVotes = new Map<string, TrackId>();

  private nextPlayerIndex = 1;
  private serverTick = 0;
  private lastSnapshotBroadcastMs = 0;
  private lastRoomStateBroadcastMs = 0;
  private lastWallMs = 0;
  private accumulatorSec = 0;
  private loopHandle: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private onEmptyCallback?: (code: string) => void;

  constructor(opts: {
    code: string;
    isPublic: boolean;
    mode: RaceMode;
    trackId: TrackId;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
    onEmpty?: (code: string) => void;
  }) {
    this.code = opts.code;
    this.isPublic = opts.isPublic;
    this.mode = opts.mode in RACE_MODE_CONFIGS ? opts.mode : "GRAND_PRIX";
    this.trackId = isTrackId(opts.trackId) ? opts.trackId : "tokyo_midnight";
    this.track = getTrackBlueprint(this.trackId);
    this.botFill = opts.botFill;
    if (this.mode === "TIME_TRIAL") {
      this.isPublic = false;
      this.botFill = false;
    }
    this.botDifficulty =
      opts.botDifficulty === "EASY" || opts.botDifficulty === "PRO" ? opts.botDifficulty : "NORMAL";
    this.onEmptyCallback = opts.onEmpty;
  }

  public get maxPlayers(): number {
    return RACE_MODE_CONFIGS[this.mode].maxPlayers;
  }

  public get totalLaps(): number {
    if (this.mode === "TIME_TRIAL") return 1;
    return this.mode === "DRIFT_ATTACK" ? Math.min(2, this.track.laps) : this.track.laps;
  }

  private get raceLimitSec(): number {
    return this.mode === "DRIFT_ATTACK" ? DRIFT_RUN_SEC : CIRCUIT_RACE_LIMIT_SEC;
  }

  private get canRestartPractice(): boolean {
    return this.mode === "TIME_TRIAL" && this.phase === "RACING";
  }

  public startLoop(): void {
    if (this.stopped || this.loopHandle) return;
    this.lastWallMs = performance.now();
    this.accumulatorSec = 0;
    this.loopHandle = setInterval(() => {
      const now = performance.now();
      const elapsedSec = Math.min(Math.max(0, (now - this.lastWallMs) / 1000), MAX_ACCUMULATOR_SEC);
      this.lastWallMs = now;
      this.accumulatorSec += elapsedSec;

      let steps = 0;
      while (this.accumulatorSec >= FIXED_DT && steps < 6) {
        this.stepSimulation(FIXED_DT, now);
        this.accumulatorSec -= FIXED_DT;
        steps++;
      }
      if (this.accumulatorSec > FIXED_DT * 4) {
        this.accumulatorSec = 0;
      }
    }, 8);
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
    for (const pending of this.pendingReconnects.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingReconnects.clear();
  }

  public canJoin(guestUuid?: string): boolean {
    if (guestUuid && this.pendingReconnects.has(guestUuid)) return true;
    const humans = this.getHumanParticipants();
    if (guestUuid && humans.some((p) => p.connected && p.guestUuid === guestUuid)) return true;
    return this.phase === "LOBBY" && humans.length < this.maxPlayers;
  }

  public getHumanParticipants(): RaceParticipant[] {
    return Array.from(this.participants.values()).filter((p) => !p.isBot);
  }

  public getSummary(): RacePublicRoomSummary {
    const all = Array.from(this.participants.values());
    const humans = all.filter((p) => !p.isBot && p.connected).length;
    return {
      code: this.code,
      mode: this.mode,
      trackId: this.trackId,
      phase: this.phase,
      humanCount: humans,
      playerCount: all.length,
      maxPlayers: this.maxPlayers,
      botFill: this.botFill,
      botDifficulty: this.botDifficulty,
    };
  }

  public addOrReconnectPlayer(opts: {
    guestUuid: string;
    callsign: string;
    setup?: Partial<CarSetupConfig>;
    sender: RaceClientSender;
    autoStart?: boolean;
  }): { participant: RaceParticipant; reconnected: boolean } {
    const cleanCallsign = (opts.callsign || "Racer").trim().slice(0, 18) || "Racer";
    const setup = sanitizeCarSetup(opts.setup);

    // 1. Reconnect grace match
    const pending = this.pendingReconnects.get(opts.guestUuid);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingReconnects.delete(opts.guestUuid);
      const p = pending.participant;
      p.connected = true;
      p.sender = opts.sender;
      p.callsign = cleanCallsign;
      p.ready = false;
      this.clearInput(p, true);
      this.ensureHostAssigned();
      this.broadcastRoomState(p.id);
      return { participant: p, reconnected: true };
    }

    // 2. Duplicate tab / existing active guestUuid
    for (const existing of this.participants.values()) {
      if (!existing.isBot && existing.connected && existing.guestUuid === opts.guestUuid) {
        existing.sender = opts.sender;
        existing.callsign = cleanCallsign;
        existing.ready = false;
        this.clearInput(existing, true);
        this.broadcastRoomState(existing.id);
        return { participant: existing, reconnected: true };
      }
    }

    if (!this.canJoin()) throw new Error("The grid is locked. Join another lobby for a fresh start.");

    // 3. Evict one AI bot if room is full with bots
    if (this.participants.size >= this.maxPlayers) {
      const botToReplace = Array.from(this.participants.values())
        .reverse()
        .find((p) => p.isBot);
      if (botToReplace) {
        this.participants.delete(botToReplace.id);
      }
    }

    const humanCountBefore = this.getHumanParticipants().length;
    const gridSlot = this.findFreeGridSlot();
    const stats = computeEffectiveVehicleStats(setup.vehicleId, setup.tuneId);
    const id = `racer_${this.nextPlayerIndex}`;
    const participant: RaceParticipant = {
      id,
      guestUuid: opts.guestUuid,
      playerIndex: this.nextPlayerIndex++,
      callsign: cleanCallsign,
      isHost: humanCountBefore === 0,
      isBot: false,
      connected: true,
      ready: false,
      sender: opts.sender,
      gridSlot,
      setup,
      stats,
      state: createInitialVehicleState(this.track, gridSlot, stats),
      inputQueue: [],
      latestInput: createEmptyRaceInput(0),
      lastQueuedSeq: 0,
      lastProcessedSeq: 0,
      inputIdleSec: 0,
      position: gridSlot + 1,
      pingMs: 0,
    };

    this.participants.set(id, participant);
    this.syncBotsToGrid();

    // New solo and quick-play grids start as soon as their drivers are ready.
    const shouldAutoStart =
      this.phase === "LOBBY" &&
      (opts.autoStart === true || this.mode === "TIME_TRIAL" || this.botFill || this.getHumanParticipants().length >= 2);
    if (shouldAutoStart) {
      this.requestRaceStart();
    } else {
      this.updateLiveRankings();
      this.broadcastRoomState(id);
      this.broadcastSnapshot(performance.now(), id);
    }

    return { participant, reconnected: false };
  }

  public sendInitialSnapshot(playerId: string): void {
    const p = this.participants.get(playerId);
    if (p) {
      this.sendSnapshotToParticipant(p, performance.now());
    }
  }

  public recordRoundTripTime(playerId: string, rttMs: number): void {
    const p = this.participants.get(playerId);
    if (p) {
      p.pingMs = Math.max(0, Math.round(rttMs));
    }
  }

  public handleDisconnect(playerId: string, sender?: RaceClientSender): void {
    if (this.stopped) return;
    const p = this.participants.get(playerId);
    if (!p || p.isBot || !p.connected || (sender && p.sender !== sender)) return;

    p.connected = false;
    p.sender = undefined;
    p.ready = false;
    this.clearInput(p);

    if (p.isHost) {
      p.isHost = false;
      this.ensureHostAssigned();
    }

    const existingPending = this.pendingReconnects.get(p.guestUuid);
    if (existingPending) clearTimeout(existingPending.timeout);

    const timeout = setTimeout(() => {
      if (this.stopped) return;
      this.pendingReconnects.delete(p.guestUuid);
      if (this.phase === "LOBBY") {
        this.participants.delete(p.id);
        this.syncBotsToGrid();
      }
      this.trackVotes.delete(p.id);
      this.ensureHostAssigned();
      this.checkEmptyAndCleanup();
      if (!this.stopped) {
        this.tryStartReadyGrid();
        this.broadcastRoomState();
      }
    }, RECONNECT_GRACE_SEC * 1000);

    this.pendingReconnects.set(p.guestUuid, { participant: p, timeout });
    this.broadcastRoomState();
  }

  public handleClientMessage(playerId: string, msg: RaceClientToServerMessage, sender?: RaceClientSender): void {
    const p = this.participants.get(playerId);
    if (!p?.connected || (sender && p.sender !== sender)) return;

    switch (msg.type) {
      case "RACE_PING": {
        p.sender?.sendJson({
          type: "RACE_PONG",
          t0: msg.t0,
          serverTimeMs: performance.now(),
        });
        return;
      }

      case "RACE_SET_SETUP": {
        if (this.phase !== "LOBBY") return;
        this.applySetup(p, sanitizeCarSetup(msg.setup));
        this.broadcastRoomState();
        return;
      }

      case "RACE_UPDATE_SETTINGS": {
        if (!p.isHost || this.phase !== "LOBBY") return;
        let trackOrModeChanged = false;
        if (msg.trackId && isTrackId(msg.trackId) && msg.trackId !== this.trackId) {
          this.trackId = msg.trackId;
          this.track = getTrackBlueprint(this.trackId);
          trackOrModeChanged = true;
        }
        if (this.mode !== "TIME_TRIAL" && msg.mode && msg.mode !== "TIME_TRIAL" &&
            Object.hasOwn(RACE_MODE_CONFIGS, msg.mode) && msg.mode !== this.mode &&
            this.getHumanParticipants().length <= RACE_MODE_CONFIGS[msg.mode].maxPlayers) {
          this.mode = msg.mode;
          trackOrModeChanged = true;
        }
        if (this.mode !== "TIME_TRIAL" && typeof msg.botFill === "boolean" && msg.botFill !== this.botFill) {
          this.botFill = msg.botFill;
          this.syncBotsToGrid();
        }
        if (msg.botDifficulty === "EASY" || msg.botDifficulty === "NORMAL" || msg.botDifficulty === "PRO") {
          this.botDifficulty = msg.botDifficulty;
          for (const part of this.participants.values()) {
            if (part.isBot) {
              part.botMemory = createRaceBotMemory(part.gridSlot, this.botDifficulty);
            }
          }
        }
        if (this.mode !== "TIME_TRIAL" && typeof msg.isPublic === "boolean") {
          this.isPublic = msg.isPublic;
        }

        if (trackOrModeChanged) {
          const startPending = this.readyRemainingSec !== null;
          this.prepareGrid(startPending);
        } else {
          this.broadcastRoomState();
        }
        return;
      }

      case "RACE_START": {
        if (p.isHost && this.phase === "LOBBY") this.requestRaceStart();
        return;
      }

      case "RACE_READY": {
        if (this.phase !== "LOBBY" || msg.gridRevision !== this.gridRevision || p.ready) return;
        p.ready = true;
        if (!this.tryStartReadyGrid()) this.broadcastRoomState();
        return;
      }

      case "RACE_RESTART_PRACTICE": {
        if (p.isHost && this.canRestartPractice) this.prepareGrid(true);
        return;
      }

      case "RACE_INPUT": {
        if (!msg.input || !Number.isSafeInteger(msg.input.seq)) return;
        if (msg.input.seq <= p.lastQueuedSeq) return;
        const finiteControl = (value: number) => Number.isFinite(value) ? value : 0;
        p.lastQueuedSeq = msg.input.seq;
        p.inputQueue.push({
          seq: msg.input.seq,
          throttle: finiteControl(msg.input.throttle),
          brake: finiteControl(msg.input.brake),
          steer: finiteControl(msg.input.steer),
          handbrake: Boolean(msg.input.handbrake),
          nitro: Boolean(msg.input.nitro),
          shiftUp: Boolean(msg.input.shiftUp),
          shiftDown: Boolean(msg.input.shiftDown),
          reset: Boolean(msg.input.reset),
          transmission: msg.input.transmission === "AUTO" || msg.input.transmission === "MANUAL"
            ? msg.input.transmission
            : p.setup.transmission,
        });
        if (p.inputQueue.length > MAX_INPUT_QUEUE) {
          p.inputQueue.splice(0, p.inputQueue.length - MAX_INPUT_QUEUE);
        }
        return;
      }

      case "RACE_VOTE_TRACK": {
        if (this.phase !== "PODIUM" || !isTrackId(msg.trackId)) return;
        this.trackVotes.set(p.id, msg.trackId);
        this.broadcastRoomState();
        return;
      }

      case "RACE_REMATCH": {
        if (p.isHost && this.phase === "PODIUM") this.prepareRematch();
        return;
      }
    }
  }

  private clearInput(part: RaceParticipant, resetSequence = false): void {
    part.inputQueue.length = 0;
    if (resetSequence) {
      part.lastQueuedSeq = 0;
      part.lastProcessedSeq = 0;
    }
    part.latestInput = { ...createEmptyRaceInput(part.lastProcessedSeq), transmission: part.setup.transmission };
    part.inputIdleSec = 0;
  }

  private requestRaceStart(): void {
    this.readyWaitExpired = false;
    this.readyRemainingSec ??= GRID_READY_TIMEOUT_SEC;
    if (!this.tryStartReadyGrid()) this.broadcastRoomState();
  }

  private tryStartReadyGrid(): boolean {
    if (this.phase !== "LOBBY" || this.readyRemainingSec === null) return false;
    const humans = this.getHumanParticipants();
    if (humans.length === 0 || humans.some((p) => !p.ready || !p.connected)) return false;

    this.readyRemainingSec = null;
    this.phase = "COUNTDOWN";
    this.countdownRemainingSec = COUNTDOWN_TOTAL_SEC;
    this.lastCountdownAnnounced = 4;
    this.resetGridCars();
    this.broadcastRoomState();
    this.broadcastSnapshot();
    return true;
  }

  private prepareRematch(): void {
    this.trackId = this.resolveVotedTrack();
    this.track = getTrackBlueprint(this.trackId);
    this.prepareGrid(true);
    this.broadcastEvent({ type: "RACE_EVENT", event: "REMATCH_STARTED", trackId: this.trackId });
  }

  private prepareGrid(startPending: boolean): void {
    this.phase = "LOBBY";
    this.gridRevision++;
    this.readyRemainingSec = startPending ? GRID_READY_TIMEOUT_SEC : null;
    this.readyWaitExpired = false;
    this.countdownRemainingSec = 0;
    this.lastCountdownAnnounced = 4;
    this.raceElapsedMs = 0;
    this.finishGraceRemainingSec = null;
    this.podiumAutoRematchSec = 0;
    this.podium = [];
    this.trackVotes.clear();

    for (const part of this.getHumanParticipants()) {
      if (!part.connected && !this.pendingReconnects.has(part.guestUuid)) {
        this.participants.delete(part.id);
      } else {
        part.ready = false;
      }
    }
    this.resetGridCars();
    this.broadcastRoomState();
    this.broadcastSnapshot();
  }

  private resetGridCars(): void {
    this.syncBotsToGrid();
    // Assign clean grid slots: human players at front slots, AI racers behind
    const ordered = Array.from(this.participants.values()).sort((a, b) => {
      if (a.isBot !== b.isBot) return a.isBot ? 1 : -1;
      return a.playerIndex - b.playerIndex;
    });

    for (let slot = 0; slot < ordered.length; slot++) {
      const part = ordered[slot];
      part.gridSlot = slot;
      part.state = createInitialVehicleState(this.track, slot, part.stats);
      this.clearInput(part);
      part.position = slot + 1;
      if (part.isBot) {
        part.botMemory = createRaceBotMemory(slot, this.botDifficulty);
      }
    }

    this.updateLiveRankings();
  }

  /**
   * Advances one deterministic fixed physics step (public for Vitest unit tests).
   */
  public stepSimulation(dt: number, nowMs = performance.now()): void {
    if (this.stopped) return;
    this.serverTick += 1;

    let launchGoThisTick = false;

    // --- 1. Phase State Machine ---
    if (this.phase === "LOBBY" && this.readyRemainingSec !== null) {
      this.readyRemainingSec -= dt;
      if (this.readyRemainingSec <= 0) {
        this.readyRemainingSec = null;
        this.readyWaitExpired = true;
        this.broadcastRoomState();
      }
    } else if (this.phase === "COUNTDOWN") {
      this.countdownRemainingSec = Math.max(0, this.countdownRemainingSec - dt);
      const countInt = Math.min(3, Math.ceil(this.countdownRemainingSec));
      if (countInt >= 1 && countInt < this.lastCountdownAnnounced) {
        this.lastCountdownAnnounced = countInt;
        this.broadcastEvent({
          type: "RACE_EVENT",
          event: "COUNTDOWN_TICK",
          value: countInt as 3 | 2 | 1,
        });
        this.broadcastRoomState();
      }
      if (this.countdownRemainingSec <= 0) {
        this.phase = "RACING";
        this.lastCountdownAnnounced = 0;
        this.raceElapsedMs = 0;
        launchGoThisTick = true;
        this.broadcastEvent({ type: "RACE_EVENT", event: "COUNTDOWN_TICK", value: 0 });
        this.broadcastRoomState();
      }
    } else if (this.phase === "RACING") {
      this.raceElapsedMs += dt * 1000;
    } else if (this.phase === "PODIUM") {
      this.podiumAutoRematchSec = Math.max(0, this.podiumAutoRematchSec - dt);
      if (this.podiumAutoRematchSec <= 0) {
        this.prepareRematch();
        return;
      }
    }

    const gridLocked = this.phase === "LOBBY" || this.phase === "COUNTDOWN";

    // Snapshot rival positions at start of tick for deterministic symmetric slipstream & bump checks
    const allParticipants = Array.from(this.participants.values());
    const rivalsSnapshot: RivalDraftSample[] = allParticipants.map((p) => ({
      id: p.id,
      position: { ...p.state.position },
      yaw: p.state.yaw,
      forwardSpeed: p.state.forwardSpeed,
    }));

    // --- 2. Step Each Vehicle ---
    const totalLaps = this.totalLaps;
    for (let i = 0; i < allParticipants.length; i++) {
      const part = allParticipants[i];
      let input: RaceInputCommand;

      if (part.isBot || this.phase === "PODIUM" || part.state.finished) {
        // Bots drive via AI; finished cars cruise cleanly along spline under AI autopilot!
        if (!part.botMemory) {
          part.botMemory = createRaceBotMemory(part.gridSlot, this.botDifficulty);
        }
        input = stepRaceBotAi({
          botId: part.id,
          state: part.state,
          memory: part.botMemory,
          track: this.track,
          rivals: rivalsSnapshot,
          difficulty: part.isBot ? this.botDifficulty : "EASY",
          mode: this.mode,
          gridLocked,
          dt,
        });
        if (part.state.finished) {
          input.nitro = false;
          input.throttle = Math.min(input.throttle, 0.55);
        }
      } else {
        if (part.inputQueue.length > 0) {
          // If slight burst buffered > 6 inputs, collapse oldest excess to keep latency low
          while (part.inputQueue.length > 8) {
            const dropped = part.inputQueue.shift()!;
            part.lastProcessedSeq = dropped.seq;
          }
          const nextIn = part.inputQueue.shift()!;
          part.latestInput = nextIn;
          part.lastProcessedSeq = nextIn.seq;
          part.inputIdleSec = 0;
          input = nextIn;
        } else {
          part.inputIdleSec += dt;
          if (part.inputIdleSec >= INPUT_HOLD_SEC) this.clearInput(part);
          // Hold sustained controls while clearing one-shot edge pulses
          input = {
            ...part.latestInput,
            shiftUp: false,
            shiftDown: false,
            reset: false,
          };
        }
      }

      const prevBestLap = part.state.bestLapMs;
      const stepEvents = stepVehiclePhysics(part.state, input, part.stats, this.track, {
        gridLocked,
        launchGoThisTick,
        raceElapsedMs: this.raceElapsedMs,
        totalLaps,
        rivals: rivalsSnapshot,
        selfId: part.id,
        dt,
      });

      if (stepEvents.perfectLaunch) {
        this.broadcastEvent({
          type: "RACE_EVENT",
          event: "PERFECT_LAUNCH",
          playerId: part.id,
          callsign: part.callsign,
        });
      }

      if (stepEvents.completedLap !== null && stepEvents.completedLapTimeMs !== null) {
        const splitDeltaMs =
          prevBestLap !== null ? stepEvents.completedLapTimeMs - prevBestLap : null;
        this.broadcastEvent({
          type: "RACE_EVENT",
          event: "LAP_COMPLETE",
          playerId: part.id,
          lap: stepEvents.completedLap,
          lapTimeMs: stepEvents.completedLapTimeMs,
          bestLapMs: part.state.bestLapMs ?? stepEvents.completedLapTimeMs,
          splitDeltaMs,
        });
      }

      if (stepEvents.finishedRace) {
        this.updateLiveRankings();
        this.broadcastEvent({
          type: "RACE_EVENT",
          event: "RACER_FINISHED",
          playerId: part.id,
          callsign: part.callsign,
          rank: part.position,
          finishTimeMs: part.state.finishTimeMs ?? Math.round(this.raceElapsedMs),
        });
        if (this.finishGraceRemainingSec === null && this.mode !== "DRIFT_ATTACK" && this.mode !== "TIME_TRIAL") {
          this.finishGraceRemainingSec = FINISH_GRACE_SEC;
        }
        this.broadcastRoomState();
      }
    }

    // --- 3. Live Rankings & Check Race Completion ---
    this.updateLiveRankings();

    if (this.phase === "RACING") {
      const allCarsFinished =
        allParticipants.length > 0 && allParticipants.every((p) => p.state.finished);

      if (this.finishGraceRemainingSec !== null) {
        this.finishGraceRemainingSec = Math.max(0, this.finishGraceRemainingSec - dt);
      }

      if (allCarsFinished || this.raceRemainingSec <= 0) {
        this.enterPodiumPhase();
      }
    }

    // --- 4. Broadcast 20Hz Snapshots & 2Hz Room State ---
    if (nowMs - this.lastSnapshotBroadcastMs >= NET_TICK_INTERVAL_MS - 1) {
      this.lastSnapshotBroadcastMs = nowMs;
      this.broadcastSnapshot(nowMs);
    }
    if (nowMs - this.lastRoomStateBroadcastMs >= 500) {
      this.lastRoomStateBroadcastMs = nowMs;
      this.broadcastRoomState();
    }
  }

  private get raceRemainingSec(): number {
    return Math.max(0, Math.min(this.raceLimitSec - this.raceElapsedMs / 1000, this.finishGraceRemainingSec ?? Infinity));
  }

  public getRoomStateBroadcast(): RaceRoomStateBroadcast {
    const voteCounts: Record<string, number> = {};
    for (const track of TRACK_LIST) {
      voteCounts[track.id] = 0;
    }
    for (const voted of this.trackVotes.values()) {
      voteCounts[voted] = (voteCounts[voted] ?? 0) + 1;
    }

    const players: RacePlayerSummary[] = Array.from(this.participants.values())
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        id: p.id,
        playerIndex: p.playerIndex,
        callsign: p.callsign,
        isHost: p.isHost,
        isBot: p.isBot,
        ready: p.ready,
        connected: p.connected,
        gridSlot: p.gridSlot,
        setup: { ...p.setup },
        position: p.position,
        lap: p.state.lap,
        bestLapMs: p.state.bestLapMs,
        totalDriftScore: p.state.totalDriftScore + Math.round(p.state.currentDriftScore),
        finished: p.state.finished,
        finishTimeMs: p.state.finishTimeMs,
        pingMs: p.pingMs,
      }));

    return {
      code: this.code,
      isPublic: this.isPublic,
      mode: this.mode,
      trackId: this.trackId,
      totalLaps: this.totalLaps,
      phase: this.phase,
      gridRevision: this.gridRevision,
      waitingForReady: this.readyRemainingSec !== null,
      readyWaitExpired: this.readyWaitExpired,
      canRestartPractice: this.canRestartPractice,
      raceRemainingSec: Math.ceil(this.raceRemainingSec),
      countdownValue: this.phase === "COUNTDOWN" ? Math.min(3, Math.ceil(this.countdownRemainingSec)) : 0,
      countdownRemainingSec: this.phase === "COUNTDOWN" ? Number(this.countdownRemainingSec.toFixed(2)) : 0,
      raceElapsedMs: Math.round(this.raceElapsedMs),
      botFill: this.botFill,
      botDifficulty: this.botDifficulty,
      players,
      podium: this.podium,
      trackVoteOptions: TRACK_LIST.map((t) => t.id),
      trackVotes: voteCounts,
      podiumAutoRematchSec: Math.ceil(this.podiumAutoRematchSec),
    };
  }

  public buildSnapshotMessage(nowMs = performance.now()): Extract<RaceServerToClientMessage, { type: "RACE_SNAPSHOT" }> {
    const cars: RaceCarSnapshot[] = Array.from(this.participants.values()).map((p) =>
      vehicleStateToSnapshot(p.id, p.playerIndex, p.lastProcessedSeq, p.position, p.state)
    );
    return {
      type: "RACE_SNAPSHOT",
      serverTick: this.serverTick,
      serverTimeMs: nowMs,
      phase: this.phase,
      countdownValue: this.phase === "COUNTDOWN" ? Math.min(3, Math.ceil(this.countdownRemainingSec)) : 0,
      countdownRemainingSec: this.phase === "COUNTDOWN" ? Number(this.countdownRemainingSec.toFixed(2)) : 0,
      raceElapsedMs: Math.round(this.raceElapsedMs),
      cars,
    };
  }

  public broadcastRoomState(excludePlayerId?: string): void {
    const room = this.getRoomStateBroadcast();
    for (const p of this.participants.values()) {
      if (!p.isBot && p.connected && p.sender && p.id !== excludePlayerId) {
        p.sender.sendJson({ type: "RACE_ROOM_STATE", room });
      }
    }
  }

  public broadcastSnapshot(nowMs = performance.now(), excludePlayerId?: string): void {
    const snap = this.buildSnapshotMessage(nowMs);
    for (const p of this.participants.values()) {
      if (!p.isBot && p.connected && p.sender && p.id !== excludePlayerId) {
        p.sender.sendJson(snap);
      }
    }
  }

  private sendSnapshotToParticipant(p: RaceParticipant, nowMs: number): void {
    if (!p.isBot && p.connected && p.sender) {
      p.sender.sendJson(this.buildSnapshotMessage(nowMs));
    }
  }

  private broadcastEvent(event: Extract<RaceServerToClientMessage, { type: "RACE_EVENT" }>): void {
    for (const p of this.participants.values()) {
      if (!p.isBot && p.connected && p.sender) {
        p.sender.sendJson(event);
      }
    }
  }

  private applySetup(p: RaceParticipant, setup: CarSetupConfig): void {
    p.setup = setup;
    p.stats = computeEffectiveVehicleStats(setup.vehicleId, setup.tuneId);
  }

  private updateLiveRankings(): void {
    const list = Array.from(this.participants.values());
    list.sort((a, b) => {
      if (this.mode === "DRIFT_ATTACK") {
        const scoreA = a.state.totalDriftScore + a.state.currentDriftScore;
        const scoreB = b.state.totalDriftScore + b.state.currentDriftScore;
        if (Math.abs(scoreB - scoreA) > 0.5) return scoreB - scoreA;
        return b.state.totalRaceDistanceM - a.state.totalRaceDistanceM;
      }

      if (a.state.finished && b.state.finished) {
        return (a.state.finishTimeMs ?? Infinity) - (b.state.finishTimeMs ?? Infinity);
      }
      if (a.state.finished !== b.state.finished) {
        return a.state.finished ? -1 : 1;
      }
      return b.state.totalRaceDistanceM - a.state.totalRaceDistanceM;
    });

    for (let i = 0; i < list.length; i++) {
      list[i].position = i + 1;
    }
  }

  private enterPodiumPhase(): void {
    this.phase = "PODIUM";
    this.podiumAutoRematchSec = PODIUM_AUTO_REMATCH_SEC;
    this.updateLiveRankings();

    const ordered = Array.from(this.participants.values()).sort((a, b) => a.position - b.position);
    const winnerTime = ordered[0]?.state.finishTimeMs ?? null;

    this.podium = ordered.map((p, idx) => {
      const totalDrift = p.state.totalDriftScore + Math.round(p.state.currentDriftScore);
      const finishTime = p.state.finishTimeMs;
      const gapToWinnerMs =
        idx === 0 || finishTime === null || winnerTime === null ? null : Math.max(0, finishTime - winnerTime);
      return {
        playerId: p.id,
        playerIndex: p.playerIndex,
        callsign: p.callsign,
        isBot: p.isBot,
        rank: idx + 1,
        vehicleId: p.setup.vehicleId,
        liveryId: p.setup.liveryId,
        finishTimeMs: finishTime,
        gapToWinnerMs,
        bestLapMs: p.state.bestLapMs,
        totalDriftScore: totalDrift,
        dnf: !p.state.finished && (this.mode !== "DRIFT_ATTACK" || totalDrift === 0),
      };
    });

    this.broadcastEvent({ type: "RACE_EVENT", event: "PODIUM_READY", podium: this.podium });
    this.broadcastRoomState();
  }

  private resolveVotedTrack(): TrackId {
    if (this.trackVotes.size === 0) return this.trackId;
    const counts = new Map<TrackId, number>();
    for (const trackId of this.trackVotes.values()) {
      counts.set(trackId, (counts.get(trackId) ?? 0) + 1);
    }
    let bestTrack: TrackId = this.trackId;
    let bestCount = 0;
    for (const [trackId, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestTrack = trackId;
      }
    }
    return bestTrack;
  }

  private syncBotsToGrid(): void {
    const humans = this.getHumanParticipants();
    const targetTotal = this.botFill ? this.maxPlayers : humans.length;
    const desiredBots = Math.max(0, targetTotal - humans.length);

    const existingBots = Array.from(this.participants.values()).filter((p) => p.isBot);
    while (existingBots.length > desiredBots) {
      const removed = existingBots.pop()!;
      this.participants.delete(removed.id);
    }

    let botCounter = existingBots.length;
    while (botCounter < desiredBots) {
      const slot = this.findFreeGridSlot();
      const vehicle = VEHICLE_LIST[(botCounter + 1) % VEHICLE_LIST.length];
      const livery = LIVERY_LIST[(botCounter + 1) % LIVERY_LIST.length];
      const tune = TUNE_LIST[botCounter % TUNE_LIST.length];
      const spoiler = SPOILER_LIST[(botCounter + 1) % SPOILER_LIST.length];
      const rim = RIM_LIST[botCounter % RIM_LIST.length];
      const underglow = UNDERGLOW_LIST[(botCounter + 1) % UNDERGLOW_LIST.length];

      const setup: CarSetupConfig = {
        ...defaultCarSetup(),
        vehicleId: vehicle.id,
        liveryId: livery.id,
        tuneId: tune.id,
        spoilerId: spoiler.id,
        rimId: rim.id,
        underglowId: underglow.id,
        transmission: "AUTO",
      };
      const stats = computeEffectiveVehicleStats(setup.vehicleId, setup.tuneId);
      const id = `racebot_${this.nextPlayerIndex}`;
      const bot: RaceParticipant = {
        id,
        guestUuid: id,
        playerIndex: this.nextPlayerIndex++,
        callsign: BOT_CALLSIGNS[botCounter % BOT_CALLSIGNS.length],
        isHost: false,
        isBot: true,
        connected: true,
        ready: true,
        gridSlot: slot,
        setup,
        stats,
        state: createInitialVehicleState(this.track, slot, stats),
        inputQueue: [],
        latestInput: createEmptyRaceInput(0),
        lastQueuedSeq: 0,
        lastProcessedSeq: 0,
        inputIdleSec: 0,
        position: slot + 1,
        pingMs: 0,
        botMemory: createRaceBotMemory(slot, this.botDifficulty),
      };
      this.participants.set(id, bot);
      botCounter++;
    }
  }

  private findFreeGridSlot(): number {
    const used = new Set<number>();
    for (const p of this.participants.values()) {
      used.add(p.gridSlot);
    }
    for (let s = 0; s < 16; s++) {
      if (!used.has(s)) return s;
    }
    return this.participants.size;
  }

  private ensureHostAssigned(): void {
    const humans = this.getHumanParticipants().filter((p) => p.connected);
    if (humans.length === 0) return;
    if (!humans.some((p) => p.isHost)) {
      humans[0].isHost = true;
    }
  }

  private checkEmptyAndCleanup(): void {
    const anyHumanPresent =
      this.getHumanParticipants().some((p) => p.connected) || this.pendingReconnects.size > 0;
    if (!anyHumanPresent) {
      this.stop();
      this.onEmptyCallback?.(this.code);
    }
  }
}

export { RACING_PROTOCOL_VERSION };
