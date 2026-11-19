import type { AttachmentSlot, WeaponCategory } from "./WeaponRegistry.js";

export interface AttachmentModifiers {
  adsFovOverride?: number;
  adsTimeMultiplier?: number;
  recoilVerticalMultiplier?: number;
  recoilHorizontalMultiplier?: number;
  hipSpreadMultiplier?: number;
  adsSpreadMultiplier?: number;
  magSizeBonus?: number;
  magSizeMultiplier?: number;
  reloadTimeMultiplier?: number;
  damageRangeMultiplier?: number;
  moveSpeedMultiplierBonus?: number;
  hideMuzzleFlash?: boolean;
  useSuppressedAudio?: boolean;
}

export interface AttachmentBlueprint {
  id: string;
  name: string;
  shortName: string;
  slot: AttachmentSlot;
  description: string;
  modelPath: string;
  attachSocket: `socket_${AttachmentSlot}`;
  allowedCategories?: WeaponCategory[];
  modifiers: AttachmentModifiers;
}

/**
 * Modular Gun Modification Registry.
 * Each attachment snaps to a standardized glTF socket node and modifies base weapon stats.
 */
export const ATTACHMENT_REGISTRY: Record<string, AttachmentBlueprint> = {
  optic_red_dot: {
    id: "optic_red_dot",
    name: "Holo Red-Dot",
    shortName: "Red Dot",
    slot: "optic",
    description: "Crisp reflex reticle for fast close-to-mid target acquisition.",
    modelPath: "attachments/red_dot.glb",
    attachSocket: "socket_optic",
    modifiers: {
      adsFovOverride: 48,
      adsTimeMultiplier: 1.02,
      adsSpreadMultiplier: 0.9,
    },
  },
  optic_2x_acog: {
    id: "optic_2x_acog",
    name: "2x Tactical Prism",
    shortName: "2x Prism",
    slot: "optic",
    description: "2x optical magnification ideal for holding mid-lane catwalks.",
    modelPath: "attachments/acog_2x.glb",
    attachSocket: "socket_optic",
    allowedCategories: ["AR", "SMG", "SNIPER"],
    modifiers: {
      adsFovOverride: 34,
      adsTimeMultiplier: 1.12,
      adsSpreadMultiplier: 0.85,
    },
  },
  optic_6x_sniper: {
    id: "optic_6x_sniper",
    name: "6x Ballistic Scope",
    shortName: "6x Scope",
    slot: "optic",
    description: "Long-range mil-dot scope with Hold-Breath stabilization.",
    modelPath: "attachments/scope_6x.glb",
    attachSocket: "socket_optic",
    allowedCategories: ["SNIPER", "AR"],
    modifiers: {
      adsFovOverride: 18,
      adsTimeMultiplier: 1.22,
      adsSpreadMultiplier: 0.75,
    },
  },
  muzzle_suppressor: {
    id: "muzzle_suppressor",
    name: "Tactical Suppressor",
    shortName: "Suppressor",
    slot: "muzzle",
    description: "Eliminates muzzle flash, dampens shot audio, and trims vertical kick by 10%.",
    modelPath: "attachments/suppressor.glb",
    attachSocket: "socket_muzzle",
    modifiers: {
      recoilVerticalMultiplier: 0.9,
      hideMuzzleFlash: true,
      useSuppressedAudio: true,
      damageRangeMultiplier: 0.95,
    },
  },
  muzzle_compensator: {
    id: "muzzle_compensator",
    name: "Muzzle Compensator",
    shortName: "Compensator",
    slot: "muzzle",
    description: "Heavy muzzle brake cutting vertical climb by 22% and horizontal drift by 15%.",
    modelPath: "attachments/compensator.glb",
    attachSocket: "socket_muzzle",
    modifiers: {
      recoilVerticalMultiplier: 0.78,
      recoilHorizontalMultiplier: 0.85,
      damageRangeMultiplier: 1.05,
    },
  },
  grip_vertical: {
    id: "grip_vertical",
    name: "Vertical Foregrip",
    shortName: "Vert Grip",
    slot: "underbarrel",
    description: "Reduces vertical recoil kick by 20% during sustained full-auto sprays.",
    modelPath: "attachments/vert_grip.glb",
    attachSocket: "socket_underbarrel",
    allowedCategories: ["AR", "SMG"],
    modifiers: {
      recoilVerticalMultiplier: 0.8,
      hipSpreadMultiplier: 0.92,
    },
  },
  grip_angled: {
    id: "grip_angled",
    name: "Angled Ergo Grip",
    shortName: "Angled Grip",
    slot: "underbarrel",
    description: "Speeds up ADS transition by 18% and tightens horizontal spray.",
    modelPath: "attachments/angled_grip.glb",
    attachSocket: "socket_underbarrel",
    allowedCategories: ["AR", "SMG"],
    modifiers: {
      adsTimeMultiplier: 0.82,
      recoilHorizontalMultiplier: 0.85,
    },
  },
  mag_extended_quick: {
    id: "mag_extended_quick",
    name: "Extended Quick Mag",
    shortName: "Ext Quick",
    slot: "mag",
    description: "Increases magazine capacity by +35% and speeds up reloads by 18%.",
    modelPath: "attachments/ext_mag.glb",
    attachSocket: "socket_mag",
    modifiers: {
      magSizeMultiplier: 1.35,
      reloadTimeMultiplier: 0.82,
      moveSpeedMultiplierBonus: -0.01,
    },
  },
};

export const ATTACHMENT_LIST: AttachmentBlueprint[] = Object.values(ATTACHMENT_REGISTRY);

export function getAttachmentsForWeaponSlot(
  category: WeaponCategory,
  slot: AttachmentSlot
): AttachmentBlueprint[] {
  return ATTACHMENT_LIST.filter(
    (att) =>
      att.slot === slot &&
      (!att.allowedCategories || att.allowedCategories.includes(category))
  );
}
