import { readFile, rename, writeFile } from "node:fs/promises";
import { STARTING_RATING, type TeamId } from "@game/shared";

interface RatedPlayer {
  guestUuid: string;
  callsign: string;
  team: TeamId;
}

interface Rating {
  callsign: string;
  rating: number;
  matches: number;
}

export class Rankings {
  private readonly entries = new Map<string, Rating>();
  private pending = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const entries = JSON.parse(await readFile(this.file, "utf8")) as [string, Rating][];
      for (const [id, entry] of entries) {
        if (typeof id === "string" && typeof entry.callsign === "string" &&
          Number.isFinite(entry.rating) && Number.isSafeInteger(entry.matches)) this.entries.set(id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Unable to read StrikeCore ratings", error);
    }
  }

  ratingOf(guestUuid: string): number {
    return this.entries.get(guestUuid)?.rating ?? STARTING_RATING;
  }

  record(players: readonly RatedPlayer[], winner: TeamId | "DRAW", connected: ReadonlySet<string>): Map<string, number> {
    const changes = new Map<string, number>();
    const teams = { A: players.filter((p) => p.team === "A"), B: players.filter((p) => p.team === "B") };
    const average = (team: TeamId) => teams[team].reduce((total, p) => total + this.ratingOf(p.guestUuid), 0) / Math.max(1, teams[team].length);
    const expectedA = 1 / (1 + 10 ** ((average("B") - average("A")) / 400));
    for (const player of players) {
      const before = this.ratingOf(player.guestUuid);
      const expected = player.team === "A" ? expectedA : 1 - expectedA;
      const score = !connected.has(player.guestUuid) ? 0 : winner === "DRAW" ? 0.5 : winner === player.team ? 1 : 0;
      const rating = Math.max(100, before + Math.round(28 * (score - expected)));
      const matches = (this.entries.get(player.guestUuid)?.matches ?? 0) + 1;
      this.entries.set(player.guestUuid, { callsign: player.callsign.slice(0, 32), rating, matches });
      changes.set(player.guestUuid, rating - before);
    }
    const contents = JSON.stringify([...this.entries]);
    this.pending = this.pending.then(async () => {
      const temporary = this.file + ".tmp";
      await writeFile(temporary, contents);
      await rename(temporary, this.file);
    }).catch((error: unknown) => console.warn("Unable to save StrikeCore ratings", error));
    return changes;
  }

  leaderboard(): Rating[] {
    return [...this.entries.values()].sort((a, b) => b.rating - a.rating || b.matches - a.matches).slice(0, 25);
  }
}
