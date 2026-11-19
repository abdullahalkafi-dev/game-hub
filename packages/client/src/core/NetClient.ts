import {
  INTERPOLATION_DELAY_MS,
  MOVEMENT_PROTOCOL_VERSION,
  RingBuffer,
  decodeWorldSnapshotBinary,
  lerp,
  type BinaryPlayerSnapshot,
  type BotDifficulty,
  type ClientToServerMessage,
  type GameMode,
  type MatchRules,
  type PlayerLoadoutPayload,
  type RoomStateBroadcast,
  type ServerToClientMessage,
} from "@game/shared";

export interface PublicRoomSummary {
  code: string;
  isPublic: boolean;
  mode: GameMode;
  mapId: string;
  mapName: string;
  phase: string;
  playerCount: number;
  humanCount: number;
  maxPlayers: number;
  ranked?: boolean;
}

interface TimedBinarySnapshot {
  recvTimeMs: number;
  serverTimeMs: number;
  byIndex: Map<number, BinaryPlayerSnapshot>;
}

type WelcomeMessage = Extract<ServerToClientMessage, { type: "WELCOME" }>;

export interface InterpolatedRemoteState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  lean: number;
  crouching: boolean;
  sliding: boolean;
  alive: boolean;
  ads: boolean;
  activeSlot: 0 | 1;
  vaulting: boolean;
  grounded: boolean;
  hp: number;
  armor: number;
  vx: number;
  vz: number;
}

export interface NetClientCallbacks {
  onWelcome?: (msg: WelcomeMessage) => void;
  onRoomState?: (room: RoomStateBroadcast) => void;
  onMessage?: (msg: ServerToClientMessage) => void;
  onError?: (err: string) => void;
  onDisconnected?: () => void;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * WebSocket Client + 100ms Snapshot Interpolation RingBuffer.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private readonly snapshotBuffer = new RingBuffer<TimedBinarySnapshot>(32);
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private cancelPendingJoin: (() => void) | null = null;
  public currentPingMs: number | null = null;
  public latestLocalState: Extract<ServerToClientMessage, { type: "LOCAL_STATE" }> | null = null;
  public yourPlayerId: string | null = null;
  public yourPlayerIndex = -1;
  public connected = false;

  constructor(private callbacks: NetClientCallbacks = {}) {}

  setCallbacks(callbacks: NetClientCallbacks): void {
    this.callbacks = callbacks;
  }

  private getWsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }

  async fetchPublicRooms(): Promise<PublicRoomSummary[]> {
    try {
      const resp = await fetch("/api/rooms");
      if (!resp.ok) return [];
      const data = (await resp.json()) as { rooms?: PublicRoomSummary[] };
      return data.rooms ?? [];
    } catch {
      return [];
    }
  }

  connectAndJoin(params: {
    action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
    guestUuid: string;
    callsign: string;
    mode: GameMode;
    mapId: string;
    isPublic: boolean;
    botFill: boolean;
    matchRules?: Partial<MatchRules>;
    botDifficulty?: BotDifficulty;
    roomCode?: string;
    loadout: PlayerLoadoutPayload;
  }): Promise<WelcomeMessage> {
    this.disconnect();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.getWsUrl());
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let welcome: WelcomeMessage | undefined;
      let joining = true;

      const failJoin = (message: string) => {
        if (!joining) return;
        joining = false;
        clearTimeout(timeoutId);
        this.cancelPendingJoin = null;
        if (this.ws === ws) this.disconnect();
        reject(new Error(message));
      };
      const timeoutId = setTimeout(() => failJoin(welcome
        ? "The server did not send your starting position. Try joining again."
        : "Connection to the game server timed out."), 6000);
      this.cancelPendingJoin = () => failJoin("The room join was canceled.");

      const finishJoin = () => {
        if (!joining || !welcome || !this.latestLocalState) return;
        joining = false;
        clearTimeout(timeoutId);
        this.cancelPendingJoin = null;
        this.yourPlayerId = welcome.yourPlayerId;
        this.yourPlayerIndex = welcome.yourPlayerIndex;
        this.connected = true;
        resolve(welcome);
        this.callbacks.onWelcome?.(welcome);
      };

      ws.onopen = () => {
        this.send({
          type: "JOIN_OR_CREATE",
          ...params,
        });
        this.send({ type: "PING_CHECK", t0: performance.now() });
        this.pingInterval = setInterval(() => {
          this.send({ type: "PING_CHECK", t0: performance.now() });
        }, 2000);
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          try {
            const decoded = decodeWorldSnapshotBinary(ev.data);
            const byIndex = new Map<number, BinaryPlayerSnapshot>();
            for (const p of decoded.players) {
              byIndex.set(p.playerIndex, p);
            }
            this.snapshotBuffer.push({
              recvTimeMs: performance.now(),
              serverTimeMs: decoded.serverTimeMs,
              byIndex,
            });
          } catch {
            // Ignore malformed binary frame
          }
          return;
        }

        try {
          const msg = JSON.parse(String(ev.data)) as ServerToClientMessage;
          if (msg.type === "PONG_CHECK") {
            this.currentPingMs = Math.max(1, Math.round(performance.now() - msg.t0));
            return;
          }
          if (msg.type === "WELCOME") {
            if (msg.movementProtocolVersion !== MOVEMENT_PROTOCOL_VERSION) {
              failJoin("The client and server use different game versions. Restart the game server, then reload this page.");
              return;
            }
            welcome = msg;
            finishJoin();
            return;
          }
          if (msg.type === "ERROR") {
            if (joining) failJoin(msg.message);
            else this.callbacks.onError?.(msg.message);
            return;
          }
          if (msg.type === "ROOM_STATE") {
            if (this.connected) this.callbacks.onRoomState?.(msg.room);
            return;
          }
          if (msg.type === "LOCAL_STATE") {
            const previous = this.latestLocalState;
            if (!previous || msg.serverTick > previous.serverTick) {
              if (previous && previous.movementEpoch !== msg.movementEpoch) this.clearSnapshots();
              this.latestLocalState = msg;
            }
            finishJoin();
            return;
          }
          this.callbacks.onMessage?.(msg);
        } catch {
          // Ignore invalid JSON
        }
      };

      ws.onerror = () => {
        failJoin("The game server is unreachable. Check that it is running, then try joining again.");
      };

      ws.onclose = () => {
        if (joining) {
          failJoin("Connection closed before joining the room.");
          return;
        }
        this.disconnect();
        this.callbacks.onDisconnected?.();
      };
    });
  }

  get snapshotAgeMs(): number | null {
    const latest = this.snapshotBuffer.getLatest();
    return latest ? Math.round(performance.now() - latest.recvTimeMs) : null;
  }

  clearSnapshots(): void {
    this.snapshotBuffer.clear();
  }

  send(msg: ClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Samples remote entity state using a 100ms interpolation buffer so 20Hz server
   * snapshots render smoothly at 60-144 FPS with zero jitter.
   */
  getInterpolatedPlayerState(playerIndex: number): InterpolatedRemoteState | null {
    const len = this.snapshotBuffer.length;
    if (len === 0) return null;

    const renderTimeMs = performance.now() - INTERPOLATION_DELAY_MS;
    let older: TimedBinarySnapshot | undefined;
    let newer: TimedBinarySnapshot | undefined;

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
      const p = newer.byIndex.get(playerIndex);
      return p ? { ...p, grounded: p.grounded ?? true } : null;
    }
    if (older && !newer) {
      const p = older.byIndex.get(playerIndex);
      return p ? { ...p, grounded: p.grounded ?? true } : null;
    }
    if (!older || !newer) return null;

    const a = older.byIndex.get(playerIndex);
    const b = newer.byIndex.get(playerIndex);
    if (!a) return b ? { ...b, grounded: b.grounded ?? true } : null;
    if (!b) return { ...a, grounded: a.grounded ?? true };

    const span = Math.max(1, newer.recvTimeMs - older.recvTimeMs);
    const t = Math.max(0, Math.min(1, (renderTimeMs - older.recvTimeMs) / span));

    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      yaw: lerpAngle(a.yaw, b.yaw, t),
      pitch: lerp(a.pitch, b.pitch, t),
      lean: lerp(a.lean, b.lean, t),
      crouching: b.crouching,
      sliding: b.sliding,
      alive: b.alive,
      ads: b.ads,
      activeSlot: b.activeSlot,
      vaulting: b.vaulting,
      grounded: b.grounded ?? true,
      hp: b.hp,
      armor: b.armor,
      vx: lerp(a.vx, b.vx, t),
      vz: lerp(a.vz, b.vz, t),
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
    this.latestLocalState = null;
    this.clearSnapshots();
    cancelJoin?.();
  }
}
