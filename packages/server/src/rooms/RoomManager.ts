import { normalizeMatchRules, type BotDifficulty, type GameMode, type MatchRules } from "@game/shared";
import { FpsArenaRoom } from "./FpsArenaRoom.js";
import type { Rankings } from "../systems/Rankings.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomManager {
  private readonly rooms = new Map<string, FpsArenaRoom>();

  constructor(private readonly rankings?: Rankings) {}

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = "";
      for (let i = 0; i < 4; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return `R${Date.now().toString(36).slice(-3).toUpperCase()}`;
  }

  createRoom(opts: {
    mode: GameMode;
    mapId: string;
    isPublic: boolean;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
    matchRules?: Partial<MatchRules>;
  }): FpsArenaRoom {
    const code = this.generateUniqueCode();
    const room = new FpsArenaRoom({
      code,
      isPublic: opts.isPublic,
      mode: opts.mode,
      mapId: opts.mapId,
      botFill: opts.botFill,
      botDifficulty: opts.botDifficulty,
      matchRules: opts.matchRules,
      rankings: this.rankings,
      onEmpty: (emptyCode) => this.removeRoom(emptyCode),
    });
    room.startLoop();
    this.rooms.set(code, room);
    return room;
  }

  findOrCreatePublicRoom(opts: {
    mode: GameMode;
    mapId: string;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
    matchRules?: Partial<MatchRules>;
  }): FpsArenaRoom {
    const rules = normalizeMatchRules(opts.mode, opts.matchRules);
    for (const room of this.rooms.values()) {
      if (room.isPublic && room.mode === opts.mode && room.mapId === opts.mapId &&
        room.matchRules.ranked === rules.ranked && room.matchRules.timeLimitSeconds === rules.timeLimitSeconds &&
        room.matchRules.friendlyFire === rules.friendlyFire &&
        (rules.ranked || (room.botDifficulty === (opts.botDifficulty ?? "NORMAL") && room.botFill === opts.botFill)) && room.canJoin()) {
        return room;
      }
    }
    return this.createRoom({
      mode: opts.mode,
      mapId: opts.mapId,
      isPublic: true,
      botFill: opts.botFill,
      botDifficulty: opts.botDifficulty,
      matchRules: rules,
    });
  }

  getRoomByCode(code: string): FpsArenaRoom | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  listPublicRooms() {
    return Array.from(this.rooms.values())
      .filter((r) => r.isPublic)
      .map((r) => r.getSummary());
  }

  removeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.stop();
    this.rooms.delete(code);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  disposeAll(): void {
    for (const room of this.rooms.values()) {
      room.stop();
    }
    this.rooms.clear();
  }
}
