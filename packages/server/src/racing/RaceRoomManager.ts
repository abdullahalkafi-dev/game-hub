import type { BotDifficulty, RaceMode, RacePublicRoomSummary, TrackId } from "@game/shared";
import { RaceRoom } from "./RaceRoom.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RaceRoomManager {
  private readonly rooms = new Map<string, RaceRoom>();

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = "";
      for (let i = 0; i < 4; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return `C${Date.now().toString(36).slice(-3).toUpperCase()}`;
  }

  public createRoom(opts: {
    mode: RaceMode;
    trackId: TrackId;
    isPublic: boolean;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
  }): RaceRoom {
    const code = this.generateUniqueCode();
    const room = new RaceRoom({
      code,
      isPublic: opts.isPublic,
      mode: opts.mode,
      trackId: opts.trackId,
      botFill: opts.botFill,
      botDifficulty: opts.botDifficulty,
      onEmpty: (emptyCode) => this.removeRoom(emptyCode),
    });
    room.startLoop();
    this.rooms.set(code, room);
    return room;
  }

  public findOrCreatePublicRoom(opts: {
    mode: RaceMode;
    trackId: TrackId;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
  }): RaceRoom {
    const desiredDiff = opts.botDifficulty ?? "NORMAL";
    for (const room of this.rooms.values()) {
      if (
        room.isPublic &&
        room.mode === opts.mode &&
        room.trackId === opts.trackId &&
        room.botFill === opts.botFill &&
        room.botDifficulty === desiredDiff &&
        room.canJoin()
      ) {
        return room;
      }
    }
    return this.createRoom({
      mode: opts.mode,
      trackId: opts.trackId,
      isPublic: true,
      botFill: opts.botFill,
      botDifficulty: desiredDiff,
    });
  }

  public getRoomByCode(code: string): RaceRoom | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  public listPublicRooms(): RacePublicRoomSummary[] {
    return Array.from(this.rooms.values())
      .filter((r) => r.isPublic)
      .map((r) => r.getSummary());
  }

  public removeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.stop();
    this.rooms.delete(code);
  }

  public get roomCount(): number {
    return this.rooms.size;
  }

  public disposeAll(): void {
    for (const room of this.rooms.values()) {
      room.stop();
    }
    this.rooms.clear();
  }
}
