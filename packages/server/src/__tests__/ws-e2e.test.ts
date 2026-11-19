import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import {
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_SPRINT,
  MOVEMENT_PROTOCOL_VERSION,
  decodeWorldSnapshotBinary,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@game/shared";
import { createGameServer } from "../GameServer.js";
import { defaultPlayerLoadout } from "../rooms/FpsArenaRoom.js";

type JoinMessage = Extract<ClientToServerMessage, { type: "JOIN_OR_CREATE" }>;
type Welcome = Extract<ServerToClientMessage, { type: "WELCOME" }>;
type LocalState = Extract<ServerToClientMessage, { type: "LOCAL_STATE" }>;

function waitForPacket<T>(ws: WebSocket, read: (data: WebSocket.RawData, isBinary: boolean) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timer);
      ws.off("message", handler);
    }
    function handler(data: WebSocket.RawData, isBinary: boolean): void {
      try {
        const result = read(data, isBinary);
        if (result === undefined) return;
        cleanup();
        resolve(result);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for server packet"));
    }, 2500);
    ws.on("message", handler);
  });
}

function joinWithInitialState(ws: WebSocket, message: JoinMessage): Promise<{ welcome: Welcome; local: LocalState }> {
  let welcome: Welcome | undefined;
  const joined = waitForPacket(ws, (data, isBinary) => {
    if (isBinary) throw new Error("The movement handshake arrived after the periodic binary snapshot");
    const msg = JSON.parse(data.toString()) as ServerToClientMessage;
    if (msg.type === "ERROR") throw new Error(msg.message);
    if (msg.type === "WELCOME") welcome = msg;
    if (msg.type !== "LOCAL_STATE") return undefined;
    if (!welcome) throw new Error("LOCAL_STATE arrived before WELCOME");
    return { welcome, local: msg };
  });
  ws.send(JSON.stringify(message));
  return joined;
}

function sendSprint(ws: WebSocket, state: LocalState, firstSeq: number, lastSeq: number): void {
  for (let seq = firstSeq; seq <= lastSeq; seq++) {
    ws.send(JSON.stringify({
      type: "INPUT",
      seq,
      flags: INPUT_FLAG_FORWARD | INPUT_FLAG_SPRINT,
      yaw: state.movement.yaw,
      pitch: 0,
      activeSlot: state.activeSlot,
      clientTimeMs: Date.now(),
      movementEpoch: state.movementEpoch,
    } satisfies ClientToServerMessage));
  }
}

function waitForLocalState(ws: WebSocket, ready: (state: LocalState) => boolean): Promise<LocalState> {
  return waitForPacket(ws, (data, isBinary) => {
    if (isBinary) return undefined;
    const msg = JSON.parse(data.toString()) as ServerToClientMessage;
    if (msg.type === "LOCAL_STATE" && ready(msg)) return msg;
  });
}

function distanceBetween(a: LocalState, b: LocalState): number {
  return Math.hypot(b.movement.position.x - a.movement.position.x, b.movement.position.z - a.movement.position.z);
}

describe("Production WebSocket and HTTP transport", () => {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];

  async function listen(): Promise<string> {
    const game = await createGameServer();
    server = game.server;
    wss = game.wss;
    await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
    const address = game.server.address();
    if (!address || typeof address === "string") throw new Error("Game server did not open a TCP port");
    return `127.0.0.1:${address.port}`;
  }

  async function connect(address: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://${address}/ws`);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((ws) => {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }));
    if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    wss = undefined;
  });

  const baseJoin = {
    type: "JOIN_OR_CREATE",
    action: "CREATE",
    guestUuid: "ws-u1",
    callsign: "WsAlpha",
    mode: "2v2",
    mapId: "desert_outpost",
    isPublic: true,
    botFill: true,
    loadout: defaultPlayerLoadout(),
  } satisfies JoinMessage;

  it("advertises the movement protocol and starts both snapshot streams for a real room", async () => {
    const address = await listen();
    const first = await connect(address);
    const { welcome, local } = await joinWithInitialState(first, baseJoin);
    expect(welcome.movementProtocolVersion).toBe(MOVEMENT_PROTOCOL_VERSION);
    expect(welcome.room.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(welcome.room.players).toHaveLength(4);
    expect(local.alive).toBe(true);

    const health = await fetch(`http://${address}/api/health`);
    expect(await health.json()).toMatchObject({ movementProtocolVersion: MOVEMENT_PROTOCOL_VERSION });
    const rooms = await fetch(`http://${address}/api/rooms`);
    expect(await rooms.json()).toMatchObject({ rooms: [{ code: welcome.room.code }] });

    const second = await connect(address);
    const { welcome: joined } = await joinWithInitialState(second, {
      ...baseJoin, action: "JOIN_CODE", roomCode: welcome.room.code, guestUuid: "ws-u2", callsign: "WsBravo",
    });
    expect(joined.room.code).toBe(welcome.room.code);
    expect(joined.room.players.filter((p) => !p.isBot)).toHaveLength(2);

    const binary = await waitForPacket(first, (data, isBinary) => {
      if (isBinary && data instanceof ArrayBuffer) return decodeWorldSnapshotBinary(data);
    });
    expect(binary.players).toHaveLength(4);
  });

  it("applies queued sprint inputs, preserves the player on a full-room reconnect, and rejects stale movement", async () => {
    const address = await listen();
    const first = await connect(address);
    const request = { ...baseJoin, mode: "1v1", mapId: "cargo_docks", isPublic: false, botFill: false } satisfies JoinMessage;
    const { welcome, local } = await joinWithInitialState(first, request);
    const second = await connect(address);
    const { welcome: teammate } = await joinWithInitialState(second, {
      ...request, action: "JOIN_CODE", roomCode: welcome.room.code, guestUuid: "ws-u2", callsign: "WsBravo",
    });
    expect(teammate.room.players).toHaveLength(2);

    const progressed = waitForLocalState(first, (state) => state.inputAck === 18);
    sendSprint(first, local, 1, 18);
    const afterSprint = await progressed;
    expect(distanceBetween(local, afterSprint)).toBeGreaterThan(1);

    const hostMigrated = waitForPacket(second, (data, isBinary) => {
      if (isBinary) return undefined;
      const msg = JSON.parse(data.toString()) as ServerToClientMessage;
      if (msg.type === "ROOM_STATE" && msg.room.players.some((player) => player.id === teammate.yourPlayerId && player.isHost)) return true;
    });
    first.close();
    await hostMigrated;

    const reconnect = await connect(address);
    const resumed = await joinWithInitialState(reconnect, { ...request, action: "JOIN_CODE", roomCode: welcome.room.code });
    expect(resumed.welcome.reconnected).toBe(true);
    expect(resumed.welcome.yourPlayerId).toBe(welcome.yourPlayerId);
    expect(resumed.local.movementEpoch).toBeGreaterThan(afterSprint.movementEpoch);
    expect(resumed.local.inputAck).toBe(afterSprint.inputAck);
    expect(distanceBetween(afterSprint, resumed.local)).toBeLessThan(0.01);

    const idle = waitForLocalState(reconnect, (state) => state.serverTick >= resumed.local.serverTick + 4);
    sendSprint(reconnect, afterSprint, 19, 24);
    const idleState = await idle;
    expect(idleState.inputAck).toBe(18);
    expect(distanceBetween(resumed.local, idleState)).toBeLessThan(0.01);

    const moved = waitForLocalState(reconnect, (state) => state.inputAck === 30);
    sendSprint(reconnect, resumed.local, 19, 30);
    expect(distanceBetween(resumed.local, await moved)).toBeGreaterThan(0.8);
  });
});
