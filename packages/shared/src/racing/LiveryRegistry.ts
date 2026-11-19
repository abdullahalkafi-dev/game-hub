export type LiveryId =
  | "rosso_corsa"
  | "midnight_purple"
  | "pearl_white_stripe"
  | "matte_carbon_gold"
  | "tokyo_cyber_cyan"
  | "sunset_orange_metallic";

export type LiveryStripeStyle = "NONE" | "CENTER_DUAL" | "SIDE_FLASH" | "CARBON_HOOD" | "CYBER_BAND";

export interface LiveryDefinition {
  id: LiveryId;
  name: string;
  bodyHex: string;
  /** Babylon PBR clearCoat.intensity (0..1) */
  clearcoat: number;
  /** PBR metallic factor (0..1) */
  metallic: number;
  /** PBR surface roughness (0..1) */
  roughness: number;
  accentHex: string;
  caliperHex: string;
  rimHex: string;
  stripeStyle: LiveryStripeStyle;
}

export const LIVERY_REGISTRY: Record<LiveryId, LiveryDefinition> = {
  rosso_corsa: {
    id: "rosso_corsa",
    name: "Rosso Corsa",
    bodyHex: "#d61a21",
    clearcoat: 1.0,
    metallic: 0.45,
    roughness: 0.18,
    accentHex: "#181a20",
    caliperHex: "#f5c400",
    rimHex: "#c9d1dc",
    stripeStyle: "NONE",
  },
  midnight_purple: {
    id: "midnight_purple",
    name: "Midnight Purple",
    bodyHex: "#3a125c",
    clearcoat: 1.0,
    metallic: 0.78,
    roughness: 0.16,
    accentHex: "#b366ff",
    caliperHex: "#00e5ff",
    rimHex: "#d8dde6",
    stripeStyle: "SIDE_FLASH",
  },
  pearl_white_stripe: {
    id: "pearl_white_stripe",
    name: "Pearl White GT",
    bodyHex: "#eef2f7",
    clearcoat: 1.0,
    metallic: 0.3,
    roughness: 0.15,
    accentHex: "#1e5bff",
    caliperHex: "#e62632",
    rimHex: "#2a2f3a",
    stripeStyle: "CENTER_DUAL",
  },
  matte_carbon_gold: {
    id: "matte_carbon_gold",
    name: "Matte Carbon Gold",
    bodyHex: "#1d2026",
    clearcoat: 0.22,
    metallic: 0.4,
    roughness: 0.48,
    accentHex: "#e8b949",
    caliperHex: "#e8b949",
    rimHex: "#d9a938",
    stripeStyle: "CARBON_HOOD",
  },
  tokyo_cyber_cyan: {
    id: "tokyo_cyber_cyan",
    name: "Tokyo Cyber Cyan",
    bodyHex: "#06a8d6",
    clearcoat: 1.0,
    metallic: 0.72,
    roughness: 0.16,
    accentHex: "#ff2a9d",
    caliperHex: "#ff2a9d",
    rimHex: "#202632",
    stripeStyle: "CYBER_BAND",
  },
  sunset_orange_metallic: {
    id: "sunset_orange_metallic",
    name: "Sunset Metallic",
    bodyHex: "#f25816",
    clearcoat: 1.0,
    metallic: 0.68,
    roughness: 0.18,
    accentHex: "#14161c",
    caliperHex: "#ffae00",
    rimHex: "#2c313c",
    stripeStyle: "CENTER_DUAL",
  },
};

export const LIVERY_LIST: readonly LiveryDefinition[] = Object.values(LIVERY_REGISTRY);
export const DEFAULT_LIVERY_ID: LiveryId = "rosso_corsa";

export function isLiveryId(id: string | undefined): id is LiveryId {
  return typeof id === "string" && id in LIVERY_REGISTRY;
}

export function getLiveryDefinition(id?: string): LiveryDefinition {
  if (isLiveryId(id)) {
    return LIVERY_REGISTRY[id];
  }
  return LIVERY_REGISTRY[DEFAULT_LIVERY_ID];
}
