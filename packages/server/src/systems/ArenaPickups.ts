import { BASE_ARMOR, type ArenaPickup, type MapBlueprint, type PickupKind, type Vec3 } from "@game/shared";

const POSITIONS: Record<string, [Vec3, Vec3]> = {
  cargo_docks: [{ x: -3.3, y: 0, z: -2.3 }, { x: 3.3, y: 0, z: 2.3 }],
  desert_outpost: [{ x: -3.3, y: 0, z: -3.5 }, { x: 3.3, y: 0, z: 3.5 }],
  neon_rooftop: [{ x: -3.3, y: 0, z: -3.5 }, { x: 3.3, y: 0, z: 3.5 }],
};

interface Collector {
  alive: boolean;
  armor: number;
  state: { position: Vec3 };
  ammoReserve: [number, number];
  effectivePrimary: { reserveAmmoMax: number; magSize: number };
  effectiveSecondary: { reserveAmmoMax: number; magSize: number };
}

interface Pickup extends ArenaPickup {
  availableAt: number;
}

export class ArenaPickups {
  private pickups: Pickup[] = [];

  reset(map: MapBlueprint): void {
    const positions = POSITIONS[map.id];
    this.pickups = positions ? (["armor", "ammo"] as const).map((kind, i) => ({
      id: kind, kind, position: positions[i], availableAt: 0, available: true,
    })) : [];
  }

  snapshot(): ArenaPickup[] {
    return this.pickups.map(({ id, kind, position, available }) => ({ id, kind, position, available }));
  }

  step<T extends Collector>(players: Iterable<T>, tick: number, onCollect: (player: T, kind: PickupKind) => void): boolean {
    let changed = false;
    const candidates = Array.from(players);
    for (const pickup of this.pickups) {
      if (tick < pickup.availableAt) continue;
      if (!pickup.available) {
        pickup.available = true;
        changed = true;
      }
      for (const player of candidates) {
        const p = player.state.position;
        if (!player.alive || Math.abs(p.y - pickup.position.y) > 1 ||
          (p.x - pickup.position.x) ** 2 + (p.z - pickup.position.z) ** 2 > 1.25 ** 2) continue;
        if (!this.grant(player, pickup.kind)) continue;
        pickup.available = false;
        pickup.availableAt = tick + 25 * 60;
        onCollect(player, pickup.kind);
        changed = true;
        break;
      }
    }
    return changed;
  }

  private grant(player: Collector, kind: PickupKind): boolean {
    if (kind === "armor") {
      if (player.armor >= BASE_ARMOR) return false;
      player.armor = Math.min(BASE_ARMOR, player.armor + 25);
      return true;
    }
    const before = player.ammoReserve[0] + player.ammoReserve[1];
    const primary = player.effectivePrimary;
    const secondary = player.effectiveSecondary;
    player.ammoReserve[0] = Math.min(primary.reserveAmmoMax, player.ammoReserve[0] + 2 * primary.magSize);
    player.ammoReserve[1] = Math.min(secondary.reserveAmmoMax, player.ammoReserve[1] + 2 * secondary.magSize);
    return player.ammoReserve[0] + player.ammoReserve[1] > before;
  }
}
