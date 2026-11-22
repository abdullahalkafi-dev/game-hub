import { ATTACHMENT_REGISTRY } from "../registries/AttachmentRegistry.js";
import { WEAPON_REGISTRY, type AttachmentSlot, type WeaponBlueprint } from "../registries/WeaponRegistry.js";

export type EquippedAttachments = Partial<Record<AttachmentSlot, string>>;

export interface PlayerWeaponConfig {
  weaponId: string;
  skinId: string;
  attachments: EquippedAttachments;
}

export interface EffectiveWeaponStats {
  weaponId: string;
  name: string;
  blueprint: WeaponBlueprint;
  damageHead: number;
  damageChest: number;
  damageLimb: number;
  armorPenetration: number;
  pellets: number;
  rpm: number;
  shotIntervalSec: number;
  magSize: number;
  reserveAmmoMax: number;
  reloadTacticalSec: number;
  reloadEmptySec: number;
  adsTimeSec: number;
  adsFov: number;
  hipSpreadDeg: number;
  adsSpreadDeg: number;
  moveSpeedMultiplier: number;
  recoilVertical: number;
  recoilHorizontal: number;
  recoilRecoverySpeed: number;
  wallbangPower: number;
  maxRangeMeters: number;
  hideMuzzleFlash: boolean;
  useSuppressedAudio: boolean;
  equippedAttachments: EquippedAttachments;
}

/**
 * Pure shared function merging a base weapon blueprint with valid socket attachments.
 * Used identically on Client (Gunsmith stat bars, recoil, ADS, mag) and Server (validation).
 */
export function computeEffectiveWeaponStats(
  weaponId: string,
  requestedAttachments?: EquippedAttachments
): EffectiveWeaponStats {
  const base = WEAPON_REGISTRY[weaponId] ?? WEAPON_REGISTRY.m416;
  const equipped: EquippedAttachments = {};

  let adsFov = base.stats.adsFov;
  let adsTimeMs = base.stats.adsTimeMs;
  let recoilVertMult = 1.0;
  let recoilHorizMult = 1.0;
  let hipSpreadMult = 1.0;
  let adsSpreadMult = 1.0;
  let magBonus = 0;
  let magMult = 1.0;
  let reloadMult = 1.0;
  let rangeMult = 1.0;
  let moveBonus = 0;
  let hideMuzzleFlash = false;
  let useSuppressedAudio = false;

  const source = requestedAttachments ?? base.defaultAttachments ?? {};

  for (const slot of base.allowedSlots) {
    const attId = source[slot];
    if (!attId) continue;
    const att = ATTACHMENT_REGISTRY[attId];
    if (!att || att.slot !== slot) continue;
    if (att.allowedCategories && !att.allowedCategories.includes(base.category)) continue;

    equipped[slot] = att.id;
    const m = att.modifiers;
    if (m.adsFovOverride !== undefined) adsFov = m.adsFovOverride;
    if (m.adsTimeMultiplier !== undefined) adsTimeMs *= m.adsTimeMultiplier;
    if (m.recoilVerticalMultiplier !== undefined) recoilVertMult *= m.recoilVerticalMultiplier;
    if (m.recoilHorizontalMultiplier !== undefined) recoilHorizMult *= m.recoilHorizontalMultiplier;
    if (m.hipSpreadMultiplier !== undefined) hipSpreadMult *= m.hipSpreadMultiplier;
    if (m.adsSpreadMultiplier !== undefined) adsSpreadMult *= m.adsSpreadMultiplier;
    if (m.magSizeBonus !== undefined) magBonus += m.magSizeBonus;
    if (m.magSizeMultiplier !== undefined) magMult *= m.magSizeMultiplier;
    if (m.reloadTimeMultiplier !== undefined) reloadMult *= m.reloadTimeMultiplier;
    if (m.damageRangeMultiplier !== undefined) rangeMult *= m.damageRangeMultiplier;
    if (m.moveSpeedMultiplierBonus !== undefined) moveBonus += m.moveSpeedMultiplierBonus;
    if (m.hideMuzzleFlash) hideMuzzleFlash = true;
    if (m.useSuppressedAudio) useSuppressedAudio = true;
  }

  if (base.category === "SNIPER" && !equipped.optic) adsFov = 46;

  const magSize = Math.max(1, Math.round(base.stats.magSize * magMult + magBonus));

  return {
    weaponId: base.id,
    name: base.name,
    blueprint: base,
    damageHead: base.stats.damage.head,
    damageChest: base.stats.damage.chest,
    damageLimb: base.stats.damage.limb,
    armorPenetration: base.stats.armorPenetration,
    pellets: base.stats.pellets,
    rpm: base.stats.rpm,
    shotIntervalSec: 60 / base.stats.rpm,
    magSize,
    reserveAmmoMax: magSize * base.stats.reserveMags,
    reloadTacticalSec: Number((base.stats.reloadTimeSec.tactical * reloadMult).toFixed(2)),
    reloadEmptySec: Number((base.stats.reloadTimeSec.empty * reloadMult).toFixed(2)),
    adsTimeSec: Math.max(0.08, (adsTimeMs / 1000)),
    adsFov,
    hipSpreadDeg: base.stats.hipSpreadDeg * hipSpreadMult,
    adsSpreadDeg: base.stats.adsSpreadDeg * adsSpreadMult,
    moveSpeedMultiplier: Math.max(0.65, base.stats.moveSpeedMultiplier + moveBonus),
    recoilVertical: base.recoilPattern.vertical * recoilVertMult,
    recoilHorizontal: base.recoilPattern.horizontalJitter * recoilHorizMult,
    recoilRecoverySpeed: base.recoilPattern.recoverySpeed,
    wallbangPower: base.stats.wallbangPower,
    maxRangeMeters: base.stats.maxRangeMeters * rangeMult,
    hideMuzzleFlash,
    useSuppressedAudio,
    equippedAttachments: equipped,
  };
}
