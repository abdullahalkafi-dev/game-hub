import { WEAPON_REGISTRY, type HitMarkerTier, type Vec3 } from "@game/shared";
import type { UserSettings } from "../state/UserProfileStore.js";

const SHOT_SAMPLES = {
  AR: ["rifle-1", "rifle-2"],
  SMG: ["pistol-1", "pistol-2"],
  SNIPER: ["bolt-1", "bolt-2"],
  SHOTGUN: ["shotgun-1"],
  PISTOL: ["pistol-1", "pistol-2"],
} satisfies Record<string, readonly string[]>;

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

  unlock(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.masterFilter = this.ctx.createBiquadFilter();
      this.masterFilter.type = "lowpass";
      this.masterFilter.frequency.value = 20000;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
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
    const files = new Set([...Object.values(SHOT_SAMPLES).flat(), "reload-action", "headshot-voice", "enemy-spotted"]);
    await Promise.all([...files].map(async (name) => {
      try {
        const response = await fetch(`/assets/audio/${name}.wav`);
        if (response.ok) this.samples.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // The generated effects cover playback while samples load or if a file is unavailable.
      }
    }));
  }

  private playSample(name: string, volume: number, rate: number, worldPos?: Readonly<Vec3>, muffled = false, output: AudioNode | null = this.masterFilter): boolean {
    const context = this.ctx;
    const buffer = this.samples.get(name);
    if (!context || !buffer) return false;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = context.createGain();
    level.gain.value = volume;
    const destination = this.createDestination(worldPos, output);
    const filter = muffled ? context.createBiquadFilter() : null;
    if (filter) {
      filter.type = "lowpass";
      filter.frequency.value = 2100;
      source.connect(filter);
      filter.connect(level);
    } else {
      source.connect(level);
    }
    level.connect(destination);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      level.disconnect();
      if (destination !== output) destination.disconnect();
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
    this.masterGain?.gain.setTargetAtTime(this.masterVolume, now, 0.02);
    this.gunfireGain?.gain.setTargetAtTime(this.gunfireVolume, now, 0.02);
    this.feedbackGain?.gain.setTargetAtTime(this.hitFeedbackVolume, now, 0.02);
  }

  updateListener(pos: Readonly<Vec3>, fwd: Readonly<Vec3>, up: Readonly<Vec3>): void {
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

  private createDestination(worldPos?: Readonly<Vec3>, output: AudioNode | null = this.masterFilter): AudioNode {
    if (!this.ctx || !output) {
      throw new Error("Audio not initialized");
    }
    if (!worldPos) {
      return output;
    }
    const panner = this.ctx.createPanner();
    panner.panningModel = this.hrtfEnabled ? "HRTF" : "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 3;
    panner.maxDistance = 95;
    panner.rolloffFactor = 1.15;
    panner.positionX.setValueAtTime(worldPos.x, this.ctx.currentTime);
    panner.positionY.setValueAtTime(worldPos.y, this.ctx.currentTime);
    panner.positionZ.setValueAtTime(worldPos.z, this.ctx.currentTime);
    panner.connect(output);
    return panner;
  }

  playWeaponFire(weaponId: string, suppressed: boolean, worldPos?: Readonly<Vec3>): void {
    this.unlock();
    const category = WEAPON_REGISTRY[weaponId]?.category ?? "AR";
    const picks = SHOT_SAMPLES[category];
    const name = picks[Math.floor(Math.random() * picks.length)];
    const pitch = category === "SMG" ? 1.22 : weaponId === "akm" || weaponId === "awm" ? 0.93 : 1;
    if (this.playSample(name, suppressed ? 0.26 : worldPos ? 0.6 : 0.75,
      pitch * (0.97 + Math.random() * 0.06), worldPos, suppressed, this.gunfireGain)) return;
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
    if (headshot) {
      if (this.headshotAnnouncer && now - this.lastHeadshotVoice >= 0.85 &&
        this.playSample("headshot-voice", 0.38, 1.08, undefined, false, this.feedbackGain)) {
        this.lastHeadshotVoice = now;
      }
      this.playImpactCue([[210, 0.075, 0.24], [1150, 0.037, 0.075], [1780, 0.047, 0.030]]);
      return;
    }

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
    } else {
      // KILL chime + low drop
      osc.type = "sine";
      osc.frequency.setValueAtTime(1320, now);
      osc.frequency.setValueAtTime(1760, now + 0.045);
      g.gain.setValueAtTime(0.46, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.24);
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

  playReloadClick(isDry: boolean): void {
    this.unlock();
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

  playFootstep(surface: string, worldPos?: Readonly<Vec3>): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos);

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
    if (worldPos) src.onended = () => dest.disconnect();
    src.start(now, Math.random() * 0.9);
    src.stop(now + length + 0.01);
  }

  playEnemySpotted(): void {
    const now = this.ctx?.currentTime ?? 0;
    if (now - this.lastPingVoice < 1.25) return;
    if (this.playSample("enemy-spotted", 0.43, 1.02)) this.lastPingVoice = now;
  }

  playExplosion(worldPos: Readonly<Vec3>): void {
    this.unlock();
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dest = this.createDestination(worldPos);

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
