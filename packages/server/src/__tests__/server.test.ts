import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIXED_DT,
  INPUT_FLAG_FORWARD,
  INPUT_FLAG_SPRINT,
  MAP_LIST,
  MAP_REGISTRY,
  COUNTDOWN_SEC,
  PhysicsWorld,
  createCharacterPhysics,
  createInitialFpsState,
  initRapier,
  getCameraEyePosition,
  stepFpsCharacter,
  type ServerToClientMessage,
} from "@game/shared";
import { LagCompensator } from "../systems/LagCompensator.js";
import { FpsArenaRoom, defaultPlayerLoadout, type ClientSender } from "../rooms/FpsArenaRoom.js";
import { RoomManager } from "../rooms/RoomManager.js";
import { createBotMemory, stepBotAiDecision } from "../systems/TacticalBotAi.js";

function createMockSender() {
  const messages: ServerToClientMessage[] = [];
  const binaries: ArrayBuffer[] = [];
  const sender: ClientSender = {
    sendJson: (m) => messages.push(m),
    sendBinary: (b) => binaries.push(b),
  };
  return { sender, messages, binaries };
}

describe("LagCompensator & Authoritative FPS Room", () => {
  const managers: RoomManager[] = [];

  afterEach(() => {
    while (managers.length > 0) {
      managers.pop()?.disposeAll();
    }
  });

  it("makes Easy bots react, turn toward the player, and pause between bursts", async () => {
    await initRapier();
    const map = { ...MAP_REGISTRY.cargo_docks, blocks: [] };
    const world = new PhysicsWorld(map);
    try {
      const bot = createInitialFpsState({ x: 0, y: 0, z: 0 });
      const target = createInitialFpsState({ x: 0, y: 0, z: 10 });
      const memory = createBotMemory(0);
      const step = () => {
        const decision = stepBotAiDecision("bot", "A", 100, bot, memory,
          [{ id: "player", team: "B", alive: true, state: target, hp: 100 }],
          world, map, [], true, "EASY", FIXED_DT);
        bot.yaw = decision.input.yaw;
        bot.pitch = decision.input.pitch;
        return decision;
      };
      for (let i = 0; i < 60; i++) expect(step().wantsFire).toBe(false);
      expect([step(), step()].some((decision) => decision.wantsFire)).toBe(true);
      target.position.z = -10;
      expect(step().wantsFire).toBe(false);
      expect(memory.lastSeenEnemyId).toBeNull();

      target.position.z = 10;
      bot.yaw = 0;
      const fires: number[] = [];
      for (let i = 0; i < 200; i++) if (step().wantsFire) fires.push(i);
      expect(fires.length).toBeGreaterThan(0);
      expect(fires.some((tick, i) => i > 0 && tick - fires[i - 1] >= 60)).toBe(true);
    } finally {
      world.dispose();
    }
  });

  it.each(MAP_LIST)("routes Easy bots past the new cover on $name", async (map) => {
    await initRapier();
    const world = new PhysicsWorld(map);
    try {
      for (const [index, spawn] of [...map.spawnsA, ...map.spawnsB].entries()) {
        const state = createInitialFpsState(spawn.position, spawn.yaw);
        const handle = createCharacterPhysics(world, spawn.position);
        const memory = createBotMemory(index);
        const exitDepth = map.spawnScreenZ! - 3.25;
        for (let i = 0; i < 540 && Math.abs(state.position.z) >= exitDepth; i++) {
          const { input } = stepBotAiDecision("bot", "A", 100, state, memory, [],
            world, map, [], true, "EASY", FIXED_DT);
          stepFpsCharacter(world, handle, state, input, 1, FIXED_DT);
        }
        expect(Math.abs(state.position.z), `spawn slot ${index + 1}`).toBeLessThan(exitDepth);
      }
    } finally {
      world.dispose();
    }
  });

  it("uses bounded elapsed movement credit to catch up without accelerating reloads", async () => {
    await initRapier();
    const room = new FpsArenaRoom({ code: "CRED", mode: "WARMUP", mapId: "cargo_docks", isPublic: false, botFill: false });
    try {
      const { player } = room.addOrReconnectPlayer({
        guestUuid: "movement-credit",
        callsign: "Runner",
        loadout: defaultPlayerLoadout(),
        sender: createMockSender().sender,
      });
      player.reloadTimer = 1;
      const later = player.movementCreditAtMs + 1000;

      for (let seq = 1; seq <= 24; seq++) {
        room.handleClientMessage(player.id, {
          type: "INPUT",
          seq,
          flags: INPUT_FLAG_FORWARD | INPUT_FLAG_SPRINT,
          yaw: player.state.yaw,
          pitch: 0,
          activeSlot: 0,
          clientTimeMs: 0,
          movementEpoch: player.movementEpoch,
        });
      }

      room["tick"](later);
      expect(player.latestInput.seq).toBe(3);
      expect(player.reloadTimer).toBeCloseTo(1 - FIXED_DT);

      for (let i = 0; i < 5; i++) room["tick"](later);
      expect(player.latestInput.seq).toBe(12);
      expect(player.inputQueue).toHaveLength(12);

      room["tick"](later + FIXED_DT * 1000);
      expect(player.latestInput.seq).toBe(13);
    } finally {
      room.stop();
    }
  });

  it("rewinds target hitboxes accurately using 1-second LagCompensator history", () => {
    const lag = new LagCompensator();
    lag.recordFrame(1000, new Map([
      [
        "p2",
        {
          playerId: "p2",
          headCenter: { x: 0, y: 1.62, z: 0 },
          headRadius: 0.21,
          chestMin: { x: -0.28, y: 0.78, z: -0.28 },
          chestMax: { x: 0.28, y: 1.46, z: 0.28 },
          limbMin: { x: -0.26, y: 0, z: -0.26 },
          limbMax: { x: 0.26, y: 0.78, z: 0.26 },
        },
      ],
    ]));

    lag.recordFrame(1100, new Map([
      [
        "p2",
        {
          playerId: "p2",
          headCenter: { x: 4, y: 1.62, z: 0 },
          headRadius: 0.21,
          chestMin: { x: 3.72, y: 0.78, z: -0.28 },
          chestMax: { x: 4.28, y: 1.46, z: 0.28 },
          limbMin: { x: 3.74, y: 0, z: -0.26 },
          limbMax: { x: 4.26, y: 0.78, z: 0.26 },
        },
      ],
    ]));

    const rewound50ms = lag.getRewoundHitboxes("p2", 50, 1100);
    expect(rewound50ms).not.toBeNull();
    expect(rewound50ms!.headCenter.x).toBeCloseTo(2.0, 3);
  });

  it("handles 4-letter codes, host migration, and 20s reconnect grace", async () => {
    await initRapier();
    const mgr = new RoomManager();
    managers.push(mgr);

    const room = mgr.createRoom({
      mode: "2v2",
      mapId: "cargo_docks",
      isPublic: true,
      botFill: false,
    });

    expect(room.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(mgr.getRoomByCode(room.code)).toBe(room);

    const c1 = createMockSender();
    const c2 = createMockSender();

    const join1 = room.addOrReconnectPlayer({
      guestUuid: "uuid-host",
      callsign: "HostOne",
      loadout: defaultPlayerLoadout(),
      sender: c1.sender,
    });
    const join2 = room.addOrReconnectPlayer({
      guestUuid: "uuid-mate",
      callsign: "MateTwo",
      loadout: defaultPlayerLoadout(),
      sender: c2.sender,
    });

    expect(join1.player.isHost).toBe(true);
    expect(join2.player.isHost).toBe(false);

    room.handleClientMessage(join1.player.id, { type: "START_MATCH" });
    const stateAfterStart = room.getRoomStateBroadcast();
    expect(stateAfterStart.phase).toBe("COUNTDOWN");

    room.handleDisconnect(join1.player.id);
    const stateAfterDc = room.getRoomStateBroadcast();
    const p2AfterDc = stateAfterDc.players.find((p) => p.id === join2.player.id);
    expect(p2AfterDc?.isHost).toBe(true);

    const c1New = createMockSender();
    const rejoin = room.addOrReconnectPlayer({
      guestUuid: "uuid-host",
      callsign: "HostOne",
      loadout: defaultPlayerLoadout(),
      sender: c1New.sender,
    });
    expect(rejoin.reconnected).toBe(true);
    expect(rejoin.player.id).toBe(join1.player.id);
  });

  it("processes authoritative shots, 3-zone armor/HP math, and damage breakdown cards", async () => {
    await initRapier();
    const mgr = new RoomManager();
    managers.push(mgr);

    const room = mgr.createRoom({
      mode: "1v1",
      mapId: "neon_rooftop",
      isPublic: false,
      botFill: false,
    });

    const cA = createMockSender();
    const cB = createMockSender();

    const pA = room.addOrReconnectPlayer({
      guestUuid: "u-a",
      callsign: "ShooterA",
      loadout: {
        primary: { weaponId: "kar98k", skinId: "carbon_gold", attachments: {} },
        secondary: { weaponId: "deagle", skinId: "standard_issue", attachments: {} },
        throwable: "frag",
      },
      sender: cA.sender,
    });
    const pB = room.addOrReconnectPlayer({
      guestUuid: "u-b",
      callsign: "TargetB",
      loadout: defaultPlayerLoadout(),
      sender: cB.sender,
    });

    pA.player.state.position = { x: 0, y: 0.36, z: -4 };
    pB.player.state.position = { x: 0, y: 0.36, z: 4 };

    cA.messages.length = 0;
    cB.messages.length = 0;

    room.handleClientMessage(pA.player.id, {
      type: "FIRE_SHOT",
      seq: 1,
      origin: { x: 0, y: 1.5, z: -3.5 },
      dir: { x: 0, y: 0, z: 1 },
      activeSlot: 0,
      ads: true,
      crouching: false,
      grounded: true,
      clientTimeMs: Date.now(),
    });

    const confirm1 = cA.messages.find((m) => m.type === "HIT_CONFIRM") as
      | Extract<ServerToClientMessage, { type: "HIT_CONFIRM" }>
      | undefined;
    expect(confirm1).toBeDefined();
    expect(confirm1?.hitZone).toBe("CHEST");
    expect(pB.player.hp).toBeLessThan(100);
    expect(pB.player.armor).toBeLessThan(50);

    pA.player.nextShotAllowedAtMs = 0;
    cA.messages.length = 0;
    cB.messages.length = 0;

    room.handleClientMessage(pA.player.id, {
      type: "FIRE_SHOT",
      seq: 2,
      origin: { x: 0, y: 1.98, z: -3.5 },
      dir: { x: 0, y: 0, z: 1 },
      activeSlot: 0,
      ads: true,
      crouching: false,
      grounded: true,
      clientTimeMs: Date.now(),
    });

    const confirmKill = cA.messages.find((m) => m.type === "HIT_CONFIRM") as
      | Extract<ServerToClientMessage, { type: "HIT_CONFIRM" }>
      | undefined;
    expect(confirmKill?.tier).toBe("KILL");
    expect(confirmKill?.hitZone).toBe("HEAD");

    const breakdown = cB.messages.find((m) => m.type === "DAMAGE_BREAKDOWN") as
      | Extract<ServerToClientMessage, { type: "DAMAGE_BREAKDOWN" }>
      | undefined;
    expect(breakdown).toBeDefined();
    expect(breakdown?.breakdown.killerName).toBe("ShooterA");
    expect(breakdown?.breakdown.takenHeadshots).toBe(1);
  });

  it("reports one shotgun blast with eight paths and one hit confirmation", async () => {
    await initRapier();
    const room = new FpsArenaRoom({ code: "SHOT", mode: "1v1", mapId: "cargo_docks", isPublic: false, botFill: false });
    try {
      const client = createMockSender();
      const loadout = defaultPlayerLoadout();
      loadout.primary = { weaponId: "m870", skinId: "standard_issue", attachments: {} };
      const { player } = room.addOrReconnectPlayer({ guestUuid: "shooter", callsign: "Shooter", loadout, sender: client.sender });
      const { player: opponent } = room.addOrReconnectPlayer({ guestUuid: "target", callsign: "Target", loadout, sender: createMockSender().sender });
      player.state.position = { x: 0, y: 0, z: -12 };
      opponent.state.position = { x: 0, y: 0, z: -9.5 };
      room.handleClientMessage(player.id, { type: "FIRE_SHOT", seq: 1, origin: { x: 0, y: 1.2, z: -12 },
        dir: { x: 0, y: 0, z: 1 }, activeSlot: 0, ads: true, crouching: false, grounded: true, clientTimeMs: Date.now() });
      const reports = client.messages.filter((message) => message.type === "SHOT_FIRED");
      const confirmations = client.messages.filter((message) => message.type === "HIT_CONFIRM");
      expect(reports).toHaveLength(1);
      expect(reports[0].paths).toHaveLength(8);
      expect(reports[0].paths.some((path) => path.playerId === opponent.id)).toBe(true);
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0].damage).toBeGreaterThan(15);
    } finally {
      room.stop();
    }
  });

  it("reports the steel practice target as the end of an unobstructed warmup shot", async () => {
    await initRapier();
    const room = new FpsArenaRoom({ code: "STEEL", mode: "WARMUP", mapId: "cargo_docks", isPublic: false, botFill: false });
    try {
      const client = createMockSender();
      const { player } = room.addOrReconnectPlayer({
        guestUuid: "practice", callsign: "Practice", loadout: defaultPlayerLoadout(), sender: client.sender,
      });
      player.state.position = { x: 0, y: 0, z: 7.5 };
      room.handleClientMessage(player.id, {
        type: "FIRE_SHOT", seq: 1, origin: { x: 0, y: 1.4, z: 7.5 }, dir: { x: 0, y: 0, z: 1 },
        activeSlot: 0, ads: true, crouching: false, grounded: true, clientTimeMs: Date.now(),
      });
      const report = client.messages.find((message) => message.type === "SHOT_FIRED");
      expect(report?.paths[0].practiceTarget).toBe(1);
      expect(report?.paths[0].end.z).toBeCloseTo(8.96);
      expect(report?.paths[0].surfaces).toHaveLength(0);
      expect(client.messages.some((message) => message.type === "HIT_CONFIRM")).toBe(false);
    } finally {
      room.stop();
    }
  });

  describe("Team Deathmatch", () => {
    async function createMatch(startMatch = true, mode: "TDM" | "WARMUP" | "1v1" | "2v2" = "TDM") {
      await initRapier();
      const room = new FpsArenaRoom({ code: "TDM", mode, mapId: "cargo_docks", isPublic: false, botFill: false });
      const client = createMockSender();
      const otherClient = createMockSender();
      const { player: alpha } = room.addOrReconnectPlayer({
        guestUuid: "alpha", callsign: "Alpha", loadout: defaultPlayerLoadout(), sender: client.sender,
      });
      const { player: bravo } = room.addOrReconnectPlayer({
        guestUuid: "bravo", callsign: "Bravo", loadout: defaultPlayerLoadout(), sender: otherClient.sender,
      });
      const internals = room as unknown as {
        tick: (clockMs: number) => void;
        stepMatchClock: (dt: number) => void;
        applyDamageToPlayer: (attacker: typeof alpha, victim: typeof bravo, amount: number, zone: "HEAD",
          weapon: string, armorPen: number, wallbang: boolean, distance: number) => void;
        scoreA: number;
        phase: string;
      };
      let clock = performance.now();
      const step = (ticks: number) => {
        for (let i = 0; i < ticks; i++) internals.tick(clock += FIXED_DT * 1000);
      };
      const damage = (attacker: typeof alpha, victim: typeof bravo, amount: number) =>
        internals.applyDamageToPlayer(attacker, victim, amount, "HEAD", "m416", 1, false, 3);
      if (startMatch) {
        room.beginMatch();
        step(COUNTDOWN_SEC * 60 + 1);
      }
      return { room, client, otherClient, alpha, bravo, step, damage, internals };
    }

    it("swaps optics instantly mid-life, validates the sight and keeps the magazine", async () => {
      const { room, alpha } = await createMatch();
      try {
        alpha.ammoInMag[0] = 11;
        room.handleClientMessage(alpha.id, { type: "SET_OPTIC", slot: 0, optic: "optic_2x_acog" });
        expect(alpha.loadout.primary.attachments.optic).toBe("optic_2x_acog");
        expect(alpha.effectivePrimary.equippedAttachments.optic).toBe("optic_2x_acog");
        expect(alpha.ammoInMag[0]).toBe(11);

        room.handleClientMessage(alpha.id, { type: "SET_OPTIC", slot: 0, optic: "not_a_real_sight" });
        expect(alpha.loadout.primary.attachments.optic).toBe("optic_2x_acog");

        room.handleClientMessage(alpha.id, { type: "SET_OPTIC", slot: 0, optic: null });
        expect(alpha.loadout.primary.attachments.optic).toBeUndefined();
      } finally {
        room.dispose?.();
      }
    });

    it("keeps the winner in place and applies the defeated player's kit immediately and across a protected respawn", async () => {
      const { room, client, alpha, bravo, step, damage } = await createMatch();
      try {
        alpha.state.position = { x: 3, y: 0, z: 2 };
        alpha.hp = 75;
        alpha.ammoInMag[0] = 19;
        const kit = defaultPlayerLoadout();
        kit.primary.weaponId = "m870";
        kit.tdmThrowables = ["flashbang", "smoke"];
        room.handleClientMessage(bravo.id, { type: "SET_LOADOUT", loadout: kit });
        expect(bravo.effectivePrimary.weaponId).toBe("m870");
        expect(bravo.throwableStock).toEqual({ frag: 0, flashbang: 1, smoke: 1 });

        const epoch = alpha.movementEpoch;
        damage(alpha, bravo, 100);
        expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "LIVE", scoreA: 1, scoreB: 0 });
        expect(alpha.state.position).toEqual({ x: 3, y: 0, z: 2 });
        expect(alpha.movementEpoch).toBe(epoch);
        expect(alpha.hp).toBe(75);
        expect(alpha.ammoInMag[0]).toBe(19);
        expect(bravo.alive).toBe(false);

        step(179);
        expect(bravo.alive).toBe(false);
        step(1);
        expect(bravo.alive).toBe(true);
        expect(bravo.spawnProtection).toBe(2);
        expect(bravo.effectivePrimary.weaponId).toBe("m870");
        expect(bravo.throwableStock).toEqual({ frag: 0, flashbang: 1, smoke: 1 });
        damage(alpha, bravo, 40);
        expect(bravo.hp).toBe(100);
        client.messages.length = 0;
        room.handleClientMessage(alpha.id, {
          type: "FIRE_SHOT",
          seq: 1,
          origin: { x: bravo.state.position.x, y: bravo.state.position.y + 1.2, z: bravo.state.position.z - 1.2 },
          dir: { x: 0, y: 0, z: 1 },
          activeSlot: 0,
          ads: true,
          crouching: false,
          grounded: true,
          clientTimeMs: Date.now(),
        });
        expect(client.messages).toContainEqual(expect.objectContaining({ type: "HIT_CONFIRM", tier: "PROTECTED", damage: 0 }));
        expect(bravo.hp).toBe(100);
        room.handleClientMessage(bravo.id, {
          type: "FIRE_SHOT", seq: 1, origin: getCameraEyePosition(bravo.state), dir: { x: 0, y: 0, z: -1 },
          activeSlot: 0, ads: true, crouching: false, grounded: true, clientTimeMs: Date.now(),
        });
        expect(bravo.spawnProtection).toBe(0);
        damage(alpha, bravo, 40);
        expect(bravo.hp).toBe(60);
      } finally {
        room.stop();
      }
    });

    it("restores health gradually after five damage-free seconds and restarts the delay on a hit", async () => {
      const { room, alpha, bravo, step, damage } = await createMatch();
      try {
        damage(alpha, bravo, 40);
        step(240);
        expect(bravo.hp).toBe(60);
        damage(alpha, bravo, 10);
        step(299);
        expect(bravo.hp).toBe(50);
        step(61);
        expect(bravo.hp).toBeCloseTo(60, 0);
        step(241);
        expect(bravo.hp).toBe(100);
      } finally {
        room.stop();
      }
    });

    it("reports and applies the same healing countdown during TDM warm-up", async () => {
      const { room, client, alpha, bravo, step, damage } = await createMatch(false);
      try {
        expect(room.getRoomStateBroadcast().phase).toBe("WARMUP");
        damage(bravo, alpha, 40);
        step(240);
        expect(alpha.hp).toBe(60);
        let state = client.messages.findLast((message) => message.type === "LOCAL_STATE");
        expect(state?.healingDelaySeconds).toBeCloseTo(1);
        step(120);
        state = client.messages.findLast((message) => message.type === "LOCAL_STATE");
        expect(state?.healingDelaySeconds).toBe(0);
        expect(state?.hp).toBeCloseTo(70, 0);
        expect(room.getRoomStateBroadcast().phase).toBe("WARMUP");
      } finally {
        room.stop();
      }
    });

    it.each(["WARMUP", "1v1", "2v2", "TDM"] as const)("regenerates health in %s", async (mode) => {
      const { room, alpha, bravo, step, damage, internals } = await createMatch(mode !== "WARMUP", mode);
      try {
        damage(bravo, alpha, 30);
        step(299);
        expect(alpha.hp).toBe(70);
        step(61);
        expect(alpha.hp).toBeCloseTo(80, 0);
      } finally {
        room.stop();
      }
    });

    it("authorizes a rear knife hit, records a streak, and sends the victim a bounded replay", async () => {
      const { room, client, otherClient, alpha, bravo, step } = await createMatch();
      try {
        alpha.state.position = { x: 0, y: 0, z: -12 };
        alpha.state.yaw = 0;
        bravo.state.position = { x: 0, y: 0, z: -10.5 };
        bravo.state.yaw = 0;
        step(165);
        room.handleClientMessage(alpha.id, { type: "MELEE", movementEpoch: alpha.movementEpoch + 1 });
        expect(bravo.hp).toBe(100);
        room.handleClientMessage(alpha.id, { type: "MELEE", movementEpoch: alpha.movementEpoch });
        expect(bravo.alive).toBe(false);
        expect(alpha.combatStats.longestStreak).toBe(1);
        expect(client.messages.find((message) => message.type === "KILL_FEED")).toMatchObject({ weaponId: "knife" });
        const replay = otherClient.messages.find((message) => message.type === "DEATH_REPLAY");
        expect(replay?.killerId).toBe(alpha.id);
        expect(replay?.frames.length).toBe(32);
        expect(replay?.frames[0]?.timeMs).toBe(0);
      } finally {
        room.stop();
      }
    });

    it("enforces custom team damage and the match timer and grants a pickup only once", async () => {
      const { room, client, alpha, bravo, step, damage } = await createMatch(false);
      try {
        bravo.team = alpha.team;
        damage(bravo, alpha, 25);
        expect(alpha.hp).toBe(100);
        room.handleClientMessage(alpha.id, { type: "UPDATE_ROOM_SETTINGS", matchRules: { timeLimitSeconds: 80, friendlyFire: true } });
        damage(bravo, alpha, 25);
        expect(alpha.hp).toBe(75);
        const pickup = room.getRoomStateBroadcast().pickups?.find((item) => item.kind === "armor");
        expect(pickup).toBeDefined();
        alpha.state.position = pickup!.position;
        alpha.armor = 5;
        step(10);
        expect(alpha.armor).toBe(30);
        expect(client.messages.filter((message) => message.type === "PICKUP_COLLECTED")).toHaveLength(1);
        room.beginMatch();
        step(COUNTDOWN_SEC * 60 + 1);
        expect(room.getRoomStateBroadcast()).toMatchObject({ timeRemainingSec: 80, matchRules: { friendlyFire: true, timeLimitSeconds: 80 } });
      } finally {
        room.stop();
      }
    });

    it("sends a distinct curved path for long sniper shots", async () => {
      const { room, client, alpha } = await createMatch(false);
      try {
        const loadout = defaultPlayerLoadout();
        loadout.primary = { weaponId: "kar98k", skinId: "standard_issue", attachments: {} };
        room.handleClientMessage(alpha.id, { type: "SET_LOADOUT", loadout });
        const origin = { x: 0, y: 12, z: -24 };
        room.handleClientMessage(alpha.id, {
          type: "FIRE_SHOT", seq: 1, origin, dir: { x: 0, y: 0.06, z: 1 },
          activeSlot: 0, ads: true, crouching: false, grounded: true, clientTimeMs: Date.now(),
        });
        const shot = client.messages.find((message) => message.type === "SHOT_FIRED");
        const path = shot?.paths[0];
        const firstBend = path?.bends?.[0];
        expect(firstBend).toBeDefined();
        expect(path?.bends).toHaveLength(3);
        const initialSlope = (firstBend!.y - origin.y) / (firstBend!.z - origin.z);
        expect(path!.end.y).toBeLessThan(origin.y + initialSlope * (path!.end.z - origin.z) - 0.5);
      } finally {
        room.stop();
      }
    });

    it("debits only the equipped throwable and rejects another throw when it is spent", async () => {
      const { room, client, alpha } = await createMatch();
      try {
        for (const throwable of ["flashbang", "smoke", "smoke", "frag"] as const) {
          room.handleClientMessage(alpha.id, {
            type: "THROW_GRENADE", throwable, origin: getCameraEyePosition(alpha.state),
            dir: { x: 0, y: 0, z: 1 }, cookElapsedSec: 0, movementEpoch: alpha.movementEpoch,
          });
        }
        expect(client.messages.filter((message) => message.type === "THROWABLE_SPAWNED").map((message) => message.throwable))
          .toEqual(["smoke", "frag"]);
        expect(alpha.throwableStock).toEqual({ frag: 0, flashbang: 0, smoke: 0 });
      } finally {
        room.stop();
      }
    });

    it("bounces grenades off Cargo Docks spawn cover", async () => {
      await initRapier();
      const world = new PhysicsWorld(MAP_REGISTRY.cargo_docks);
      try {
        const position = { x: -6, y: 1.62, z: -26 };
        const velocity = { x: 0, y: 2.8, z: 21 };
        let collided = false;
        for (let i = 0; i < 30 && !collided; i++) collided = world.stepThrowable(position, velocity, 0.45, FIXED_DT);
        expect(collided).toBe(true);
        expect(position.z).toBeLessThan(-22);
        expect(velocity.z).toBeLessThan(0);
      } finally {
        world.dispose();
      }
    });

    it("ends at the default 20-kill limit or when the 8-minute timer runs out", async () => {
      const { room, client, alpha, bravo, damage, internals } = await createMatch();
      try {
        expect(room.getRoomStateBroadcast().matchRules).toMatchObject({ timeLimitSeconds: 480, scoreLimit: 20 });
        internals.scoreA = 19;
        damage(alpha, bravo, 100);
        expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "MATCH_END", scoreA: 20 });
        expect(client.messages.find((message) => message.type === "MATCH_ENDED"))
          .toMatchObject({ winnerTeam: "A" });

        room.beginMatch();
        internals.stepMatchClock(COUNTDOWN_SEC + 0.01);
        damage(bravo, alpha, 100);
        internals.stepMatchClock(478);
        expect(room.getRoomStateBroadcast().phase).toBe("LIVE");
        internals.stepMatchClock(2);
        expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "MATCH_END", scoreA: 0, scoreB: 1 });
        expect(client.messages.filter((message) => message.type === "MATCH_ENDED").at(-1))
          .toMatchObject({ winnerTeam: "B" });
      } finally {
        room.stop();
      }
    });

    it("lets the host pick the time and kill limit, and supports unlimited time", async () => {
      const { room, alpha, bravo, damage, internals } = await createMatch(false, "1v1");
      try {
        room.handleClientMessage(alpha.id, { type: "UPDATE_ROOM_SETTINGS",
          matchRules: { timeLimitSeconds: 0, scoreLimit: 3 } });
        expect(room.getRoomStateBroadcast().matchRules).toMatchObject({ timeLimitSeconds: 0, scoreLimit: 3 });
        room.beginMatch();
        internals.stepMatchClock(COUNTDOWN_SEC + 0.01);
        internals.stepMatchClock(60 * 60);
        expect(room.getRoomStateBroadcast().phase).toBe("LIVE");
        for (let i = 0; i < 2; i++) {
          damage(alpha, bravo, 100);
          bravo.alive = true;
          bravo.hp = 100;
          expect(room.getRoomStateBroadcast().phase).toBe("LIVE");
        }
        damage(alpha, bravo, 100);
        expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "MATCH_END", scoreA: 3 });
      } finally {
        room.stop();
      }
    });

    it("keeps duels continuous: the victim respawns at once while the killer stays put and no round resets", async () => {
      const { room, alpha, bravo, step, damage } = await createMatch(true, "1v1");
      try {
        const killerSpot = { ...alpha.state.position };
        damage(alpha, bravo, 100);
        expect(bravo.alive).toBe(false);
        expect(room.getRoomStateBroadcast()).toMatchObject({ phase: "LIVE", scoreA: 1, scoreB: 0 });
        step(Math.ceil(3.2 * 60));
        expect(bravo.alive).toBe(true);
        expect(bravo.spawnProtection).toBeGreaterThan(0);
        expect(alpha.state.position.x).toBeCloseTo(killerSpot.x, 5);
        expect(alpha.state.position.z).toBeCloseTo(killerSpot.z, 5);
        expect(alpha.hp).toBe(100);
        expect(room.getRoomStateBroadcast().phase).toBe("LIVE");
      } finally {
        room.stop();
      }
    });

    it("declares the player with the most kills the winner, and a draw on a tie", async () => {
      const { room, client, alpha, bravo, damage, internals } = await createMatch(true, "1v1");
      try {
        damage(alpha, bravo, 100);
        internals.stepMatchClock(480);
        expect(client.messages.filter((message) => message.type === "MATCH_ENDED").at(-1))
          .toMatchObject({ winnerTeam: alpha.team });
        room.beginMatch();
        internals.stepMatchClock(COUNTDOWN_SEC + 0.01);
        internals.stepMatchClock(480);
        expect(client.messages.filter((message) => message.type === "MATCH_ENDED").at(-1))
          .toMatchObject({ winnerTeam: "DRAW" });
      } finally {
        room.stop();
      }
    });

    it("ignores disconnect callbacks after the room has stopped", async () => {
      const { room, alpha, bravo } = await createMatch();
      vi.useFakeTimers();
      try {
        room.handleDisconnect(alpha.id);
        room.stop();
        room.handleDisconnect(bravo.id);
        expect(vi.getTimerCount()).toBe(0);
        expect(() => room.stop()).not.toThrow();
      } finally {
        vi.useRealTimers();
        room.stop();
      }
    });
  });

  it("detonates explosive barrels and throwables (frag/flashbang)", async () => {
    await initRapier();
    const mgr = new RoomManager();
    managers.push(mgr);

    const room = mgr.createRoom({
      mode: "WARMUP",
      mapId: "cargo_docks",
      isPublic: false,
      botFill: false,
    });

    const cA = createMockSender();
    const cB = createMockSender();

    const pA = room.addOrReconnectPlayer({
      guestUuid: "ov-a",
      callsign: "Alpha",
      loadout: defaultPlayerLoadout(),
      sender: cA.sender,
    });
    const pB = room.addOrReconnectPlayer({
      guestUuid: "ov-b",
      callsign: "Bravo",
      loadout: defaultPlayerLoadout(),
      sender: cB.sender,
    });

    // Test Explosive Barrel destruction & radial splash damage
    // barrel_1 in cargo_docks is at (-12.5, 0.65, -7.5)
    pB.player.state.position = { x: -12.5, y: 0, z: -5.5 }; // 2m from barrel_1
    pA.player.state.position = { x: -12.5, y: 0, z: -12.0 };
    cA.messages.length = 0;

    // Shoot barrel_1 twice with M416 (maxHp 45, chest 24 -> 2 shots destroy)
    room.handleClientMessage(pA.player.id, {
      type: "FIRE_SHOT",
      seq: 1,
      origin: { x: -12.5, y: 0.7, z: -11.0 },
      dir: { x: 0, y: 0, z: 1 },
      activeSlot: 0,
      ads: true,
      crouching: false,
      grounded: true,
      clientTimeMs: Date.now(),
    });
    pA.player.nextShotAllowedAtMs = 0;
    room.handleClientMessage(pA.player.id, {
      type: "FIRE_SHOT",
      seq: 2,
      origin: { x: -12.5, y: 0.7, z: -11.0 },
      dir: { x: 0, y: 0, z: 1 },
      activeSlot: 0,
      ads: true,
      crouching: false,
      grounded: true,
      clientTimeMs: Date.now(),
    });

    // Barrels burn for a short fuse before detonating.
    expect(cA.messages.find((m) => m.type === "PROP_DAMAGED")).toBeDefined();
    for (let i = 0; i < 40; i++) {
      (room as unknown as { stepBarrelFuses: (dt: number) => void }).stepBarrelFuses(1 / 60);
    }
    const destroyedMsg = cA.messages.find((m) => m.type === "PROP_DESTROYED");
    expect(destroyedMsg).toBeDefined();
    expect(pB.player.hp).toBeLessThan(100);

    // Test Flashbang view-angle blinding
    pB.player.state.position = { x: 0, y: 0, z: 0 };
    pB.player.state.yaw = 0;
    pB.player.state.pitch = 0;
    cB.messages.length = 0;

    room.handleClientMessage(pA.player.id, {
      type: "THROW_GRENADE",
      throwable: "flashbang",
      origin: { x: 0, y: 1.5, z: 3 },
      dir: { x: 0, y: -0.2, z: -1 },
      cookElapsedSec: 1.0,
    });
    // Step throwables through fuse
    for (let i = 0; i < 20; i++) {
      (room as unknown as { stepThrowables: (dt: number) => void }).stepThrowables(1 / 60);
    }
    const flashed = cB.messages.find((m) => m.type === "FLASHED");
    expect(flashed).toBeDefined();
  });
});
