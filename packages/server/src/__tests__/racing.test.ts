import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import {
  FIXED_DT,
  LAUNCH_GREEN_ZONE_MAX,
  LAUNCH_GREEN_ZONE_MIN,
  LIVERY_LIST,
  LIVERY_REGISTRY,
  PERFECT_LAUNCH_DURATION_SEC,
  RACING_PROTOCOL_VERSION,
  RIM_LIST,
  SPOILER_LIST,
  TRACK_LIST,
  TRACK_REGISTRY,
  TUNE_LIST,
  UNDERGLOW_LIST,
  VEHICLE_LIST,
  VEHICLE_REGISTRY,
  computeEffectiveVehicleStats,
  createEmptyRaceInput,
  createInitialVehicleState,
  defaultCarSetup,
  getTrackCheckpoints,
  getTrackLength,
  getTrackStartGrid,
  isInLaunchGreenZone,
  projectPointToTrack,
  sampleTrackAtDistance,
  sampleTrackFrames,
  stepVehiclePhysics,
  type RaceClientToServerMessage,
  type RaceServerToClientMessage,
  type RivalDraftSample,
} from "@game/shared";
import { createGameServer } from "../GameServer.js";
import { createRaceBotMemory, stepRaceBotAi } from "../racing/RaceBotAi.js";
import { RaceRoom, type RaceClientSender } from "../racing/RaceRoom.js";
import { RaceRoomManager } from "../racing/RaceRoomManager.js";

function createMockRaceSender() {
  const messages: RaceServerToClientMessage[] = [];
  const sender: RaceClientSender = {
    sendJson: (m) => messages.push(m),
  };
  return { sender, messages };
}

function readyDriver(room: RaceRoom, id: string): void {
  room.handleClientMessage(id, { type: "RACE_READY", gridRevision: room.getRoomStateBroadcast().gridRevision });
}

function stepRoom(room: RaceRoom, seconds: number, startMs = 0): void {
  for (let i = 1; i <= Math.round(seconds / FIXED_DT); i++) {
    room.stepSimulation(FIXED_DT, startMs + i * FIXED_DT * 1000);
  }
}

function waitForRacePacket<T>(
  ws: WebSocket,
  read: (msg: RaceServerToClientMessage) => T | undefined,
  timeoutMs = 3500
): Promise<T> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timer);
      ws.off("message", handler);
    }
    function handler(data: WebSocket.RawData): void {
      try {
        const msg = JSON.parse(data.toString()) as RaceServerToClientMessage;
        if (msg.type === "RACE_ERROR") {
          cleanup();
          reject(new Error(msg.message));
          return;
        }
        const res = read(msg);
        if (res === undefined) return;
        cleanup();
        resolve(res);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for race WS packet"));
    }, timeoutMs);
    ws.on("message", handler);
  });
}

describe("ApexDrive Registries (Vehicles, Parts, Liveries)", () => {
  it("defines all 4 vehicle archetypes with distinct audio profiles and 3-bar stats", () => {
    expect(VEHICLE_LIST).toHaveLength(4);
    expect(VEHICLE_REGISTRY.apex_gt.engineAudioProfile).toBe("V10_SUPER");
    expect(VEHICLE_REGISTRY.apex_gt.modelAsset).toBe("/assets/racing/ferrari.glb");
    expect(VEHICLE_REGISTRY.skyline_r34.engineAudioProfile).toBe("I6_TURBO");
    expect(VEHICLE_REGISTRY.viper_v8.engineAudioProfile).toBe("V8_MUSCLE");
    expect(VEHICLE_REGISTRY.rally_rs.engineAudioProfile).toBe("BOXER_RALLY");

    for (const v of VEHICLE_LIST) {
      expect(v.stats.topSpeed).toBeGreaterThanOrEqual(70);
      expect(v.stats.acceleration).toBeGreaterThanOrEqual(70);
      expect(v.stats.driftGrip).toBeGreaterThanOrEqual(70);
      expect(v.gearTopSpeedsKmh).toHaveLength(6);
    }
  });

  it("computes effective stats across Street, Track Grip, and Drift Spec tunes", () => {
    expect(TUNE_LIST).toHaveLength(3);
    expect(SPOILER_LIST).toHaveLength(3);
    expect(RIM_LIST).toHaveLength(3);
    expect(UNDERGLOW_LIST).toHaveLength(5);
    expect(LIVERY_LIST).toHaveLength(6);

    const street = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const track = computeEffectiveVehicleStats("apex_gt", "tune_track");
    const drift = computeEffectiveVehicleStats("apex_gt", "tune_drift");

    expect(track.topSpeedKmh).toBeGreaterThan(street.topSpeedKmh);
    expect(track.lateralGrip).toBeGreaterThan(street.lateralGrip);
    expect(drift.driftControl).toBeGreaterThan(street.driftControl);
    expect(drift.nitroDriftChargeRate).toBeGreaterThan(street.nitroDriftChargeRate);
    expect(LIVERY_REGISTRY.rosso_corsa.clearcoat).toBe(1.0);
    expect(LIVERY_REGISTRY.tokyo_cyber_cyan.accentHex).toBeTruthy();
  });
});

describe("Catmull-Rom 3D Track Splines", () => {
  it.each(TRACK_LIST)("builds a clean non-self-intersecting closed loop for $id", (bp) => {
    const frames = sampleTrackFrames(bp);
    const length = getTrackLength(bp);
    const checkpoints = getTrackCheckpoints(bp);
    const grid = getTrackStartGrid(bp, 8);

    expect(frames.length).toBe(bp.sampleCount);
    expect(length).toBeGreaterThan(1200);
    expect(checkpoints).toHaveLength(bp.checkpointCount);
    expect(grid).toHaveLength(8);

    // Closed loop seamless join
    const first = frames[0];
    const last = frames[frames.length - 1];
    const seamDist = Math.hypot(
      first.position.x - last.position.x,
      first.position.y - last.position.y,
      first.position.z - last.position.z
    );
    expect(seamDist).toBeLessThan(length / frames.length * 1.4);

    // Non-self-intersecting XZ clearance and smooth curve radius > road half-width + shoulder
    let minNonAdjDist = Infinity;
    let maxCurvature = 0;
    for (let i = 0; i < frames.length; i++) {
      const a = frames[i];
      expect(a.roadWidth).toBeGreaterThanOrEqual(16);
      expect(a.roadWidth).toBeLessThanOrEqual(21);
      maxCurvature = Math.max(maxCurvature, Math.abs(a.curvature));
      for (let j = i + 25; j < frames.length; j++) {
        if (i + frames.length - j < 25) continue;
        const b = frames[j];
        const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        if (d < minNonAdjDist) minNonAdjDist = d;
      }
    }
    expect(minNonAdjDist).toBeGreaterThan(40);
    const minRadius = 1 / Math.max(maxCurvature, 1e-6);
    expect(minRadius).toBeGreaterThan(bp.defaultRoadWidth * 0.5 + bp.shoulderWidth + 15);

    // Start grid slots have generous spacing with zero overlap
    for (let i = 0; i < grid.length; i++) {
      for (let j = i + 1; j < grid.length; j++) {
        const d = Math.hypot(
          grid[i].position.x - grid[j].position.x,
          grid[i].position.z - grid[j].position.z
        );
        expect(d).toBeGreaterThan(6.0);
      }
    }

    // Projection round-trip accuracy
    const mid = sampleTrackAtDistance(bp, length * 0.37);
    const offsetPt = {
      x: mid.position.x + mid.right.x * 4.2,
      y: mid.position.y + mid.right.y * 4.2,
      z: mid.position.z + mid.right.z * 4.2,
    };
    const proj = projectPointToTrack(bp, offsetPt);
    expect(proj.lateralOffset).toBeCloseTo(4.2, 1);
    expect(proj.surfaceY).toBeCloseTo(offsetPt.y, 1);
  });

  it("includes distinct theme features: Tokyo tunnel, Coastal elevation & gravel, Harbor 3-lap straight", () => {
    const tokyoFrames = sampleTrackFrames("tokyo_midnight");
    expect(tokyoFrames.filter((f) => f.isTunnel).length).toBeGreaterThan(25);
    expect(TRACK_REGISTRY.tokyo_midnight.laps).toBe(2);

    const coastalFrames = sampleTrackFrames("coastal_sunset");
    const maxElev = Math.max(...coastalFrames.map((f) => f.position.y));
    expect(maxElev).toBeGreaterThan(18);
    expect(coastalFrames.some((f) => f.hasGravelShoulder)).toBe(true);

    expect(TRACK_REGISTRY.harbor_gp.laps).toBe(3);
  });
});

describe("VehiclePhysics (Launch, Drift-to-Nitro, Slipstream, Guardrails, Gears)", () => {
  it("only awards a lap after sequential checkpoints and a forward finish-line crossing", () => {
    const track = TRACK_REGISTRY.tokyo_midnight;
    const stats = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const length = getTrackLength(track);
    const finalCheckpoint = getTrackCheckpoints(track).length - 1;
    const crossing = (distance: number, speed: number, checkpointIndex: number, reset = false) => {
      const frame = sampleTrackAtDistance(track, distance);
      const state = createInitialVehicleState(track, 0, stats);
      Object.assign(state, {
        position: { ...frame.position },
        yaw: frame.yaw,
        distanceAlongLap: distance,
        trackFrameIndex: frame.index,
        velocity: { x: frame.forward.x * speed, y: 0, z: frame.forward.z * speed },
        checkpointIndex,
      });
      return stepVehiclePhysics(state, { ...createEmptyRaceInput(1), reset }, stats, track, {
        gridLocked: false, raceElapsedMs: 20000, totalLaps: 2,
      });
    };

    expect(crossing(length - 0.2, 25, finalCheckpoint).completedLap).toBe(1);
    expect(crossing(length - 0.2, 25, 0).completedLap).toBeNull();
    expect(crossing(length - 0.2, 25, finalCheckpoint - 1).completedLap).toBeNull();
    expect(crossing(0.1, -18, finalCheckpoint).completedLap).toBeNull();
    expect(crossing(length - 0.2, 25, finalCheckpoint, true)).toMatchObject({
      completedLap: null, resetTriggered: true,
    });
  });

  it("triggers 1.8s Perfect Launch boost when revved inside Green Zone [0.65..0.85] at GO!", () => {
    const stats = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const state = createInitialVehicleState("tokyo_midnight", 0, stats);

    // Hold ~75% throttle on locked grid to reach Green Zone
    let seq = 1;
    for (let i = 0; i < 65; i++) {
      stepVehiclePhysics(
        state,
        { ...createEmptyRaceInput(seq++), throttle: 0.74 },
        stats,
        "tokyo_midnight",
        { gridLocked: true, raceElapsedMs: 0, totalLaps: 2 }
      );
    }
    expect(state.rpmNorm).toBeGreaterThanOrEqual(LAUNCH_GREEN_ZONE_MIN);
    expect(state.rpmNorm).toBeLessThanOrEqual(LAUNCH_GREEN_ZONE_MAX);
    expect(isInLaunchGreenZone(state.rpmNorm)).toBe(true);

    const goEvents = stepVehiclePhysics(
      state,
      { ...createEmptyRaceInput(seq++), throttle: 1.0 },
      stats,
      "tokyo_midnight",
      { gridLocked: false, launchGoThisTick: true, raceElapsedMs: 16, totalLaps: 2 }
    );
    expect(goEvents.perfectLaunch).toBe(true);
    expect(state.launchBoostTimer).toBeCloseTo(PERFECT_LAUNCH_DURATION_SEC - FIXED_DT, 2);
    expect(state.nitro).toBeGreaterThan(35);
    expect(state.speedKmh).toBeGreaterThan(20);
  });

  it("charges Nitro and builds Drift Combo score + multiplier while drifting, then banks cleanly", () => {
    const stats = computeEffectiveVehicleStats("skyline_r34", "tune_drift");
    const state = createInitialVehicleState("harbor_gp", 0, stats);
    state.nitro = 10;

    let seq = 1;
    let elapsedMs = 0;
    // Accelerate straight up to ~175 km/h
    for (let i = 0; i < 210; i++) {
      elapsedMs += FIXED_DT * 1000;
      stepVehiclePhysics(
        state,
        { ...createEmptyRaceInput(seq++), throttle: 1 },
        stats,
        "harbor_gp",
        { gridLocked: false, raceElapsedMs: elapsedMs, totalLaps: 3 }
      );
    }
    expect(state.speedKmh).toBeGreaterThan(150);
    const nitroBeforeDrift = state.nitro;

    // Initiate handbrake power-slide drift while turning right
    let sawDrift = false;
    let peakDriftScore = 0;
    for (let i = 0; i < 90; i++) {
      elapsedMs += FIXED_DT * 1000;
      stepVehiclePhysics(
        state,
        {
          ...createEmptyRaceInput(seq++),
          throttle: 0.9,
          steer: 0.85,
          handbrake: i < 25,
        },
        stats,
        "harbor_gp",
        { gridLocked: false, raceElapsedMs: elapsedMs, totalLaps: 3 }
      );
      if (state.drifting) sawDrift = true;
      peakDriftScore = Math.max(peakDriftScore, state.currentDriftScore);
    }
    expect(sawDrift).toBe(true);
    expect(state.nitro).toBeGreaterThan(nitroBeforeDrift + 5);
    expect(peakDriftScore).toBeGreaterThan(100);

    // Straighten out to let drift combo bank
    for (let i = 0; i < 120; i++) {
      elapsedMs += FIXED_DT * 1000;
      stepVehiclePhysics(
        state,
        { ...createEmptyRaceInput(seq++), throttle: 0.5, steer: 0 },
        stats,
        "harbor_gp",
        { gridLocked: false, raceElapsedMs: elapsedMs, totalLaps: 3 }
      );
    }
    expect(state.totalDriftScore).toBeGreaterThan(100);
  });

  it("activates Slipstream Drafting Cone (<22m behind rival) for +10% top speed & 1.5x Nitro fill", () => {
    const stats = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const solo = createInitialVehicleState("harbor_gp", 0, stats);
    const drafter = createInitialVehicleState("harbor_gp", 0, stats);
    solo.nitro = 20;
    drafter.nitro = 20;

    // Start both moving fast along the straight
    solo.velocity.z = 82;
    drafter.velocity.z = 82;
    solo.forwardSpeed = 82;
    drafter.forwardSpeed = 82;

    let elapsedMs = 0;
    let sawSlipstream = false;
    for (let i = 0; i < 150; i++) {
      elapsedMs += FIXED_DT * 1000;
      stepVehiclePhysics(solo, { ...createEmptyRaceInput(i + 1), throttle: 1 }, stats, "harbor_gp", {
        gridLocked: false,
        raceElapsedMs: elapsedMs,
        totalLaps: 3,
      });

      const leadCar: RivalDraftSample = {
        id: "lead",
        position: { x: drafter.position.x, y: drafter.position.y, z: drafter.position.z + 12 },
        yaw: drafter.yaw,
        forwardSpeed: 95,
      };
      stepVehiclePhysics(drafter, { ...createEmptyRaceInput(i + 1), throttle: 1 }, stats, "harbor_gp", {
        gridLocked: false,
        raceElapsedMs: elapsedMs,
        totalLaps: 3,
        rivals: [leadCar],
        selfId: "self",
      });
      if (drafter.slipstreamActive) sawSlipstream = true;
    }

    expect(sawSlipstream).toBe(true);
    expect(drafter.speedKmh).toBeGreaterThan(solo.speedKmh + 12);
    expect(drafter.nitro).toBeGreaterThan(solo.nitro + 8);
  });

  it("contains cars inside guardrails with scrape bounce, supports manual gears & [R] reset", () => {
    const stats = computeEffectiveVehicleStats("viper_v8", "tune_street");
    const state = createInitialVehicleState("tokyo_midnight", 0, stats);
    state.velocity.z = 35;
    state.forwardSpeed = 35;

    let scraped = false;
    let elapsedMs = 0;
    for (let i = 0; i < 120; i++) {
      elapsedMs += FIXED_DT * 1000;
      stepVehiclePhysics(
        state,
        { ...createEmptyRaceInput(i + 1), throttle: 1, steer: 1, transmission: "MANUAL", shiftUp: i === 5 },
        stats,
        "tokyo_midnight",
        { gridLocked: false, raceElapsedMs: elapsedMs, totalLaps: 2 }
      );
      if (state.wallScrapeIntensity > 0.1) scraped = true;
      expect(Math.abs(state.lateralOffset)).toBeLessThanOrEqual(12.0);
    }
    expect(scraped).toBe(true);
    expect(state.gear).toBe(2);

    // Trigger instant [R] track centerline reset
    const resEvents = stepVehiclePhysics(
      state,
      { ...createEmptyRaceInput(200), reset: true },
      stats,
      "tokyo_midnight",
      { gridLocked: false, raceElapsedMs: elapsedMs + 16, totalLaps: 2 }
    );
    expect(resEvents.resetTriggered).toBe(true);
    expect(Math.abs(state.lateralOffset)).toBeLessThan(0.5);
    expect(state.speedKmh).toBe(0);
  });
});

describe("RaceBotAi Navigation & Difficulty Scaling", () => {
  it.each(TRACK_LIST)("drives bots smoothly around $id with PRO faster than EASY", (track) => {
    const stats = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const easyState = createInitialVehicleState(track, 0, stats);
    const proState = createInitialVehicleState(track, 0, stats);
    const easyMem = createRaceBotMemory(0, "EASY");
    const proMem = createRaceBotMemory(0, "PRO");

    let elapsedMs = 0;
    // Simulate 12 seconds (720 ticks at 60Hz)
    for (let i = 0; i < 720; i++) {
      elapsedMs += FIXED_DT * 1000;
      const easyIn = stepRaceBotAi({
        botId: "easy",
        state: easyState,
        memory: easyMem,
        track,
        rivals: [],
        difficulty: "EASY",
        mode: "GRAND_PRIX",
        gridLocked: false,
        dt: FIXED_DT,
      });
      const proIn = stepRaceBotAi({
        botId: "pro",
        state: proState,
        memory: proMem,
        track,
        rivals: [],
        difficulty: "PRO",
        mode: "GRAND_PRIX",
        gridLocked: false,
        dt: FIXED_DT,
      });
      stepVehiclePhysics(easyState, easyIn, stats, track, {
        gridLocked: false,
        raceElapsedMs: elapsedMs,
        totalLaps: track.laps,
      });
      stepVehiclePhysics(proState, proIn, stats, track, {
        gridLocked: false,
        raceElapsedMs: elapsedMs,
        totalLaps: track.laps,
      });
    }

    expect(easyState.totalRaceDistanceM).toBeGreaterThan(320);
    expect(proState.totalRaceDistanceM).toBeGreaterThan(easyState.totalRaceDistanceM + 35);
    expect(proState.wrongWay).toBe(false);
  });
});

describe("Authoritative RaceRoom & WebSocket /ws/race Transport", () => {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let raceWss: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];
  const managers: RaceRoomManager[] = [];

  async function listen(): Promise<string> {
    const game = await createGameServer();
    server = game.server;
    wss = game.wss;
    raceWss = game.raceWss;
    await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
    const address = game.server.address();
    if (!address || typeof address === "string") throw new Error("Server failed to bind");
    return `127.0.0.1:${address.port}`;
  }

  async function connectRace(address: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://${address}/ws/race`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  }

  afterEach(async () => {
    while (managers.length > 0) {
      managers.pop()?.disposeAll();
    }
    await Promise.all(
      sockets.splice(0).map((ws) => {
        if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
        return new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        });
      })
    );
    if (raceWss) await new Promise<void>((resolve) => raceWss!.close(() => resolve()));
    if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    wss = undefined;
    raceWss = undefined;
  });

  it("waits for the grid, locks live races, and neutralizes stale and disconnected inputs", () => {
    const room = new RaceRoom({
      code: "TEST", mode: "GRAND_PRIX", trackId: "tokyo_midnight", isPublic: true, botFill: true,
    });
    try {
      const { participant: host } = room.addOrReconnectPlayer({
        guestUuid: "race-u1", callsign: "Host", sender: createMockRaceSender().sender,
      });
      const { participant: guest } = room.addOrReconnectPlayer({
        guestUuid: "race-u2", callsign: "Guest", sender: createMockRaceSender().sender,
      });
      readyDriver(room, host.id);
      stepRoom(room, 5);
      expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "LOBBY", waitingForReady: true });

      room.handleClientMessage(host.id, { type: "RACE_UPDATE_SETTINGS", trackId: "coastal_sunset" });
      const gridRevision = room.getRoomStateBroadcast().gridRevision;
      room.handleClientMessage(guest.id, { type: "RACE_READY", gridRevision: gridRevision - 1 });
      readyDriver(room, host.id);
      expect(room.getRoomStateBroadcast().phase).toBe("LOBBY");
      readyDriver(room, guest.id);
      expect(room.getRoomStateBroadcast().phase).toBe("COUNTDOWN");
      expect(room.canJoin("late-arrival")).toBe(false);
      stepRoom(room, 4, 5000);

      room.handleClientMessage(host.id, { type: "RACE_UPDATE_SETTINGS", trackId: "harbor_gp" });
      room.handleClientMessage(host.id, { type: "RACE_START" });
      room.handleClientMessage(guest.id, { type: "RACE_REMATCH" });
      room.handleClientMessage(guest.id, { type: "RACE_SET_SETUP", setup: { ...defaultCarSetup(), tuneId: "tune_track" } });
      expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "RACING", trackId: "coastal_sunset", gridRevision });
      expect(guest.setup.tuneId).toBe("tune_street");

      const drive = (id: string, seq: number, throttle: number, brake = 0) => {
        room.handleClientMessage(id, { type: "RACE_INPUT", input: { ...createEmptyRaceInput(seq), throttle, brake }, clientTimeMs: 9000 });
      };
      drive(host.id, 600, 1);
      stepRoom(room, 0.5, 9000);
      expect(host.latestInput.throttle).toBe(0);
      expect(host.lastProcessedSeq).toBe(600);
      drive(host.id, 601, 1);
      stepRoom(room, FIXED_DT, 9500);
      expect(host.latestInput.throttle).toBe(1);
      room.handleDisconnect(host.id);
      expect(host.latestInput.throttle).toBe(0);
      expect(room.canJoin("race-u1")).toBe(true);
      const resumed = room.addOrReconnectPlayer({
        guestUuid: "race-u1", callsign: "Host", sender: createMockRaceSender().sender,
      });
      expect(resumed.reconnected).toBe(true);
      expect(resumed.participant.id).toBe(host.id);
      drive(host.id, 1, 0, 1);
      stepRoom(room, FIXED_DT, 9500 + FIXED_DT * 1000);
      expect(host.lastProcessedSeq).toBe(1);
      expect(host.latestInput.brake).toBe(1);
    } finally {
      room.stop();
    }
  });

  it.each(TRACK_LIST)("counts real laps and completes a Grand Prix through rematch on $id", (track) => {
    const room = new RaceRoom({
      code: "TEST", mode: "GRAND_PRIX", trackId: track.id, isPublic: false, botFill: true, botDifficulty: "EASY",
    });
    const driver = createMockRaceSender();
    const { participant } = room.addOrReconnectPlayer({
      guestUuid: "driver", callsign: "Driver", sender: driver.sender,
    });
    readyDriver(room, participant.id);
    stepRoom(room, 4);
    const memory = createRaceBotMemory(0, "PRO");
    let seq = 1;
    for (; seq <= 60 * 150; seq++) {
      const input = stepRaceBotAi({
        botId: participant.id, state: participant.state, memory, track, rivals: [],
        difficulty: "PRO", mode: "GRAND_PRIX", gridLocked: false, dt: FIXED_DT,
      });
      const now = 4000 + seq * FIXED_DT * 1000;
      room.handleClientMessage(participant.id, { type: "RACE_INPUT", input: { ...input, seq }, clientTimeMs: now });
      room.stepSimulation(FIXED_DT, now);
      if (room.getRoomStateBroadcast().phase === "PODIUM") break;
    }
    const result = room.getRoomStateBroadcast();
    expect(result.phase).toBe("PODIUM");
    expect(result.podium).toHaveLength(8);
    expect(result.podium.filter((entry) => !entry.dnf).length).toBeGreaterThan(1);
    expect(result.podium.find((entry) => entry.playerId === participant.id)).toMatchObject({ dnf: false });
    const laps = driver.messages.filter((msg) =>
      msg.type === "RACE_EVENT" && msg.event === "LAP_COMPLETE" && msg.playerId === participant.id);
    expect(laps).toHaveLength(track.laps);
    expect(participant.state.bestLapMs).toBeGreaterThan(0);

    const nextTrack = TRACK_LIST.find((other) => other.id !== track.id)!;
    room.handleClientMessage(participant.id, { type: "RACE_VOTE_TRACK", trackId: nextTrack.id });
    room.handleClientMessage(participant.id, { type: "RACE_REMATCH" });
    expect(room.getRoomStateBroadcast()).toMatchObject({
      phase: "LOBBY", trackId: nextTrack.id, gridRevision: result.gridRevision + 1, waitingForReady: true, podium: [],
    });
    readyDriver(room, participant.id);
    expect(room.getRoomStateBroadcast().phase).toBe("COUNTDOWN");
    room.stop();
  });

  it("starts solo time trials from a ready grid and lets the driver restart", () => {
    const room = new RaceRoom({ code: "SOLO", mode: "TIME_TRIAL", trackId: "harbor_gp", isPublic: true, botFill: true });
    const { participant } = room.addOrReconnectPlayer({
      guestUuid: "solo-1", callsign: "Solo", sender: createMockRaceSender().sender,
    });
    const first = room.getRoomStateBroadcast();
    expect(first).toMatchObject({ isPublic: false, botFill: false, totalLaps: 1, phase: "LOBBY" });
    expect(first.players).toHaveLength(1);
    readyDriver(room, participant.id);
    stepRoom(room, 4);
    expect(room.getRoomStateBroadcast().canRestartPractice).toBe(true);
    room.handleClientMessage(participant.id, { type: "RACE_RESTART_PRACTICE" });
    expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "LOBBY", gridRevision: first.gridRevision + 1 });
    readyDriver(room, participant.id);
    const track = TRACK_REGISTRY.harbor_gp;
    const memory = createRaceBotMemory(0, "EASY");
    for (let seq = 1; seq < 60 * 100; seq++) {
      const now = 4000 + seq * FIXED_DT * 1000;
      const input = stepRaceBotAi({
        botId: participant.id, state: participant.state, memory, track, rivals: [], difficulty: "EASY",
        mode: "TIME_TRIAL", gridLocked: room.getRoomStateBroadcast().phase !== "RACING", dt: FIXED_DT,
      });
      room.handleClientMessage(participant.id, { type: "RACE_INPUT", input: { ...input, seq }, clientTimeMs: now });
      room.stepSimulation(FIXED_DT, now);
      if (room.getRoomStateBroadcast().phase === "PODIUM") break;
    }
    const summary = room.getRoomStateBroadcast();
    expect(summary.phase).toBe("PODIUM");
    expect(summary.podium[0]).toMatchObject({ dnf: false });
    expect(summary.podium[0].bestLapMs).toBeGreaterThan(0);
    room.stop();
  });

  it("streams RACE_WELCOME, /api/race-rooms, multi-client JOIN_CODE, and RACE_INPUT acks over /ws/race", async () => {
    const address = await listen();
    const ws1 = await connectRace(address);

    const welcomePromise = waitForRacePacket(ws1, (m) => (m.type === "RACE_WELCOME" ? m : undefined));
    const snapPromise = waitForRacePacket(ws1, (m) => (m.type === "RACE_SNAPSHOT" ? m : undefined));

    ws1.send(
      JSON.stringify({
        type: "RACE_JOIN_OR_CREATE",
        action: "CREATE",
        guestUuid: "ws-race-1",
        callsign: "ApexOne",
        mode: "GRAND_PRIX",
        trackId: "tokyo_midnight",
        isPublic: true,
        botFill: true,
        botDifficulty: "NORMAL",
        setup: defaultCarSetup(),
      } satisfies RaceClientToServerMessage)
    );

    const welcome = await welcomePromise;
    const firstSnap = await snapPromise;

    expect(welcome.protocolVersion).toBe(RACING_PROTOCOL_VERSION);
    expect(welcome.room.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(welcome.room.players).toHaveLength(8);
    expect(firstSnap.cars).toHaveLength(8);

    // Verify GET /api/race-rooms lists the room
    const apiRes = await fetch(`http://${address}/api/race-rooms`);
    expect(apiRes.status).toBe(200);
    const apiJson = (await apiRes.json()) as { rooms: { code: string; trackId: string }[] };
    expect(apiJson.rooms.some((r) => r.code === welcome.room.code && r.trackId === "tokyo_midnight")).toBe(true);

    // Second player joins by room code
    const ws2 = await connectRace(address);
    const welcome2Promise = waitForRacePacket(ws2, (m) => (m.type === "RACE_WELCOME" ? m : undefined));
    ws2.send(
      JSON.stringify({
        type: "RACE_JOIN_OR_CREATE",
        action: "JOIN_CODE",
        roomCode: welcome.room.code,
        guestUuid: "ws-race-2",
        callsign: "TougeTwo",
        mode: "GRAND_PRIX",
        trackId: "tokyo_midnight",
        isPublic: true,
        botFill: true,
        setup: { ...defaultCarSetup(), vehicleId: "skyline_r34", liveryId: "midnight_purple" },
      } satisfies RaceClientToServerMessage)
    );
    const welcome2 = await welcome2Promise;
    expect(welcome2.room.code).toBe(welcome.room.code);
    expect(welcome2.room.players.filter((p) => !p.isBot)).toHaveLength(2);
    expect(welcome2.room.players).toHaveLength(8);

    const waiting = waitForRacePacket(ws1, (msg) => {
      if (msg.type !== "RACE_ROOM_STATE") return undefined;
      return msg.room.players.find((p) => p.id === welcome.yourPlayerId)?.ready ? msg.room : undefined;
    });
    ws1.send(JSON.stringify({ type: "RACE_READY", gridRevision: welcome.room.gridRevision }));
    expect(await waiting).toMatchObject({ phase: "LOBBY", waitingForReady: true });
    const starting = waitForRacePacket(ws2, (msg) =>
      msg.type === "RACE_ROOM_STATE" && msg.room.phase === "COUNTDOWN" ? msg.room : undefined);
    ws2.send(JSON.stringify({ type: "RACE_READY", gridRevision: welcome2.room.gridRevision }));
    expect((await starting).players.filter((p) => !p.isBot && p.ready)).toHaveLength(2);

    // Send 8 race inputs from player 1 and verify server acknowledges lastProcessedSeq === 8
    const ackedPromise = waitForRacePacket(ws1, (m) => {
      if (m.type !== "RACE_SNAPSHOT") return undefined;
      const self = m.cars.find((c) => c.playerId === welcome.yourPlayerId);
      return self && self.lastProcessedSeq >= 8 ? self : undefined;
    });
    for (let seq = 1; seq <= 8; seq++) {
      ws1.send(
        JSON.stringify({
          type: "RACE_INPUT",
          input: { ...createEmptyRaceInput(seq), throttle: 0.75 },
          clientTimeMs: Date.now(),
        } satisfies RaceClientToServerMessage)
      );
    }
    const acked = await ackedPromise;
    expect(acked.lastProcessedSeq).toBe(8);
    expect(acked.rpmNorm).toBeGreaterThan(0.15);

    // Verify ping/pong works cleanly
    const pongPromise = waitForRacePacket(ws1, (m) => (m.type === "RACE_PONG" ? m : undefined));
    ws1.send(JSON.stringify({ type: "RACE_PING", t0: 12345 } satisfies RaceClientToServerMessage));
    const pong = await pongPromise;
    expect(pong.t0).toBe(12345);
  });

  it("supports Nitro top-speed burst, DUEL_1V1 2-car grid, DRIFT_ATTACK scoring, and Podium transition", () => {
    const stats = computeEffectiveVehicleStats("apex_gt", "tune_street");
    const state = createInitialVehicleState("harbor_gp", 0, stats);
    state.nitro = 100;
    state.velocity.z = stats.topSpeedMps * 0.95;
    state.forwardSpeed = stats.topSpeedMps * 0.95;

    let elapsed = 0;
    for (let i = 0; i < 90; i++) {
      elapsed += FIXED_DT * 1000;
      stepVehiclePhysics(
        state,
        { ...createEmptyRaceInput(i + 1), throttle: 1, nitro: true },
        stats,
        "harbor_gp",
        { gridLocked: false, raceElapsedMs: elapsed, totalLaps: 3 }
      );
    }
    expect(state.nitroActive).toBe(true);
    expect(state.nitro).toBeLessThan(70);
    expect(state.speedKmh).toBeGreaterThan(stats.topSpeedKmh + 20);

    // DUEL_1V1 fills exactly 2 cars (1 human + 1 bot)
    const mgr = new RaceRoomManager();
    managers.push(mgr);
    const duelRoom = mgr.createRoom({
      mode: "DUEL_1V1",
      trackId: "coastal_sunset",
      isPublic: false,
      botFill: true,
      botDifficulty: "PRO",
    });
    duelRoom.stop();
    const senderDuel = createMockRaceSender();
    duelRoom.addOrReconnectPlayer({
      guestUuid: "duel-1",
      callsign: "TougeAce",
      setup: defaultCarSetup(),
      sender: senderDuel.sender,
    });
    expect(duelRoom.getRoomStateBroadcast().players).toHaveLength(2);

    const driftRoom = new RaceRoom({
      code: "DRFT", mode: "DRIFT_ATTACK", trackId: "tokyo_midnight", isPublic: false, botFill: false,
    });
    const senderDrift = createMockRaceSender();
    const { participant } = driftRoom.addOrReconnectPlayer({
      guestUuid: "drift-1", callsign: "Sideways", sender: senderDrift.sender,
    });
    const { participant: rival } = driftRoom.addOrReconnectPlayer({
      guestUuid: "drift-2", callsign: "Rival", sender: createMockRaceSender().sender,
    });
    readyDriver(driftRoom, participant.id);
    readyDriver(driftRoom, rival.id);
    stepRoom(driftRoom, 4);
    expect(driftRoom.getRoomStateBroadcast().phase).toBe("RACING");

    // A finished driver leaves the other driver time to score until the mode deadline.
    rival.state.finished = true;
    rival.state.totalDriftScore = 6500;
    participant.state.totalDriftScore = 12500;
    stepRoom(driftRoom, 1, 4000);
    expect(driftRoom.getRoomStateBroadcast().phase).toBe("RACING");
    stepRoom(driftRoom, 119, 5000);
    driftRoom.stop();
    const broadcast = driftRoom.getRoomStateBroadcast();
    expect(broadcast.phase).toBe("PODIUM");
    expect(broadcast.podium.length).toBe(2);
    expect(broadcast.podium[0].playerId).toBe(participant.id);
    expect(broadcast.podium[0].totalDriftScore).toBe(12500);
    expect(senderDrift.messages.some((m) => m.type === "RACE_EVENT" && m.event === "PODIUM_READY")).toBe(true);
  });
});
