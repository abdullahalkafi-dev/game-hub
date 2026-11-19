export type ThrowableType = "frag" | "smoke" | "flashbang";
export type ThrowablePair = [ThrowableType, ThrowableType];
export type ThrowableStock = Record<ThrowableType, number>;
export const THROWABLE_ORDER: readonly ThrowableType[] = ["frag", "flashbang", "smoke"];

export interface ThrowableBlueprint {
  id: ThrowableType;
  name: string;
  description: string;
  fuseSec: number;
  cookable: boolean;
  throwSpeed: number;
  restitution: number;
  effectRadius: number;
  maxDamage: number;
  durationSec: number;
  colorHex: string;
}

export const THROWABLE_REGISTRY: Record<ThrowableType, ThrowableBlueprint> = {
  frag: {
    id: "frag",
    name: "M67 Frag Grenade",
    description: "A timed blast that damages nearby opponents.",
    fuseSec: 3.5,
    cookable: true,
    throwSpeed: 21,
    restitution: 0.45,
    effectRadius: 7.5,
    maxDamage: 140,
    durationSec: 0.4,
    colorHex: "#5b7c42",
  },
  smoke: {
    id: "smoke",
    name: "M18 Smoke Grenade",
    description: "Deploys a dense 12-second tactical smoke screen to cross sniper lanes.",
    fuseSec: 1.5,
    cookable: false,
    throwSpeed: 20,
    restitution: 0.4,
    effectRadius: 4.8,
    maxDamage: 0,
    durationSec: 12.0,
    colorHex: "#8d99ae",
  },
  flashbang: {
    id: "flashbang",
    name: "M84 Flashbang",
    description: "Blinds and deafens enemies facing the detonation within 14 meters.",
    fuseSec: 1.2,
    cookable: true,
    throwSpeed: 22,
    restitution: 0.5,
    effectRadius: 14.0,
    maxDamage: 5,
    durationSec: 2.8,
    colorHex: "#e9c46a",
  },
};

export const THROWABLE_LIST: ThrowableBlueprint[] = Object.values(THROWABLE_REGISTRY);

export function getThrowablePair(preferred: ThrowableType, equipped?: ThrowablePair): ThrowablePair {
  const first = equipped?.[0];
  const second = equipped?.[1];
  if (first && second && first !== second && THROWABLE_ORDER.includes(first) && THROWABLE_ORDER.includes(second)) {
    return [first, second];
  }
  const primary = THROWABLE_ORDER.includes(preferred) ? preferred : "frag";
  return [primary, primary === "smoke" ? "frag" : "smoke"];
}

export function createThrowableStock(preferred: ThrowableType, equipped?: ThrowablePair): ThrowableStock {
  const [first, second] = getThrowablePair(preferred, equipped);
  const stock: ThrowableStock = { frag: 0, flashbang: 0, smoke: 0 };
  stock[first] = 1;
  stock[second] = 1;
  return stock;
}
