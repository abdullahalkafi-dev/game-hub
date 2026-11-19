import {
  INTERPOLATION_DELAY_MS,
  RACING_PROTOCOL_VERSION,
  RingBuffer,
  lerp,
  type BotDifficulty,
  type CarSetupConfig,
  type RaceCarSnapshot,
  type RaceClientToServerMessage,
  type RaceEventMessage,
  type RaceInputCommand,
  type RaceMode,
  type RacePhase,
  type RacePublicRoomSummary,
  type RaceRoomStateBroadcast,
  type RaceServerToClientMessage,
  type TrackId,
} from "@game/shared";

export type RaceWelcomeMessage = Extract<RaceServerToClientMessage, { type: "RACE_WELCOME" }>;
export type RaceSnapshotMessage = Extract<RaceServerToClientMessage, { type: "RACE_SNAPSHOT" }>;

export interface TimedRaceSnapshot {
  recvTimeMs: number;
  serverTick: number;
  serverTimeMs: number;
  phase: RacePhase;
  countdownValue: number;
  countdownRemainingSec: number;
  raceElapsedMs: number;
  byIndex: Map<number, RaceCarSnapshot>;
  byId: Map<string, RaceCarSnapshot>;
}

export interface SelfSnapshotEnvelope {
  serverTick: number;
  serverTimeMs: number;
  recvTimeMs: number;
  phase: RacePhase;
  countdownValue: number;
  countdownRemainingSec: number;
  raceElapsedMs: number;
  car: RaceCarSnapshot;
}

export interface InterpolatedRivalState {
  playerId: string;
  playerIndex: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  suspensionOffset: number;
  steerAngle: number;
  wheelSpinRad: number;
  forwardSpeed: number;
  lateralSpeed: number;
  speedKmh: number;
  rpm: number;
  rpmNorm: number;
  gear: number;
  nitro: number;
  nitroActive: boolean;
  launchBoostTimer: number;
  drifting: boolean;
  driftAngleRad: number;
  currentDriftScore: number;
  driftMultiplier: number;
  totalDriftScore: number;
  slipstreamActive: boolean;
  inTunnel: boolean;
  onGravel: boolean;
  wallScrapeIntensity: number;
  wrongWay: boolean;
  brakeLight: number;
  brakeHeat: number;
  distanceAlongLap: number;
  progressAlongLap: number;
  lap: number;
  totalRaceDistanceM: number;
  position: number;
  currentLapTimeMs: number;
  bestLapMs: number | null;
  finished: boolean;
  finishTimeMs: number | null;
}

export interface RaceJoinParams {
  action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
  guestUuid: string;
  callsign: string;
  mode: RaceMode;
  trackId: TrackId;
  isPublic: boolean;
  botFill: boolean;
  botDifficulty?: BotDifficulty;
  roomCode?: string;
  setup: CarSetupConfig;
}

export interface RaceNetClientCallbacks {
  onWelcome?: (msg: RaceWelcomeMessage) => void;
  onRoomState?: (room: RaceRoomStateBroadcast) => void;
  onSnapshot?: (msg: RaceSnapshotMessage) => void;
  onEvent?: (ev: RaceEventMessage) => void;
  onError?: (err: string) => void;
  onDisconnected?: () => void;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function snapshotToInterpolated(car: Readonly<RaceCarSnapshot>): InterpolatedRivalState {
  return {
    playerId: car.playerId,
    playerIndex: car.playerIndex,
    x: car.x,
    y: car.y,
    z: car.z,
    vx: car.vx,
    vy: car.vy,
    vz: car.vz,
    yaw: car.yaw,
    pitch: car.pitch,
    roll: car.roll,
    suspensionOffset: car.suspensionOffset,
    steerAngle: car.steerAngle,
    wheelSpinRad: car.wheelSpinRad,
    forwardSpeed: car.forwardSpeed,
    lateralSpeed: car.lateralSpeed,
    speedKmh: car.speedKmh,
    rpm: car.rpm,
    rpmNorm: car.rpmNorm,
    gear: car.gear,
    nitro: car.nitro,
    nitroActive: car.nitroActive,
    launchBoostTimer: car.launchBoostTimer,
    drifting: car.drifting,
    driftAngleRad: car.driftAngleRad,
    currentDriftScore: car.currentDriftScore,
    driftMultiplier: car.driftMultiplier,
    totalDriftScore: car.totalDriftScore,
    slipstreamActive: car.slipstreamActive,
    inTunnel: car.inTunnel,
    onGravel: car.onGravel,
    wallScrapeIntensity: car.wallScrapeIntensity,
    wrongWay: car.wrongWay,
    brakeLight: car.brakeLight,
    brakeHeat: car.brakeHeat,
    distanceAlongLap: car.distanceAlongLap,
    progressAlongLap: car.progressAlongLap,
    lap: car.lap,
    totalRaceDistanceM: car.totalRaceDistanceM,
    position: car.position,
    currentLapTimeMs: car.currentLapTimeMs,
    bestLapMs: car.bestLapMs,
    finished: car.finished,
    finishTimeMs: car.finishTimeMs,
  };
}

/**
 * WebSocket Client for Game 2 (ApexDrive Street Racer) mounted at `/ws/race`.
 * - Fetches live rooms via `GET /api/race-rooms`
 * - Streams monotonic `RACE_INPUT` packets for zero-snap client prediction reconciliation
 * - Buffers 20Hz `RACE_SNAPSHOT` frames in a RingBuffer for 100ms smooth rival interpolation
 */
export class RaceNetClient {
  private ws: WebSocket | null = null;
  private readonly snapshotBuffer = new RingBuffer<TimedRaceSnapshot>(32);
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private cancelPendingJoin: (() => void) | null = null;
  private inputSeq = 0;

  public currentPingMs: number | null = null;
  public yourPlayerId: string | null = null;
  public yourPlayerIndex = -1;
  public connected = false;
  public latestRoom: RaceRoomStateBroadcast | null = null;
  private latestSelfSnapshot: SelfSnapshotEnvelope | null = null;
  private latestServerTick = -1;

  constructor(private callbacks: RaceNetClientCallbacks = {}) {}

  setCallbacks(callbacks: RaceNetClientCallbacks): void {
    this.callbacks = callbacks;
  }

  private getWsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/race`;
  }

  async fetchPublicRooms(): Promise<RacePublicRoomSummary[]> {
    try {
      const resp = await fetch("/api/race-rooms");
      if (!resp.ok) return [];
      const data = (await resp.json()) as { rooms?: RacePublicRoomSummary[] };
      return data.rooms ?? [];
    } catch {
      return [];
    }
  }

  connectAndJoin(params: RaceJoinParams): Promise<RaceWelcomeMessage> {
    this.disconnect();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.getWsUrl());
      this.ws = ws;
      let joining = true;

      const failJoin = (message: string) => {
        if (!joining) return;
        joining = false;
        clearTimeout(timeoutId);
        this.cancelPendingJoin = null;
        if (this.ws === ws) this.disconnect();
        reject(new Error(message));
      };

      const timeoutId = setTimeout(() => {
        failJoin("Connection to the racing server timed out.");
      }, 6500);
      this.cancelPendingJoin = () => failJoin("The race join request was canceled.");

      ws.onopen = () => {
        this.send({
          type: "RACE_JOIN_OR_CREATE",
          ...params,
        });
        this.send({ type: "RACE_PING", t0: performance.now() });
        this.pingInterval = setInterval(() => {
          this.send({ type: "RACE_PING", t0: performance.now() });
        }, 2000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: RaceServerToClientMessage;
        try {
          msg = JSON.parse(ev.data) as RaceServerToClientMessage;
        } catch {
          return;
        }

        if (msg.type === "RACE_PONG") {
          this.currentPingMs = Math.max(1, Math.round(performance.now() - msg.t0));
          return;
        }

        if (msg.type === "RACE_WELCOME") {
          if (msg.protocolVersion !== RACING_PROTOCOL_VERSION) {
            failJoin("Client and server racing versions do not match. Restart the server and reload.");
            return;
          }
          joining = false;
          clearTimeout(timeoutId);
          this.cancelPendingJoin = null;
          this.yourPlayerId = msg.yourPlayerId;
          this.yourPlayerIndex = msg.yourPlayerIndex;
          this.latestRoom = msg.room;
          this.connected = true;
          resolve(msg);
          this.callbacks.onWelcome?.(msg);
          return;
        }

        if (msg.type === "RACE_ERROR") {
          if (joining) failJoin(msg.message);
          else this.callbacks.onError?.(msg.message);
          return;
        }

        if (msg.type === "RACE_ROOM_STATE") {
          this.latestRoom = msg.room;
          if (this.connected) {
            this.callbacks.onRoomState?.(msg.room);
          }
          return;
        }

        if (msg.type === "RACE_SNAPSHOT") {
          const recvTimeMs = performance.now();
          const byIndex = new Map<number, RaceCarSnapshot>();
          const byId = new Map<string, RaceCarSnapshot>();
          for (let i = 0; i < msg.cars.length; i++) {
            const car = msg.cars[i];
            byIndex.set(car.playerIndex, car);
            byId.set(car.playerId, car);
          }

          // Update zero-delay authoritative self snapshot for local prediction reconciliation
          if (msg.serverTick >= this.latestServerTick) {
            this.latestServerTick = msg.serverTick;
            const selfCar =
              (this.yourPlayerId ? byId.get(this.yourPlayerId) : undefined) ??
              (this.yourPlayerIndex >= 0 ? byIndex.get(this.yourPlayerIndex) : undefined);
            if (selfCar) {
              this.latestSelfSnapshot = {
                serverTick: msg.serverTick,
                serverTimeMs: msg.serverTimeMs,
                recvTimeMs,
                phase: msg.phase,
                countdownValue: msg.countdownValue,
                countdownRemainingSec: msg.countdownRemainingSec,
                raceElapsedMs: msg.raceElapsedMs,
                car: selfCar,
              };
            }
          }

          this.snapshotBuffer.push({
            recvTimeMs,
            serverTick: msg.serverTick,
            serverTimeMs: msg.serverTimeMs,
            phase: msg.phase,
            countdownValue: msg.countdownValue,
            countdownRemainingSec: msg.countdownRemainingSec,
            raceElapsedMs: msg.raceElapsedMs,
            byIndex,
            byId,
          });

          this.callbacks.onSnapshot?.(msg);
          return;
        }

        if (msg.type === "RACE_EVENT") {
          this.callbacks.onEvent?.(msg);
        }
      };

      ws.onerror = () => {
        failJoin("The racing server is unreachable. Make sure the server is running and try again.");
      };

      ws.onclose = () => {
        if (joining) {
          failJoin("Connection closed before joining the race room.");
          return;
        }
        this.disconnect();
        this.callbacks.onDisconnected?.();
      };
    });
  }

  nextInputSeq(): number {
    this.inputSeq += 1;
    return this.inputSeq;
  }

  sendRaceInput(input: RaceInputCommand): void {
    if (input.seq > this.inputSeq) {
      this.inputSeq = input.seq;
    }
    this.send({
      type: "RACE_INPUT",
      input,
      clientTimeMs: Math.round(performance.now()),
    });
  }

  send(msg: RaceClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Returns the newest authoritative snapshot for the local player with ZERO interpolation delay
   * so sequence-based input reconciliation remains snappy and drift-free.
   */
  getLatestSelfSnapshot(): SelfSnapshotEnvelope | null {
    return this.latestSelfSnapshot;
  }

  getLatestSnapshot(): TimedRaceSnapshot | null {
    return this.snapshotBuffer.getLatest() ?? null;
  }

  get snapshotAgeMs(): number | null {
    const latest = this.snapshotBuffer.getLatest();
    return latest ? Math.round(performance.now() - latest.recvTimeMs) : null;
  }

  clearSnapshots(): void {
    this.snapshotBuffer.clear();
    this.latestSelfSnapshot = null;
    this.latestServerTick = -1;
  }

  /**
   * Samples rival car state with a 100ms interpolation delay so 20Hz snapshots glide smoothly
   * at 60-240Hz without stutter.
   */
  getInterpolatedRival(playerIndex: number): InterpolatedRivalState | null {
    return this.sampleInterpolated((snap) => snap.byIndex.get(playerIndex));
  }

  getInterpolatedRivalById(playerId: string): InterpolatedRivalState | null {
    return this.sampleInterpolated((snap) => snap.byId.get(playerId));
  }

  private sampleInterpolated(
    lookup: (snap: TimedRaceSnapshot) => RaceCarSnapshot | undefined
  ): InterpolatedRivalState | null {
    const len = this.snapshotBuffer.length;
    if (len === 0) return null;

    const renderTimeMs = performance.now() - INTERPOLATION_DELAY_MS;
    let older: TimedRaceSnapshot | undefined;
    let newer: TimedRaceSnapshot | undefined;

    for (let i = len - 1; i >= 0; i--) {
      const snap = this.snapshotBuffer.getAt(i);
      if (!snap) continue;
      if (snap.recvTimeMs <= renderTimeMs) {
        older = snap;
        newer = i + 1 < len ? this.snapshotBuffer.getAt(i + 1) : undefined;
        break;
      }
      newer = snap;
    }

    if (!older && newer) {
      const c = lookup(newer);
      return c ? snapshotToInterpolated(c) : null;
    }
    if (older && !newer) {
      const c = lookup(older);
      return c ? snapshotToInterpolated(c) : null;
    }
    if (!older || !newer) return null;

    const a = lookup(older);
    const b = lookup(newer);
    if (!a) return b ? snapshotToInterpolated(b) : null;
    if (!b) return snapshotToInterpolated(a);

    // If rival teleported (e.g. [R] reset or rematch), snap directly instead of flying through terrain
    const jumpSq = (b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z);
    if (jumpSq > 36 * 36) {
      return snapshotToInterpolated(b);
    }

    const span = Math.max(1, newer.recvTimeMs - older.recvTimeMs);
    const t = Math.max(0, Math.min(1, (renderTimeMs - older.recvTimeMs) / span));

    // Handle wheelSpinRad wrap-around smoothly
    let spinDelta = b.wheelSpinRad - a.wheelSpinRad;
    if (Math.abs(spinDelta) > Math.PI * 50) spinDelta = 0;

    return {
      playerId: b.playerId,
      playerIndex: b.playerIndex,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      vx: lerp(a.vx, b.vx, t),
      vy: lerp(a.vy, b.vy, t),
      vz: lerp(a.vz, b.vz, t),
      yaw: lerpAngle(a.yaw, b.yaw, t),
      pitch: lerp(a.pitch, b.pitch, t),
      roll: lerp(a.roll, b.roll, t),
      suspensionOffset: lerp(a.suspensionOffset, b.suspensionOffset, t),
      steerAngle: lerp(a.steerAngle, b.steerAngle, t),
      wheelSpinRad: a.wheelSpinRad + spinDelta * t,
      forwardSpeed: lerp(a.forwardSpeed, b.forwardSpeed, t),
      lateralSpeed: lerp(a.lateralSpeed, b.lateralSpeed, t),
      speedKmh: lerp(a.speedKmh, b.speedKmh, t),
      rpm: lerp(a.rpm, b.rpm, t),
      rpmNorm: lerp(a.rpmNorm, b.rpmNorm, t),
      gear: b.gear,
      nitro: lerp(a.nitro, b.nitro, t),
      nitroActive: b.nitroActive,
      launchBoostTimer: b.launchBoostTimer,
      drifting: b.drifting,
      driftAngleRad: lerp(a.driftAngleRad, b.driftAngleRad, t),
      currentDriftScore: b.currentDriftScore,
      driftMultiplier: b.driftMultiplier,
      totalDriftScore: b.totalDriftScore,
      slipstreamActive: b.slipstreamActive,
      inTunnel: b.inTunnel,
      onGravel: b.onGravel,
      wallScrapeIntensity: b.wallScrapeIntensity,
      wrongWay: b.wrongWay,
      brakeLight: lerp(a.brakeLight, b.brakeLight, t),
      brakeHeat: lerp(a.brakeHeat, b.brakeHeat, t),
      distanceAlongLap: b.distanceAlongLap,
      progressAlongLap: b.progressAlongLap,
      lap: b.lap,
      totalRaceDistanceM: b.totalRaceDistanceM,
      position: b.position,
      currentLapTimeMs: b.currentLapTimeMs,
      bestLapMs: b.bestLapMs,
      finished: b.finished,
      finishTimeMs: b.finishTimeMs,
    };
  }

  disconnect(): void {
    const cancelJoin = this.cancelPendingJoin;
    this.cancelPendingJoin = null;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.yourPlayerId = null;
    this.yourPlayerIndex = -1;
    this.currentPingMs = null;
    this.latestRoom = null;
    this.inputSeq = 0;
    this.clearSnapshots();
    cancelJoin?.();
  }
}
