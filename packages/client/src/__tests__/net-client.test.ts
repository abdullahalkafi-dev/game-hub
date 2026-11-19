import { MOVEMENT_PROTOCOL_VERSION, createInitialFpsState, type ClientToServerMessage, type ServerToClientMessage } from "@game/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetClient } from "../core/NetClient.js";

class FakeSocket {
  static readonly OPEN = 1;
  static latest: FakeSocket;
  readyState = FakeSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor() {
    FakeSocket.latest = this;
  }

  close(): void {
    this.readyState = 3;
  }

  receive(message: ServerToClientMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const joinParams: Omit<Extract<ClientToServerMessage, { type: "JOIN_OR_CREATE" }>, "type"> = {
  action: "CREATE",
  guestUuid: "test-guest",
  callsign: "Tester",
  mode: "1v1",
  mapId: "cargo_docks",
  isPublic: false,
  botFill: false,
  loadout: {
    primary: { weaponId: "m416", skinId: "standard_issue", attachments: {} },
    secondary: { weaponId: "deagle", skinId: "standard_issue", attachments: {} },
    throwable: "frag",
  },
};

const welcome: Extract<ServerToClientMessage, { type: "WELCOME" }> = {
  type: "WELCOME",
  yourPlayerId: "p_1",
  yourPlayerIndex: 1,
  reconnected: false,
  room: {
    code: "TEST", isPublic: false, mode: "1v1", mapId: "cargo_docks", phase: "WARMUP",
    roundNumber: 0, roundTimeRemainingSec: 0, scoreA: 0, scoreB: 0,
    overtimeActive: false, overtimeHolder: null, overtimeProgressA: 0, overtimeProgressB: 0,
    bombPlanted: false, bombTimerSec: 0, bombPlanterTeam: null, botFill: false, players: [],
  },
};

const startState: Extract<ServerToClientMessage, { type: "LOCAL_STATE" }> = {
  type: "LOCAL_STATE", serverTick: 1, movementEpoch: 0, inputAck: 0, shotAck: 0,
  movement: createInitialFpsState({ x: -6, y: 0, z: -26 }), alive: true, hp: 100, armor: 50,
  respawnSeconds: 0, ammoInMag: [30, 7], ammoReserve: [120, 35], reloadSeconds: 0, activeSlot: 0,
};

function createClient(): NetClient {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost:5173" } });
  return new NetClient();
}

afterEach(() => vi.unstubAllGlobals());

describe("match join readiness", () => {
  it("waits for the player's starting position before marking the match connected", async () => {
    const client = createClient();
    const joined = client.connectAndJoin(joinParams);
    try {
      FakeSocket.latest.receive({ ...welcome, movementProtocolVersion: MOVEMENT_PROTOCOL_VERSION });
      expect(client.connected).toBe(false);
      expect(client.latestLocalState).toBeNull();

      FakeSocket.latest.receive(startState);
      await expect(joined).resolves.toMatchObject({ yourPlayerId: "p_1" });
      expect(client.connected).toBe(true);
      expect(client.latestLocalState?.movement.position).toEqual(startState.movement.position);
    } finally {
      client.disconnect();
    }
  });

  it("rejects a legacy server before entering an arena with disabled movement", async () => {
    const client = createClient();
    const joined = client.connectAndJoin(joinParams);
    FakeSocket.latest.receive(welcome);

    await expect(joined).rejects.toThrow("different game versions");
    expect(client.connected).toBe(false);
    expect(FakeSocket.latest.readyState).toBe(3);
  });
});
