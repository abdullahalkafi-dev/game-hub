import { WEAPON_REGISTRY, type HitMarkerTier, type Vec3 } from "@game/shared";
import type { UserSettings } from "../state/UserProfileStore.js";

const SHOT_SAMPLES = {
  AR: ["rifle-1", "rifle-2", "gun-ar-1", "gun-ar-2", "gun-ar-3"],
  SMG: ["pistol-1", "pistol-2", "gun-smg-1", "gun-smg-2", "gun-smg-3"],
  SNIPER: ["bolt-1", "bolt-2", "gun-sniper-1", "gun-sniper-2", "gun-sniper-3"],
  SHOTGUN: ["shotgun-1", "gun-shotgun-1", "gun-shotgun-2"],
  PISTOL: ["pistol-1", "pistol-2", "gun-pistol-1", "gun-pistol-2", "gun-pistol-3"],
} satisfies Record<string, readonly string[]>;

/** How many recorded variations exist for each footstep surface group (files are step-<group>-<n>.wav). */
const STEP_VARIATIONS = { stone: 5, sand: 4, metal: 6 } as const;
type StepGroup = keyof typeof STEP_VARIATIONS;
const EXPLOSION_SAMPLES = ["explosion-1", "explosion-2"] as const;

/** One-shot event sounds: knife, grenades, pickups, damage, round flow, stingers and the reload sequence. */
const EVENT_SAMPLES = [
  "knife-swing", "knife-hit", "grenade-throw", "smoke-pop", "flashbang-bang", "pickup-armor", "pickup-ammo",
  "weapon-switch", "player-hurt", "player-death", "respawn", "countdown-beep", "match-go", "match-win",
  "match-lose", "multikill", "heartbeat", "land", "ping", "reload-mag-out", "reload-mag-in", "reload-rack",
] as const;

export type FootstepMotion = "sprint" | "walk" | "crouch";

/** Loudness of each gait. Crouch-walking is deliberately close to silent, sprinting carries far. */
const MOTION_GAIN: Record<FootstepMotion, number> = { sprint: 1.0, walk: 0.58, crouch: 0.2 };

/** Per-sound-type distance behaviour: how fast the sound dulls with range and how it falls off. */
type AudioProfile = "gun" | "step" | "boom";
const PROFILES: Record<AudioProfile, { ref: number; rolloff: number; airMeters: number; occludedHz: number; occludedGain: number }> = {
  gun: { ref: 3, rolloff: 1.15, airMeters: 24, occludedHz: 1300, occludedGain: 0.62 },
  step: { ref: 2.2, rolloff: 1.5, airMeters: 10, occludedHz: 700, occludedGain: 0.5 },
  boom: { ref: 6, rolloff: 0.9, airMeters: 34, occludedHz: 900, occludedGain: 0.7 },
};

function stepGroupFor(surface: string): { group: StepGroup; rate: number; trim: number; lowpassHz?: number } {
  switch (surface) {
    case "METAL":
    case "SHEET_METAL":
    case "EXPLOSIVE_BARREL":
      return { group: "metal", rate: 1, trim: 0.95 };
    case "SANDSTONE":
      return { group: "sand", rate: 1, trim: 0.85 };
    case "WOOD_THIN":
      return { group: "stone", rate: 0.82, trim: 0.95, lowpassHz: 3400 };
    default:
      return { group: "stone", rate: 1, trim: 1 };
  }
}

/**
 * Full Web Audio API + HRTF 3D Positional Audio Engine.
 * Mixes recorded combat sounds with synthesized effects and HRTF positioning.
 */
export class SpatialAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private gunfireGain: GainNode | null = null;
  private feedbackGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly samples = new Map<string, AudioBuffer>();
  private lastHeadshotVoice = -Infinity;
  private lastPingVoice = -Infinity;
  private masterVolume = 0.75;
  private gunfireVolume = 0.55;
  private hitFeedbackVolume = 0.7;
  private headshotAnnouncer = false;
  private hrtfEnabled = true;
  private muted = false;
  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private occlusionTest: ((from: Readonly<Vec3>, to: Readonly<Vec3>) => boolean) | null = null;
  private readonly lastVariation = new Map<string, number>();
  private readonly voiceTails = new WeakMap<AudioNode, AudioNode[]>();

  unlock(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.masterFilter = this.ctx.createBiquadFilter();
      this.masterFilter.type = "lowpass";
      this.masterFilter.frequency.value = 20000;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
      this.gunfireGain = this.ctx.createGain();
      this.gunfireGain.gain.value = this.gunfireVolume;
      this.gunfireGain.connect(this.masterFilter);
      this.feedbackGain = this.ctx.createGain();
      this.feedbackGain.gain.value = this.hitFeedbackVolume;
      this.feedbackGain.connect(this.masterFilter);

      this.masterFilter.connect(this.masterGain);
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 9;
      limiter.ratio.value = 5;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.masterGain.connect(limiter);
      limiter.connect(this.ctx.destination);

      // Synthesized outdoor/industrial acoustic impulse response for resonant gunshots
      const conv = this.ctx.createConvolver();
      conv.buffer = this.buildImpulseResponse(this.ctx, 0.75);
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.11;
      this.reverbSend.connect(conv);
      conv.connect(this.gunfireGain);

      this.noiseBuffer = this.buildWhiteNoiseBuffer(this.ctx, 1.5);
      void this.loadCombatSamples(this.ctx);
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  private async loadCombatSamples(context: AudioContext): Promise<void> {
    const steps = (Object.keys(STEP_VARIATIONS) as StepGroup[]).flatMap((group) =>
      Array.from({ length: STEP_VARIATIONS[group] }, (_, i) => `step-${group}-${i + 1}`));
    const files = new Set([...Object.values(SHOT_SAMPLES).flat(), "reload-action", "headshot-voice", "enemy-spotted",
      ...steps, ...EXPLOSION_SAMPLES, "explosion-far", "hit-body", "hit-head", "hit-kill", "bullet-whiz", "glass-shatter", ...EVENT_SAMPLES]);
    await Promise.all([...files].map(async (name) => {
      try {
        const response = await fetch(`/assets/audio/${name}.wav`);
        if (response.ok) this.samples.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // The generated effects cover playback while samples load or if a file is unavailable.
      }
    }));
  }

  /** Lets world geometry muffle sounds: return true when a wall sits between the two points. */
  setOcclusionTest(test: ((from: Readonly<Vec3>, to: Readonly<Vec3>) => boolean) | null): void {
    this.occlusionTest = test;
  }

  /** Picks a random variation that is never the same one twice in a row. */
  private pickVariation(key: string, count: number): number {
    if (count <= 1) return 1;
    const last = this.lastVariation.get(key) ?? 0;
    let next = 1 + Math.floor(Math.random() * count);
    if (next === last) next = (next % count) + 1;
    this.lastVariation.set(key, next);
    return next;
  }

  private playSample(
    name: string,
    volume: number,
    rate: number,
    worldPos?: Readonly<Vec3>,
    muffled = false,
    output: AudioNode | null = this.masterFilter,
    opts: { profile?: AudioProfile; wet?: number; lowpassHz?: number } = {},
  ): boolean {
    const context = this.ctx;
    const buffer = this.samples.get(name);
    if (!context || !buffer) return false;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = context.createGain();
    level.gain.value = volume;
    const destination = this.createDestination(worldPos, output, opts.profile ?? "gun");
    const cutoff = muffled ? 2100 : opts.lowpassHz;
    const filter = cutoff ? context.createBiquadFilter() : null;
    if (filter) {
      filter.type = "lowpass";
      filter.frequency.value = cutoff!;
      source.connect(filter);
      filter.connect(level);
    } else {
      source.connect(level);
    }
    level.connect(destination);
    let send: GainNode | null = null;
    if (opts.wet && this.reverbSend) {
      send = context.createGain();
      send.gain.value = opts.wet;
      level.connect(send);
      send.connect(this.reverbSend);
    }
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      level.disconnect();
      send?.disconnect();
      if (destination !== output) this.releaseDestination(destination);
    };
    source.start();
    return true;
  }

  private buildImpulseResponse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.22));
      }
    }
    return buf;
  }

  setConfig(settings: Pick<UserSettings, "masterVolume" | "gunfireVolume" | "hitFeedbackVolume" | "headshotAnnouncer" | "hrtfEnabled">): void {
    this.masterVolume = Math.max(0, Math.min(1, settings.masterVolume));
    this.gunfireVolume = Math.max(0, Math.min(1, settings.gunfireVolume));
    this.hitFeedbackVolume = Math.max(0, Math.min(1, settings.hitFeedbackVolume));
    this.headshotAnnouncer = settings.headshotAnnouncer;
    this.hrtfEnabled = settings.hrtfEnabled;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.masterGain?.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, now, 0.02);
    this.gunfireGain?.gain.setTargetAtTime(this.gunfireVolume, now, 0.02);
    this.feedbackGain?.gain.setTargetAtTime(this.hitFeedbackVolume, now, 0.02);
  }

  /** Instantly silences or restores all output without touching the saved master volume. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx) return;
    this.masterGain?.gain.setTargetAtTime(muted ? 0 : this.masterVolume, this.ctx.currentTime, 0.015);
  }

  updateListener(pos: Readonly<Vec3>, fwd: Readonly<Vec3>, up: Readonly<Vec3>): void {
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    if (!this.ctx || this.ctx.state !== "running") return;
    const listener = this.ctx.listener;
    if (listener.positionX) {
      const t = this.ctx.currentTime;
      listener.positionX.setValueAtTime(pos.x, t);
      listener.positionY.setValueAtTime(pos.y, t);
      listener.positionZ.setValueAtTime(pos.z, t);
      listener.forwardX.setValueAtTime(fwd.x, t);
      listener.forwardY.setValueAtTime(fwd.y, t);
      listener.forwardZ.setValueAtTime(fwd.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
    } else if (listener.setPosition) {
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  private buildWhiteNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Builds the signal path for a sound at a world position: HRTF panner -> distance/occlusion low-pass -> level.
   * Returns the entry node. Pass it to releaseDestination() when the sound has finished.
   */
  private createDestination(
    worldPos?: Readonly<Vec3>,
    output: AudioNode | null = this.masterFilter,
    profile: AudioProfile = "gun",
  ): AudioNode {
    if (!this.ctx || !output) {
      throw new Error("Audio not initialized");
    }
    if (!worldPos) {
      return output;
    }
    const cfg = PROFILES[profile];
    const ctx = this.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = this.hrtfEnabled ? "HRTF" : "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = cfg.ref;
    panner.maxDistance = 200;
    panner.rolloffFactor = cfg.rolloff;
    panner.positionX.setValueAtTime(worldPos.x, ctx.currentTime);
    panner.positionY.setValueAtTime(worldPos.y, ctx.currentTime);
    panner.positionZ.setValueAtTime(worldPos.z, ctx.currentTime);

    const distance = Math.hypot(worldPos.x - this.listenerPos.x, worldPos.y - this.listenerPos.y, worldPos.z - this.listenerPos.z);
    const occluded = this.occlusionTest?.(this.listenerPos, worldPos) === true;
    // Air absorbs highs with range; a wall in the way muffles heavily and takes some level off.
    let cutoff = Math.max(900, 18000 / (1 + distance / cfg.airMeters));
    if (occluded) cutoff = Math.min(cutoff, cfg.occludedHz);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = cutoff;
    lowpass.Q.value = 0.5;
    const shade = ctx.createGain();
    shade.gain.value = occluded ? cfg.occludedGain : 1;

    panner.connect(lowpass);
    lowpass.connect(shade);
    shade.connect(output);
    this.voiceTails.set(panner, [lowpass, shade]);
    return panner;
  }

  private releaseDestination(destination: AudioNode): void {
    destination.disconnect();
    for (const node of this.voiceTails.get(destination) ?? []) node.disconnect();
    this.voiceTails.delete(destination);
  }

  playWeaponFire(weaponId: string, suppressed: boolean, worldPos?: Readonly<Vec3>): void {
    this.unlock();
    const category = WEAPON_REGISTRY[weaponId]?.category ?? "AR";
    const picks = SHOT_SAMPLES[category];
    const name = picks[Math.floor(Math.random() * picks.length)];
    const pitch = category === "SMG" ? 1.22 : weaponId === "akm" || weaponId === "awm" ? 0.93 : 1;
    const shotDistance = worldPos
      ? Math.hypot(worldPos.x - this.listenerPos.x, worldPos.y - this.listenerPos.y, worldPos.z - this.listenerPos.z)
      : 0;
    const wet = suppressed ? 0.2 : worldPos ? Math.min(4, 0.6 + shotDistance / 14) : 0.9;
    if (this.playSample(name, suppressed ? 0.26 : worldPos ? 0.6 : 0.75,
      pitch * (0.97 + Math.random() * 0.06), worldPos, suppressed, this.gunfireGain, { profile: "gun", wet })) return;
    if (!this.ctx || !this.noiseBuffer) return;

    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos, this.gunfireGain);

    // Weapon character tuning
    const isSniper = weaponId === "kar98k" || weaponId === "awm";
    const isSmg = weaponId === "ump45" || weaponId === "vector";
    const isShotgun = weaponId === "m870";

    const duration = suppressed ? 0.11 : isSniper ? 0.42 : isShotgun ? 0.34 : isSmg ? 0.13 : 0.2;
    const cutoff = suppressed ? 1400 : isSniper ? 3800 : 4800;

    // Punchy crack burst
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(suppressed ? 1600 : cutoff, now);
    filter.frequency.exponentialRampToValueAtTime(220, now + duration);
    filter.Q.value = suppressed ? 1.8 : 0.7;

    const gain = this.ctx.createGain();
    const peak = suppressed ? 0.28 : isSniper ? 0.85 : 0.6;
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    if (!suppressed && this.reverbSend) {
      gain.connect(this.reverbSend);
    }
    noise.start(now);
    noise.stop(now + duration + 0.02);

    // Sub-bass body thump
    const osc = this.ctx.createOscillator();
    osc.type = suppressed ? "sine" : "triangle";
    const startFreq = isSniper ? 145 : isShotgun ? 130 : isSmg ? 210 : 175;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.11);

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(suppressed ? 0.22 : 0.65, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    osc.connect(oscGain);
    oscGain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  playSupersonicWhiz(worldPos: Readonly<Vec3>): void {
    this.unlock();
    if (this.playSample("bullet-whiz", 0.55, 0.94 + Math.random() * 0.12, worldPos, false, this.masterFilter, { profile: "gun" })) return;
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(4200, now);
    bp.frequency.exponentialRampToValueAtTime(950, now + 0.14);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.42, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + 0.16);
  }

  playHitMarker(tier: HitMarkerTier, headshot = tier === "HEADSHOT"): void {
    this.unlock();
    if (!this.ctx || !this.feedbackGain) return;
    const now = this.ctx.currentTime;
    if (tier === "PROTECTED") {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.connect(g);
      g.connect(this.feedbackGain);
      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(260, now + 0.07);
      g.gain.setValueAtTime(0.16, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
      osc.start(now);
      osc.stop(now + 0.08);
      return;
    }
    if (headshot) {
      if (this.headshotAnnouncer && now - this.lastHeadshotVoice >= 0.85 &&
        this.playSample("headshot-voice", 0.38, 1.08, undefined, false, this.feedbackGain)) {
        this.lastHeadshotVoice = now;
      }
      if (!this.playSample("hit-head", 0.55, 1, undefined, false, this.feedbackGain)) {
        this.playImpactCue([[210, 0.075, 0.24], [1150, 0.037, 0.075], [1780, 0.047, 0.030]]);
      }
      return;
    }
    if (tier === "BODY" && this.playSample("hit-body", 0.5, 0.97 + Math.random() * 0.06, undefined, false, this.feedbackGain)) return;
    if (tier === "KILL" && this.playSample("hit-kill", 0.7, 1, undefined, false, this.feedbackGain)) return;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.connect(g);
    g.connect(this.feedbackGain);

    if (tier === "BODY") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(950, now);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.045);
      g.gain.setValueAtTime(0.28, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.055);
    } else if (tier === "ARMOR_BREAK") {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(1650, now);
      osc.frequency.exponentialRampToValueAtTime(520, now + 0.12);
      g.gain.setValueAtTime(0.32, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.start(now);
      osc.stop(now + 0.14);
    } else if (tier === "KILL") {
      // KILL chime + low drop
      osc.type = "sine";
      osc.frequency.setValueAtTime(1320, now);
      osc.frequency.setValueAtTime(1760, now + 0.045);
      g.gain.setValueAtTime(0.46, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.24);
    } else {
      osc.disconnect();
      g.disconnect();
    }
  }

  playPracticeTarget(): void {
    this.playImpactCue([[470, 0.085, 0.12], [1710, 0.17, 0.12], [2730, 0.12, 0.064], [3910, 0.08, 0.023]]);
  }

  private playImpactCue(partials: readonly [frequency: number, duration: number, volume: number][]): void {
    if (!this.ctx || !this.feedbackGain) return;
    const now = this.ctx.currentTime;
    for (const [frequency, duration, volume] of partials) {
      const osc = this.ctx.createOscillator();
      const level = this.ctx.createGain();
      osc.frequency.setValueAtTime(frequency, now);
      level.gain.setValueAtTime(0.001, now);
      level.gain.linearRampToValueAtTime(volume, now + 0.003);
      level.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(level);
      level.connect(this.feedbackGain);
      osc.start(now);
      osc.stop(now + duration + 0.005);
    }
  }

  playShellClink(worldPos: Readonly<Vec3>): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos);
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(3400 + Math.random() * 600, now);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(g);
    g.connect(dest);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /** Plays the reload as separate mag-out, mag-in (and charging-handle for an empty weapon) sounds. */
  playReloadClick(isDry: boolean, durationSec = 1.8): void {
    this.unlock();
    if (this.samples.has("reload-mag-out") && this.samples.has("reload-mag-in")) {
      this.playSample("reload-mag-out", 0.55, 1);
      window.setTimeout(() => this.playSample("reload-mag-in", 0.62, 1), Math.max(350, durationSec * 0.5 * 1000));
      if (isDry && this.samples.has("reload-rack")) {
        window.setTimeout(() => this.playSample("reload-rack", 0.6, 1), Math.max(700, durationSec * 0.82 * 1000));
      }
      return;
    }
    if (this.playSample("reload-action", isDry ? 0.38 : 0.27, isDry ? 0.98 : 1.16)) return;
    if (!this.ctx || !this.masterFilter) return;
    const now = this.ctx.currentTime;
    const playTone = (offset: number, freq: number) => {
      if (!this.ctx || !this.masterFilter) return;
      const o = this.ctx.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(freq, now + offset);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.14, now + offset);
      g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.05);
      o.connect(g);
      g.connect(this.masterFilter);
      o.start(now + offset);
      o.stop(now + offset + 0.06);
    };
    playTone(0.05, 520);
    playTone(0.65, 760);
    if (isDry) playTone(1.15, 980);
  }

  /**
   * Plays one footfall. Remote players pass their world position so the step is heard from the right
   * direction, with range, wall muffling and gait loudness. The local player's own steps stay quiet.
   */
  playFootstep(surface: string, worldPos?: Readonly<Vec3>, motion: FootstepMotion = "walk"): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const setup = stepGroupFor(surface);
    const variation = this.pickVariation(`step-${setup.group}`, STEP_VARIATIONS[setup.group]);
    const gait = MOTION_GAIN[motion];
    const rate = setup.rate * (0.95 + Math.random() * 0.1) * (motion === "sprint" ? 1.04 : motion === "crouch" ? 0.96 : 1);
    const volume = (worldPos ? 1.5 : 0.45) * gait * setup.trim;
    const played = this.playSample(`step-${setup.group}-${variation}`, volume, rate, worldPos, false, this.masterFilter,
      { profile: "step", lowpassHz: motion === "crouch" ? Math.min(setup.lowpassHz ?? 20000, 3800) : setup.lowpassHz });
    if (!played) this.playSynthFootstep(surface, worldPos);
  }

  /** Fallback used only until the recorded footsteps have finished loading. */
  private playSynthFootstep(surface: string, worldPos?: Readonly<Vec3>): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos, this.masterFilter, "step");

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    const metal = surface === "METAL" || surface === "SHEET_METAL";
    const sand = surface === "SANDSTONE";
    f.type = metal ? "bandpass" : "lowpass";
    f.frequency.value = (metal ? 2100 : sand ? 390 : 780) * (0.85 + Math.random() * 0.3);
    f.Q.value = metal ? 1.2 : 0.6;
    src.playbackRate.value = 0.88 + Math.random() * 0.26;
    const length = sand ? 0.14 : metal ? 0.105 : 0.085;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(worldPos ? 0.22 : 0.13, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + length);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    if (worldPos) src.onended = () => this.releaseDestination(dest);
    src.start(now, Math.random() * 0.9);
    src.stop(now + length + 0.01);
  }

  private playEvent(name: string, volume: number, worldPos?: Readonly<Vec3>, profile: AudioProfile = "gun"): void {
    this.unlock();
    this.playSample(name, volume, 0.97 + Math.random() * 0.06, worldPos, false, this.masterFilter, worldPos ? { profile } : {});
  }

  playKnifeSwing(): void { this.playEvent("knife-swing", 0.6); }
  playKnifeHit(): void { this.playEvent("knife-hit", 0.75); }
  playWeaponSwitch(): void { this.playEvent("weapon-switch", 0.5); }
  playHurt(): void { this.playEvent("player-hurt", 0.7); }
  playDeath(): void { this.playEvent("player-death", 0.8); }
  playRespawn(): void { this.playEvent("respawn", 0.55); }
  playLand(): void { this.playEvent("land", 0.55); }
  playMultiKill(): void { this.playEvent("multikill", 0.6); }
  playGrenadeThrow(worldPos: Readonly<Vec3>): void { this.playEvent("grenade-throw", 0.8, worldPos, "step"); }
  playSmokePop(worldPos: Readonly<Vec3>): void { this.playEvent("smoke-pop", 0.9, worldPos, "boom"); }
  playFlashbangBang(worldPos: Readonly<Vec3>): void { this.playEvent("flashbang-bang", 1.0, worldPos, "boom"); }
  playPickup(kind: "armor" | "ammo"): void { this.playEvent(kind === "armor" ? "pickup-armor" : "pickup-ammo", 0.6); }
  playPing(worldPos?: Readonly<Vec3>): void { this.playEvent("ping", 0.55, worldPos, "step"); }
  playHeartbeat(): void { this.playEvent("heartbeat", 0.75); }

  /** Three countdown beeps one second apart, then the start signal. */
  playCountdown(seconds = 3): void {
    this.unlock();
    for (let i = 0; i < seconds; i++) {
      window.setTimeout(() => this.playSample("countdown-beep", 0.55, 1), i * 1000);
    }
    window.setTimeout(() => this.playSample("match-go", 0.7, 1), seconds * 1000);
  }

  /** Victory or defeat stinger at the end of a match. null (a draw) plays neither. */
  playMatchEnd(won: boolean | null): void {
    if (won === null) return;
    this.playEvent(won ? "match-win" : "match-lose", 0.7);
  }

  playEnemySpotted(): void {
    const now = this.ctx?.currentTime ?? 0;
    if (now - this.lastPingVoice < 1.25) return;
    if (this.playSample("enemy-spotted", 0.43, 1.02)) this.lastPingVoice = now;
  }

  playExplosion(worldPos: Readonly<Vec3>): void {
    this.unlock();
    if (!this.ctx || !this.noiseBuffer) return;
    const distance = Math.hypot(worldPos.x - this.listenerPos.x, worldPos.y - this.listenerPos.y, worldPos.z - this.listenerPos.z);
    const sample = distance > 30
      ? "explosion-far"
      : EXPLOSION_SAMPLES[this.pickVariation("explosion", EXPLOSION_SAMPLES.length) - 1];
    if (this.playSample(sample, distance > 30 ? 1.3 : 1.15, 0.96 + Math.random() * 0.08, worldPos, false,
      this.masterFilter, { profile: "boom", wet: 1.5 })) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos, this.masterFilter, "boom");

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(950, now);
    lp.frequency.exponentialRampToValueAtTime(80, now + 0.85);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.95, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.9);

    src.connect(lp);
    lp.connect(g);
    g.connect(dest);
    src.start(now);
    src.stop(now + 0.95);
  }

  playFlashbangEffect(intensity: number, durationSec: number): void {
    this.unlock();
    if (!this.ctx || !this.masterFilter || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Master low-pass muffle sweep
    this.masterFilter.frequency.setValueAtTime(420, now);
    this.masterFilter.frequency.exponentialRampToValueAtTime(20000, now + Math.max(0.8, durationSec));

    // High-pitched ringing tone
    const ring = this.ctx.createOscillator();
    ring.type = "sine";
    ring.frequency.setValueAtTime(2850, now);
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.22 * intensity, now);
    rg.gain.exponentialRampToValueAtTime(0.001, now + Math.max(0.9, durationSec));
    ring.connect(rg);
    rg.connect(this.masterGain);
    ring.start(now);
    ring.stop(now + Math.max(1.0, durationSec + 0.1));
  }

  playSlowMoSweep(durationSec = 1.5): void {
    if (!this.ctx || !this.masterFilter) return;
    const now = this.ctx.currentTime;
    this.masterFilter.frequency.setValueAtTime(5500, now);
    this.masterFilter.frequency.exponentialRampToValueAtTime(380, now + 0.35);
    this.masterFilter.frequency.exponentialRampToValueAtTime(20000, now + durationSec);
  }

  playGlassShatter(worldPos: Readonly<Vec3>): void {
    if (this.playSample("glass-shatter", 0.7, 0.95 + Math.random() * 0.1, worldPos, false, this.masterFilter, { profile: "boom" })) return;
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos);
    for (let i = 0; i < 4; i++) {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(3200 + i * 950 + Math.random() * 500, now + i * 0.025);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.12, now + i * 0.025);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.025 + 0.11);
      o.connect(g);
      g.connect(dest);
      o.start(now + i * 0.025);
      o.stop(now + i * 0.025 + 0.12);
    }
  }
}
