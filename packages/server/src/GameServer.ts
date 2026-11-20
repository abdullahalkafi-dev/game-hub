import http from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MOVEMENT_PROTOCOL_VERSION,
  RACING_PROTOCOL_VERSION,
  initRapier,
  type ClientToServerMessage,
  type RaceClientToServerMessage,
  type RaceServerToClientMessage,
  type ServerToClientMessage,
} from "@game/shared";
import { RoomManager } from "./rooms/RoomManager.js";
import type { ClientSender, FpsArenaRoom } from "./rooms/FpsArenaRoom.js";
import { Rankings } from "./systems/Rankings.js";
import { RaceRoomManager } from "./racing/RaceRoomManager.js";
import type { RaceClientSender, RaceRoom } from "./racing/RaceRoom.js";
import { createAdminHandler } from "./admin/AdminModule.js";

export async function createGameServer() {
  await initRapier();
  const rankings = new Rankings(resolve(process.env.STRIKECORE_RATINGS_PATH ?? ".strikecore-ratings.json"));
  await rankings.load();
  const roomManager = new RoomManager(rankings);
  const raceRoomManager = new RaceRoomManager();
  // Private weapon-model upload area at /admin. Disabled unless ADMIN_PASSWORD is set.
  const handleAdmin = createAdminHandler({
    password: process.env.ADMIN_PASSWORD,
    uploadDir: resolve(process.env.ADMIN_UPLOAD_DIR ?? "uploads"),
  });

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          rooms: roomManager.roomCount,
          raceRooms: raceRoomManager.roomCount,
          movementProtocolVersion: MOVEMENT_PROTOCOL_VERSION,
          racingProtocolVersion: RACING_PROTOCOL_VERSION,
        })
      );
      return;
    }

    if (pathname === "/api/rooms") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rooms: roomManager.listPublicRooms() }));
      return;
    }

    if (pathname === "/api/race-rooms") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rooms: raceRoomManager.listPublicRooms() }));
      return;
    }

    if (pathname === "/api/leaderboard") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ players: rankings.leaderboard() }));
      return;
    }

    if (handleAdmin(req, res, pathname)) return;

    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  const raceWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/ws/race") {
      raceWss.handleUpgrade(req, socket, head, (ws) => {
        raceWss.emit("connection", ws, req);
      });
      return;
    }
    if (pathname === "/ws" || pathname === "/") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  // --- Game 1: StrikeCore FPS WebSocket (/ws) ---
  wss.on("connection", (ws: WebSocket) => {
    let activeRoom: FpsArenaRoom | null = null;
    let activePlayerId: string | null = null;
    let pingSentAt = 0;
    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (pingSentAt && performance.now() - pingSentAt > 6000) {
        ws.terminate();
        return;
      }
      if (!pingSentAt) {
        pingSentAt = performance.now();
        ws.ping();
      }
    }, 2000);
    ws.on("pong", () => {
      if (pingSentAt && activeRoom && activePlayerId) {
        activeRoom.recordRoundTripTime(activePlayerId, performance.now() - pingSentAt);
      }
      pingSentAt = 0;
    });

    const sender: ClientSender = {
      sendJson: (msg: ServerToClientMessage) => {
        if (ws.readyState === ws.OPEN && (msg.type !== "LOCAL_STATE" || ws.bufferedAmount < 256 * 1024)) {
          ws.send(JSON.stringify(msg));
        }
      },
      sendBinary: (buf: ArrayBuffer) => {
        if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) {
          ws.send(buf);
        }
      },
    };

    ws.on("message", (rawData) => {
      try {
        const text = typeof rawData === "string" ? rawData : rawData.toString("utf8");
        const msg = JSON.parse(text) as ClientToServerMessage;

        if (msg.type === "JOIN_OR_CREATE") {
          let targetRoom: FpsArenaRoom | undefined;
          if (msg.action === "QUICK_PLAY") {
            targetRoom = roomManager.findOrCreatePublicRoom({
              mode: msg.mode,
              mapId: msg.mapId,
              botFill: msg.botFill,
              botDifficulty: msg.botDifficulty,
              matchRules: msg.matchRules,
            });
          } else if (msg.action === "CREATE") {
            targetRoom = roomManager.createRoom({
              mode: msg.mode,
              mapId: msg.mapId,
              isPublic: msg.isPublic,
              botFill: msg.botFill,
              botDifficulty: msg.botDifficulty,
              matchRules: { ...msg.matchRules, ranked: false },
            });
          } else if (msg.action === "JOIN_CODE") {
            targetRoom = msg.roomCode ? roomManager.getRoomByCode(msg.roomCode) : undefined;
            if (!targetRoom) {
              sender.sendJson({ type: "ERROR", message: `Room "${msg.roomCode}" not found.` });
              return;
            }
            if (!targetRoom.canJoin(msg.guestUuid)) {
              sender.sendJson({ type: "ERROR", message: `Room "${msg.roomCode}" is full.` });
              return;
            }
          }

          if (!targetRoom) {
            sender.sendJson({ type: "ERROR", message: "Unable to join room." });
            return;
          }

          activeRoom = targetRoom;
          const { player, reconnected } = targetRoom.addOrReconnectPlayer({
            guestUuid: msg.guestUuid,
            callsign: msg.callsign,
            loadout: msg.loadout,
            sender,
          });
          activePlayerId = player.id;

          sender.sendJson({
            type: "WELCOME",
            yourPlayerId: player.id,
            yourPlayerIndex: player.playerIndex,
            room: targetRoom.getRoomStateBroadcast(),
            reconnected,
            movementProtocolVersion: MOVEMENT_PROTOCOL_VERSION,
          });
          targetRoom.sendLocalState(player.id);
          return;
        }

        if (activeRoom && activePlayerId) {
          activeRoom.handleClientMessage(activePlayerId, msg);
        }
      } catch (err) {
        sender.sendJson({
          type: "ERROR",
          message: err instanceof Error ? err.message : "Invalid message payload",
        });
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (activeRoom && activePlayerId) {
        activeRoom.handleDisconnect(activePlayerId);
      }
    });
  });

  // --- Game 2: ApexDrive Street Racer WebSocket (/ws/race) ---
  raceWss.on("connection", (ws: WebSocket) => {
    let activeRaceRoom: RaceRoom | null = null;
    let activeRacePlayerId: string | null = null;
    let pingSentAt = 0;

    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (pingSentAt && performance.now() - pingSentAt > 6000) {
        ws.terminate();
        return;
      }
      if (!pingSentAt) {
        pingSentAt = performance.now();
        ws.ping();
      }
    }, 2000);

    ws.on("pong", () => {
      if (pingSentAt && activeRaceRoom && activeRacePlayerId) {
        activeRaceRoom.recordRoundTripTime(activeRacePlayerId, performance.now() - pingSentAt);
      }
      pingSentAt = 0;
    });

    const sender: RaceClientSender = {
      sendJson: (msg: RaceServerToClientMessage) => {
        if (ws.readyState === ws.OPEN && (msg.type !== "RACE_SNAPSHOT" || ws.bufferedAmount < 256 * 1024)) {
          ws.send(JSON.stringify(msg));
        }
      },
    };

    ws.on("message", (rawData) => {
      try {
        const text = typeof rawData === "string" ? rawData : rawData.toString("utf8");
        const msg = JSON.parse(text) as RaceClientToServerMessage;

        if (msg.type === "RACE_JOIN_OR_CREATE") {
          if (activeRaceRoom) return;
          let targetRoom: RaceRoom | undefined;
          if (msg.action === "QUICK_PLAY" && msg.mode === "TIME_TRIAL") {
            targetRoom = raceRoomManager.createRoom({
              mode: "TIME_TRIAL",
              trackId: msg.trackId,
              isPublic: false,
              botFill: false,
            });
          } else if (msg.action === "QUICK_PLAY") {
            targetRoom = raceRoomManager.findOrCreatePublicRoom({
              mode: msg.mode,
              trackId: msg.trackId,
              botFill: msg.botFill,
              botDifficulty: msg.botDifficulty,
            });
          } else if (msg.action === "CREATE") {
            targetRoom = raceRoomManager.createRoom({
              mode: msg.mode,
              trackId: msg.trackId,
              isPublic: msg.isPublic,
              botFill: msg.botFill,
              botDifficulty: msg.botDifficulty,
            });
          } else if (msg.action === "JOIN_CODE") {
            targetRoom = msg.roomCode ? raceRoomManager.getRoomByCode(msg.roomCode) : undefined;
            if (!targetRoom) {
              sender.sendJson({ type: "RACE_ERROR", message: `Race room "${msg.roomCode}" not found.` });
              return;
            }
            if (!targetRoom.canJoin(msg.guestUuid)) {
              sender.sendJson({
                type: "RACE_ERROR",
                message: `Grid "${msg.roomCode}" is full or the race has started. Try a fresh lobby.`,
              });
              return;
            }
          }

          if (!targetRoom) {
            sender.sendJson({ type: "RACE_ERROR", message: "Unable to join race room." });
            return;
          }

          const { participant, reconnected } = targetRoom.addOrReconnectPlayer({
            guestUuid: msg.guestUuid,
            callsign: msg.callsign,
            setup: msg.setup,
            sender,
            autoStart: msg.action === "QUICK_PLAY" || msg.botFill,
          });
          activeRaceRoom = targetRoom;
          activeRacePlayerId = participant.id;

          sender.sendJson({
            type: "RACE_WELCOME",
            yourPlayerId: participant.id,
            yourPlayerIndex: participant.playerIndex,
            room: targetRoom.getRoomStateBroadcast(),
            reconnected,
            protocolVersion: RACING_PROTOCOL_VERSION,
          });
          targetRoom.sendInitialSnapshot(participant.id);
          return;
        }

        if (activeRaceRoom && activeRacePlayerId) {
          activeRaceRoom.handleClientMessage(activeRacePlayerId, msg, sender);
        }
      } catch (err) {
        sender.sendJson({
          type: "RACE_ERROR",
          message: err instanceof Error ? err.message : "Invalid race message payload",
        });
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (activeRaceRoom && activeRacePlayerId) {
        activeRaceRoom.handleDisconnect(activeRacePlayerId, sender);
      }
    });
  });

  server.on("close", () => {
    roomManager.disposeAll();
    raceRoomManager.disposeAll();
    raceWss.close();
  });

  return { server, wss, raceWss };
}
