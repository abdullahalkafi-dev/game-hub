import type { EngineAudioProfile, Vec3 } from "@game/shared";

export type { EngineAudioProfile };

export interface PlayerAudioState {
  rpmNorm: number;
  throttle: number;
  speedKmh: number;
  driftSlip: number;
  nitroActive: boolean;
  onGravel: boolean;
  inTunnel: boolean;
  gear: number;
  paused: boolean;
}

export interface RivalAudioSample {
  id: string;
  pos: Readonly<Vec3>;
  speedKmh: number;
  rpmNorm: number;
}

interface EngineProfileTuning {
  idleHz: number;
  redlineHz: number;
  oscTypes: readonly [OscillatorType, OscillatorType, OscillatorType];
  harmonics: readonly [number, number, number];
  detuneCents: readonly [number, number, number];
  harmonicGains: readonly [number, number, number];
  subGain: number;
  driveAmount: number;
  filterBaseHz: number;
  filterRangeHz: number;
  resonanceHz: number;
  resonanceGainDb: number;
  turboLevel: number;
  turboBaseHz: number;
  turboTopHz: number;
  bovIntensity: number;
  popIntensity: number;
}

interface ActivePlayerGraph {
  profile: EngineAudioProfile;
  tuning: EngineProfileTuning;
  oscs: OscillatorNode[];
  subOsc: OscillatorNode;
  turboOsc: OscillatorNode;
  turboGain: GainNode;
  turboFilter: BiquadFilterNode;
  engineFilter: BiquadFilterNode;
  exhaustPeak: BiquadFilterNode;
  engineGain: GainNode;
  shiftCutGain: GainNode;
  tireSource: AudioBufferSourceNode;
  tireBp1: BiquadFilterNode;
  tireBp2: BiquadFilterNode;
  tireGain: GainNode;
  gravelSource: AudioBufferSourceNode;
  gravelFilter: BiquadFilterNode;
  gravelGain: GainNode;
  nitroSource: AudioBufferSourceNode;
  nitroOsc: OscillatorNode;
  nitroFilter: BiquadFilterNode;
  nitroGain: GainNode;
  windSource: AudioBufferSourceNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  allNodes: AudioNode[];
}

interface RivalVoice {
  id: string;
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  lastDist: number;
  lastTimeSec: number;
  dopplerRatio: number;
}

const PROFILE_TUNING: Record<EngineAudioProfile, EngineProfileTuning> = {
  V10_SUPER: {
    idleHz: 68,
    redlineHz: 355,
    oscTypes: ["sawtooth", "sawtooth", "triangle"],
    harmonics: [1.0, 1.5, 2.5],
    detuneCents: [-4, 5, 2],
    harmonicGains: [0.42, 0.3, 0.16],
    subGain: 0.24,
    driveAmount: 3.2,
    filterBaseHz: 520,
    filterRangeHz: 4200,
    resonanceHz: 260,
    resonanceGainDb: 5.5,
    turboLevel: 0.03,
    turboBaseHz: 1100,
    turboTopHz: 3600,
    bovIntensity: 0.45,
    popIntensity: 1.0,
  },
  I6_TURBO: {
    idleHz: 54,
    redlineHz: 275,
    oscTypes: ["sawtooth", "sawtooth", "triangle"],
    harmonics: [1.0, 1.5, 2.0],
    detuneCents: [-6, 6, -2],
    harmonicGains: [0.44, 0.28, 0.18],
    subGain: 0.28,
    driveAmount: 2.8,
    filterBaseHz: 440,
    filterRangeHz: 3600,
    resonanceHz: 220,
    resonanceGainDb: 6.0,
    turboLevel: 0.12,
    turboBaseHz: 950,
    turboTopHz: 5200,
    bovIntensity: 1.15,
    popIntensity: 0.85,
  },
  V8_MUSCLE: {
    idleHz: 38,
    redlineHz: 196,
    oscTypes: ["sawtooth", "sawtooth", "square"],
    harmonics: [1.0, 1.015, 1.5],
    detuneCents: [-18, 16, -7],
    harmonicGains: [0.48, 0.36, 0.16],
    subGain: 0.42,
    driveAmount: 4.5,
    filterBaseHz: 340,
    filterRangeHz: 2750,
    resonanceHz: 145,
    resonanceGainDb: 7.0,
    turboLevel: 0.05,
    turboBaseHz: 750,
    turboTopHz: 2900,
    bovIntensity: 0.4,
    popIntensity: 0.95,
  },
  BOXER_RALLY: {
    idleHz: 46,
    redlineHz: 240,
    oscTypes: ["sawtooth", "square", "triangle"],
    harmonics: [0.75, 1.0, 1.5],
    detuneCents: [-12, 9, -4],
    harmonicGains: [0.34, 0.42, 0.22],
    subGain: 0.34,
    driveAmount: 3.8,
    filterBaseHz: 410,
    filterRangeHz: 3250,
    resonanceHz: 185,
    resonanceGainDb: 6.5,
    turboLevel: 0.11,
    turboBaseHz: 1050,
    turboTopHz: 4900,
    bovIntensity: 1.1,
    popIntensity: 1.2,
  },
};

const MAX_ACTIVE_RIVAL_VOICES = 4;
const MAX_RIVAL_AUDIBLE_DIST = 115;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure Web Audio API automotive sound synthesizer + 3D HRTF Doppler rival engine mixer.
 * Zero external audio file dependencies — crisp multi-harmonic engine synthesis,
 * nonlinear exhaust waveshaping, turbo spool & BOV flutter, upshift crackles,
 * tire screech, gravel rumble, nitro jet roar, high-speed wind, and dynamic tunnel reverb.
 */
export class EngineAudioSynth {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private dryBus: GainNode | null = null;
  private tunnelSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private masterVolume = 0.72;
  private pendingProfile: EngineAudioProfile | null = null;
  private player: ActivePlayerGraph | null = null;

  private readonly rivalVoices = new Map<string, RivalVoice>();
  private readonly shaperCurves = new Map<number, Float32Array<ArrayBuffer>>();

  private lastGear = 1;
  private lastThrottle = 0;
  private lastNitroActive = false;
  private turboBoost = 0;
  private lastWallScrapeTime = -10;
  private lastCollisionTime = -10;
  private lastBovTime = -10;
  private lastPopTime = -10;
  private lastRevBurstTime = -10;
  private lastUpdateTime = 0;

  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      this.ctx = ctx;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 10;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.14;

      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;

      this.dryBus = ctx.createGain();
      this.dryBus.gain.value = 1.0;

      // Dynamic concrete highway tunnel reverb (wet send ramped smoothly on `inTunnel`)
      const convolver = ctx.createConvolver();
      convolver.buffer = this.buildTunnelImpulseResponse(ctx, 1.35);

      const tunnelFilter = ctx.createBiquadFilter();
      tunnelFilter.type = "lowpass";
      tunnelFilter.frequency.value = 2600;

      this.tunnelSend = ctx.createGain();
      this.tunnelSend.gain.value = 0.04;

      this.dryBus.connect(this.masterGain);
      this.dryBus.connect(this.tunnelSend);
      this.tunnelSend.connect(convolver);
      convolver.connect(tunnelFilter);
      tunnelFilter.connect(this.masterGain);

      this.masterGain.connect(limiter);
      limiter.connect(ctx.destination);

      this.noiseBuffer = this.buildWhiteNoiseBuffer(ctx, 2.5);
    }

    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {
        // Autoplay policy will unlock on the next user gesture
      });
    }

    if (this.pendingProfile && !this.player && this.ctx) {
      const profile = this.pendingProfile;
      this.pendingProfile = null;
      this.buildPlayerEngineGraph(profile);
    }
  }

  setMasterVolume(vol: number): void {
    this.masterVolume = clamp(vol, 0, 1);
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.025);
    }
  }

  startEngine(profile: EngineAudioProfile): void {
    this.unlock();
    if (!this.ctx || !this.dryBus) {
      this.pendingProfile = profile;
      return;
    }
    if (this.player && this.player.profile === profile) {
      return;
    }
    this.stopEngine();
    this.buildPlayerEngineGraph(profile);
  }

  stopEngine(): void {
    this.pendingProfile = null;
    if (this.player) {
      const g = this.player;
      this.player = null;
      for (const osc of g.oscs) {
        try {
          osc.stop();
        } catch {
          // already stopped
        }
      }
      for (const src of [g.subOsc, g.turboOsc, g.tireSource, g.gravelSource, g.nitroSource, g.nitroOsc, g.windSource]) {
        try {
          src.stop();
        } catch {
          // already stopped
        }
      }
      for (const n of g.allNodes) {
        try {
          n.disconnect();
        } catch {
          // ignore
        }
      }
    }
    this.clearRivalVoices();
    this.lastGear = 1;
    this.lastThrottle = 0;
    this.lastNitroActive = false;
    this.turboBoost = 0;
  }

  updatePlayerAudio(state: PlayerAudioState): void {
    if (!this.ctx || !this.dryBus || !this.tunnelSend) {
      return;
    }
    if (!this.player) {
      if (this.pendingProfile) {
        const p = this.pendingProfile;
        this.pendingProfile = null;
        this.buildPlayerEngineGraph(p);
      } else {
        return;
      }
    }

    const g = this.player;
    if (!g) return;

    const now = this.ctx.currentTime;
    const dt = this.lastUpdateTime > 0 ? clamp(now - this.lastUpdateTime, 0.004, 0.1) : 0.016;
    this.lastUpdateTime = now;

    // Smooth mute on pause
    if (state.paused) {
      g.engineGain.gain.setTargetAtTime(0.0001, now, 0.04);
      g.turboGain.gain.setTargetAtTime(0.0001, now, 0.04);
      g.tireGain.gain.setTargetAtTime(0.0001, now, 0.04);
      g.gravelGain.gain.setTargetAtTime(0.0001, now, 0.04);
      g.nitroGain.gain.setTargetAtTime(0.0001, now, 0.04);
      g.windGain.gain.setTargetAtTime(0.0001, now, 0.04);
      this.silenceRivalVoices(now);
      return;
    }

    const t = g.tuning;
    const rpmNorm = clamp(state.rpmNorm, 0, 1.15);
    const throttle = clamp(state.throttle, 0, 1);
    const speedKmh = clamp(state.speedKmh, 0, 460);
    const driftSlip = clamp(state.driftSlip, 0, 1);
    const gear = Math.round(state.gear);

    // Nonlinear RPM-to-pitch sweep (expressive punch in mid-band + screaming top-end)
    const pitchCurve = Math.pow(clamp(rpmNorm, 0, 1.1), 1.12);
    const baseFreq = t.idleHz + (t.redlineHz - t.idleHz) * pitchCurve;

    // Slight uneven header flutter for Boxer Rally & Muscle V8 at idle/low RPM
    const lopeMod =
      g.profile === "V8_MUSCLE"
        ? 1 + Math.sin(now * 28) * 0.025 * (1 - throttle * 0.65)
        : g.profile === "BOXER_RALLY"
          ? 1 + Math.sin(now * 38) * 0.018
          : 1;

    for (let i = 0; i < g.oscs.length; i++) {
      const targetHz = clamp(baseFreq * t.harmonics[i] * lopeMod, 22, 16000);
      g.oscs[i].frequency.setTargetAtTime(targetHz, now, 0.018);
    }
    g.subOsc.frequency.setTargetAtTime(clamp(baseFreq * 0.5, 20, 4000), now, 0.02);

    // Exhaust filter opens dramatically under WOT & high RPM
    const cutoffHz = clamp(
      t.filterBaseHz + t.filterRangeHz * (0.28 * rpmNorm + 0.72 * throttle * (0.35 + 0.65 * rpmNorm)),
      180,
      14000
    );
    g.engineFilter.frequency.setTargetAtTime(cutoffHz, now, 0.025);
    g.exhaustPeak.frequency.setTargetAtTime(clamp(t.resonanceHz * (0.8 + 0.7 * rpmNorm), 80, 1800), now, 0.04);

    // Engine loudness tracks throttle load & RPM
    const loadGain = 0.14 + throttle * 0.22 + rpmNorm * 0.14 + (state.nitroActive ? 0.06 : 0);
    g.engineGain.gain.setTargetAtTime(clamp(loadGain, 0.05, 0.56), now, 0.025);

    // Simulated turbocharger spool pressure
    const targetBoost = throttle > 0.4 && rpmNorm > 0.32 ? clamp((rpmNorm - 0.25) * throttle * 1.35, 0, 1) : 0;
    const spoolRate = targetBoost > this.turboBoost ? 3.2 : 5.5;
    this.turboBoost += (targetBoost - this.turboBoost) * Math.min(1, dt * spoolRate);

    const turboHz = clamp(t.turboBaseHz + (t.turboTopHz - t.turboBaseHz) * Math.pow(this.turboBoost, 0.85), 400, 12000);
    g.turboOsc.frequency.setTargetAtTime(turboHz, now, 0.03);
    g.turboFilter.frequency.setTargetAtTime(turboHz, now, 0.03);
    g.turboGain.gain.setTargetAtTime(t.turboLevel * this.turboBoost * (0.45 + 0.55 * throttle), now, 0.03);

    // Detect automatic / manual gear upshift -> ignition throttle cut + exhaust backfire + BOV flutter!
    if (gear > this.lastGear && gear >= 2 && speedKmh > 25) {
      g.shiftCutGain.gain.cancelScheduledValues(now);
      g.shiftCutGain.gain.setValueAtTime(1.0, now);
      g.shiftCutGain.gain.linearRampToValueAtTime(0.18, now + 0.022);
      g.shiftCutGain.gain.linearRampToValueAtTime(1.0, now + 0.075);

      this.playExhaustPop(t.popIntensity * (0.65 + 0.35 * throttle));
      if (this.turboBoost > 0.25 || g.profile === "I6_TURBO" || g.profile === "BOXER_RALLY") {
        this.playTurboBov(t.bovIntensity * Math.max(0.45, this.turboBoost));
      }
      this.turboBoost *= 0.35;
    } else if (gear < this.lastGear && gear >= 1 && rpmNorm > 0.55 && speedKmh > 45) {
      // Aggressive downshift rev-match crackle!
      this.playExhaustPop(t.popIntensity * 0.65);
    }

    // Sudden throttle lift under boost -> turbo BOV flutter + overrun pop!
    if (this.lastThrottle - throttle > 0.45 && this.turboBoost > 0.38 && speedKmh > 35) {
      this.playTurboBov(t.bovIntensity * this.turboBoost);
      if (g.profile === "BOXER_RALLY" || g.profile === "V10_SUPER") {
        this.playExhaustPop(t.popIntensity * 0.55);
      }
      this.turboBoost *= 0.25;
    }

    // Tire drift screech (dual resonant squeal bands)
    const speedFactor = clamp((speedKmh - 14) / 70, 0, 1);
    const screechLevel = state.onGravel ? 0 : Math.pow(driftSlip, 0.85) * speedFactor * 0.22;
    const screechPitch = 1 + clamp(speedKmh / 240, 0, 0.45) + Math.sin(now * 23) * 0.03;
    g.tireBp1.frequency.setTargetAtTime(clamp(880 * screechPitch, 450, 2600), now, 0.03);
    g.tireBp2.frequency.setTargetAtTime(clamp(1820 * screechPitch, 900, 4800), now, 0.03);
    g.tireGain.gain.setTargetAtTime(screechLevel, now, 0.035);

    // Off-road gravel shoulder rumble
    const gravelLevel = state.onGravel ? clamp(speedKmh / 95, 0, 1) * (0.24 + driftSlip * 0.14) : 0;
    g.gravelFilter.frequency.setTargetAtTime(clamp(220 + speedKmh * 3.1, 160, 1200), now, 0.04);
    g.gravelGain.gain.setTargetAtTime(gravelLevel, now, 0.04);

    // Nitro jet ignition + sustained plasma burn roar
    if (state.nitroActive && !this.lastNitroActive) {
      this.playNitroIgnitionBurst();
    }
    const nitroLevel = state.nitroActive ? 0.28 : 0.0001;
    g.nitroFilter.frequency.setTargetAtTime(state.nitroActive ? 950 + rpmNorm * 1100 : 400, now, 0.05);
    g.nitroOsc.frequency.setTargetAtTime(88 + rpmNorm * 95, now, 0.04);
    g.nitroGain.gain.setTargetAtTime(nitroLevel, now, 0.05);

    // High-speed cabin wind rush (audible above ~165-180 km/h)
    const windNorm = clamp((speedKmh - 165) / 170, 0, 1);
    g.windFilter.frequency.setTargetAtTime(clamp(360 + windNorm * 1150, 250, 3200), now, 0.08);
    g.windGain.gain.setTargetAtTime(windNorm * windNorm * 0.22, now, 0.08);

    // Dynamic highway tunnel Convolver reverb wet send!
    const targetTunnelSend = state.inTunnel ? 0.62 : 0.04;
    this.tunnelSend.gain.setTargetAtTime(targetTunnelSend, now, state.inTunnel ? 0.08 : 0.22);

    this.lastGear = gear;
    this.lastThrottle = throttle;
    this.lastNitroActive = state.nitroActive;
  }

  playExhaustPop(intensity = 1.0): void {
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    if (now - this.lastPopTime < 0.06) return;
    this.lastPopTime = now;

    const power = clamp(intensity, 0.2, 1.5);

    // Sharp exhaust crack noise burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(520 + Math.random() * 260, now);
    bp.frequency.exponentialRampToValueAtTime(140, now + 0.085);
    bp.Q.value = 1.4;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.42 * power, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.095);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.dryBus);

    // Low tailpipe punch thump
    const thump = this.ctx.createOscillator();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(165, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + 0.075);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.32 * power, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
    thump.connect(tg);
    tg.connect(this.dryBus);

    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      gain.disconnect();
    };
    thump.onended = () => {
      thump.disconnect();
      tg.disconnect();
    };

    src.start(now, Math.random() * 1.4);
    src.stop(now + 0.105);
    thump.start(now);
    thump.stop(now + 0.09);
  }

  playTurboBov(intensity = 1.0): void {
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBovTime < 0.14) return;
    this.lastBovTime = now;

    const power = clamp(intensity, 0.2, 1.5);
    const dur = 0.28;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 6.5;
    bp.frequency.setValueAtTime(3400, now);
    bp.frequency.exponentialRampToValueAtTime(1450, now + dur);

    // Iconic JDM compressor surge flutter ("su-tu-tu-tu") via Gain modulation
    const flutterGain = this.ctx.createGain();
    flutterGain.gain.setValueAtTime(0.001, now);
    const pulses = 4;
    for (let i = 0; i < pulses; i++) {
      const t0 = now + i * 0.062;
      const peak = 0.18 * power * Math.pow(0.74, i);
      flutterGain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
      flutterGain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.18), t0 + 0.058);
    }
    flutterGain.gain.exponentialRampToValueAtTime(0.0008, now + dur);

    src.connect(bp);
    bp.connect(flutterGain);
    flutterGain.connect(this.dryBus);

    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      flutterGain.disconnect();
    };

    src.start(now, Math.random() * 1.2);
    src.stop(now + dur + 0.02);
  }

  playCountdownBeep(isGo: boolean): void {
    this.unlock();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const dur = isGo ? 0.42 : 0.16;
    const freqs = isGo ? [880, 1320, 1760] : [523.25, 1046.5];

    for (let i = 0; i < freqs.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? "triangle" : "sine";
      osc.frequency.setValueAtTime(freqs[i], now);
      if (isGo && i === 0) {
        osc.frequency.exponentialRampToValueAtTime(freqs[i] * 1.04, now + dur);
      }
      const g = this.ctx.createGain();
      const peak = (isGo ? 0.24 : 0.2) / (i + 1);
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);

      osc.connect(g);
      g.connect(this.masterGain);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
      osc.start(now);
      osc.stop(now + dur + 0.02);
    }
  }

  playLaunchBoost(): void {
    this.unlock();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Turbo surge sweep
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(640, now + 0.45);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(800, now);
    lp.frequency.exponentialRampToValueAtTime(3600, now + 0.45);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.24, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.dryBus);
    osc.onended = () => {
      osc.disconnect();
      lp.disconnect();
      g.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.58);

    // Quick wheelspin launch chirp
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1250, now);
    bp.Q.value = 6.0;
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.18, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    src.connect(bp);
    bp.connect(sg);
    sg.connect(this.dryBus);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      sg.disconnect();
    };
    src.start(now, Math.random());
    src.stop(now + 0.3);

    this.playExhaustPop(1.1);
  }

  playWallScrape(intensity: number): void {
    this.unlock();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    if (now - this.lastWallScrapeTime < 0.085) return;
    this.lastWallScrapeTime = now;

    const power = clamp(intensity, 0.1, 1.0);
    const dur = 0.13;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1650 + Math.random() * 850, now);
    bp.Q.value = 3.2;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.24 * power, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
    src.start(now, Math.random() * 1.4);
    src.stop(now + dur + 0.01);

    // Metallic rail screech overtone
    const metal = this.ctx.createOscillator();
    metal.type = "square";
    metal.frequency.setValueAtTime(620 + Math.random() * 280, now);
    const mg = this.ctx.createGain();
    mg.gain.setValueAtTime(0.055 * power, now);
    mg.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    metal.connect(mg);
    mg.connect(this.dryBus);
    metal.onended = () => {
      metal.disconnect();
      mg.disconnect();
    };
    metal.start(now);
    metal.stop(now + 0.1);
  }

  playCollision(impactSpeed: number): void {
    this.unlock();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    if (now - this.lastCollisionTime < 0.12) return;
    this.lastCollisionTime = now;

    const norm = clamp(impactSpeed / 45, 0.18, 1.0);

    // Heavy body impact thud
    const thud = this.ctx.createOscillator();
    thud.type = "triangle";
    thud.frequency.setValueAtTime(125 + norm * 45, now);
    thud.frequency.exponentialRampToValueAtTime(32, now + 0.22);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.58 * norm, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    thud.connect(tg);
    tg.connect(this.dryBus);
    thud.onended = () => {
      thud.disconnect();
      tg.disconnect();
    };
    thud.start(now);
    thud.stop(now + 0.26);

    // Metallic panel crunch burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400 * norm + 600, now);
    lp.frequency.exponentialRampToValueAtTime(220, now + 0.24);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.45 * norm, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.dryBus);
    src.onended = () => {
      src.disconnect();
      lp.disconnect();
      ng.disconnect();
    };
    src.start(now, Math.random());
    src.stop(now + 0.28);
  }

  /**
   * Interactive 3D Garage "REV ENGINE" burst: sweeps the selected car's harmonic signature
   * up to redline, bounces off the limiter, and drops with an exhaust crackle + BOV flutter!
   */
  playRevBurst(profile: EngineAudioProfile): void {
    this.unlock();
    if (!this.ctx || !this.dryBus) return;
    const now = this.ctx.currentTime;
    if (now - this.lastRevBurstTime < 0.28) return;
    this.lastRevBurstTime = now;

    const t = PROFILE_TUNING[profile] ?? PROFILE_TUNING.V10_SUPER;
    const totalDur = 1.45;

    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this.getShaperCurve(t.driveAmount);

    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(t.filterBaseHz * 1.1, now);
    lp.frequency.exponentialRampToValueAtTime(t.filterBaseHz + t.filterRangeHz * 0.95, now + 0.42);
    lp.frequency.setValueAtTime(t.filterBaseHz + t.filterRangeHz * 0.85, now + 0.68);
    lp.frequency.exponentialRampToValueAtTime(t.filterBaseHz * 0.9, now + totalDur);

    const outGain = this.ctx.createGain();
    outGain.gain.setValueAtTime(0.001, now);
    outGain.gain.linearRampToValueAtTime(0.36, now + 0.08);
    outGain.gain.setValueAtTime(0.42, now + 0.44);
    // Double rev-limiter bounce
    outGain.gain.setValueAtTime(0.14, now + 0.49);
    outGain.gain.setValueAtTime(0.4, now + 0.54);
    outGain.gain.setValueAtTime(0.16, now + 0.61);
    outGain.gain.setValueAtTime(0.36, now + 0.66);
    outGain.gain.exponentialRampToValueAtTime(0.001, now + totalDur);

    shaper.connect(lp);
    lp.connect(outGain);
    outGain.connect(this.dryBus);

    const oscs: OscillatorNode[] = [];
    const oscGains: GainNode[] = [];

    const scheduleFreqSweep = (osc: OscillatorNode, mult: number) => {
      const fIdle = clamp(t.idleHz * mult, 22, 12000);
      const fPeak = clamp(t.redlineHz * 0.96 * mult, 40, 15000);
      const fBounce = clamp(t.redlineHz * 0.89 * mult, 40, 15000);
      osc.frequency.setValueAtTime(fIdle * 1.15, now);
      osc.frequency.exponentialRampToValueAtTime(fPeak, now + 0.44);
      osc.frequency.linearRampToValueAtTime(fBounce, now + 0.52);
      osc.frequency.linearRampToValueAtTime(fPeak, now + 0.62);
      osc.frequency.exponentialRampToValueAtTime(fIdle * 1.05, now + totalDur);
    };

    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = t.oscTypes[i];
      osc.detune.value = t.detuneCents[i];
      scheduleFreqSweep(osc, t.harmonics[i]);
      const og = this.ctx.createGain();
      og.gain.value = t.harmonicGains[i];
      osc.connect(og);
      og.connect(shaper);
      osc.start(now);
      osc.stop(now + totalDur + 0.03);
      oscs.push(osc);
      oscGains.push(og);
    }

    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    scheduleFreqSweep(sub, 0.5);
    const subG = this.ctx.createGain();
    subG.gain.value = t.subGain;
    sub.connect(subG);
    subG.connect(shaper);
    sub.start(now);
    sub.stop(now + totalDur + 0.03);

    // Subtle turbo spool whine during garage rev
    const turbo = this.ctx.createOscillator();
    turbo.type = "sine";
    turbo.frequency.setValueAtTime(t.turboBaseHz, now);
    turbo.frequency.exponentialRampToValueAtTime(t.turboTopHz * 0.88, now + 0.46);
    turbo.frequency.exponentialRampToValueAtTime(t.turboBaseHz, now + 1.05);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0.001, now);
    tg.gain.linearRampToValueAtTime(t.turboLevel * 0.9, now + 0.42);
    tg.gain.exponentialRampToValueAtTime(0.0005, now + 0.95);
    turbo.connect(tg);
    tg.connect(this.dryBus);
    turbo.start(now);
    turbo.stop(now + 1.08);

    sub.onended = () => {
      for (const o of oscs) o.disconnect();
      for (const g of oscGains) g.disconnect();
      sub.disconnect();
      subG.disconnect();
      turbo.disconnect();
      tg.disconnect();
      shaper.disconnect();
      lp.disconnect();
      outGain.disconnect();
    };

    // Delayed overrun exhaust crackle + turbo BOV right as revs drop
    window.setTimeout(() => {
      if (!this.ctx || this.ctx.state !== "running") return;
      this.playExhaustPop(t.popIntensity * 0.95);
      if (t.bovIntensity >= 0.45) {
        this.playTurboBov(t.bovIntensity * 0.9);
      }
    }, 660);
  }

  /**
   * 3D HRTF Spatial Audio + Doppler pitch shift for rival cars passing nearby!
   */
  updateRivalsAudio(
    listenerPos: Readonly<Vec3>,
    listenerFwd: Readonly<Vec3>,
    rivals: readonly RivalAudioSample[]
  ): void {
    if (!this.ctx || !this.dryBus || this.ctx.state !== "running") return;

    const now = this.ctx.currentTime;
    this.updateAudioListener(listenerPos, listenerFwd, now);

    // Select up to MAX_ACTIVE_RIVAL_VOICES closest rivals within audible range
    const ranked = rivals
      .map((r) => {
        const dx = r.pos.x - listenerPos.x;
        const dy = r.pos.y - listenerPos.y;
        const dz = r.pos.z - listenerPos.z;
        const dist = Math.hypot(dx, dy, dz);
        return { r, dist };
      })
      .filter((item) => item.dist < MAX_RIVAL_AUDIBLE_DIST)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_ACTIVE_RIVAL_VOICES);

    const activeIds = new Set<string>(ranked.map((item) => item.r.id));

    // Release voices for rivals that went out of range
    for (const [id, voice] of this.rivalVoices) {
      if (!activeIds.has(id)) {
        this.disposeRivalVoice(voice);
        this.rivalVoices.delete(id);
      }
    }

    for (const { r, dist } of ranked) {
      let voice = this.rivalVoices.get(r.id);
      if (!voice) {
        voice = this.createRivalVoice(r.id, r.pos, dist, now);
        this.rivalVoices.set(r.id, voice);
      }

      const dt = Math.max(0.016, now - voice.lastTimeSec);
      const radialSpeedMps = clamp((voice.lastDist - dist) / dt, -95, 95);
      const rawDoppler = clamp(343 / (343 - radialSpeedMps * 0.85), 0.78, 1.28);
      voice.dopplerRatio += (rawDoppler - voice.dopplerRatio) * Math.min(1, dt * 8);
      voice.lastDist = dist;
      voice.lastTimeSec = now;

      const rpmNorm = clamp(r.rpmNorm, 0, 1.1);
      const baseHz = (58 + rpmNorm * 225) * voice.dopplerRatio;
      voice.osc1.frequency.setTargetAtTime(clamp(baseHz, 25, 10000), now, 0.03);
      voice.osc2.frequency.setTargetAtTime(clamp(baseHz * 1.5, 35, 12000), now, 0.03);
      voice.filter.frequency.setTargetAtTime(clamp(480 + rpmNorm * 2400, 200, 6000), now, 0.04);

      const speedPresence = clamp(0.4 + r.speedKmh / 240, 0.35, 1.0);
      const distFade = clamp(1 - dist / MAX_RIVAL_AUDIBLE_DIST, 0, 1);
      voice.gain.gain.setTargetAtTime(0.22 * speedPresence * distFade, now, 0.04);

      if (voice.panner.positionX) {
        voice.panner.positionX.setTargetAtTime(r.pos.x, now, 0.025);
        voice.panner.positionY.setTargetAtTime(r.pos.y, now, 0.025);
        voice.panner.positionZ.setTargetAtTime(r.pos.z, now, 0.025);
      } else {
        voice.panner.setPosition(r.pos.x, r.pos.y, r.pos.z);
      }
    }
  }

  dispose(): void {
    this.stopEngine();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.masterGain = null;
      this.dryBus = null;
      this.tunnelSend = null;
      this.noiseBuffer = null;
      void ctx.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // INTERNAL AUDIO GRAPH BUILDERS
  // ---------------------------------------------------------------------------
  private buildPlayerEngineGraph(profile: EngineAudioProfile): void {
    const ctx = this.ctx!;
    const dryBus = this.dryBus!;
    const noiseBuffer = this.noiseBuffer!;
    const tuning = PROFILE_TUNING[profile] ?? PROFILE_TUNING.V10_SUPER;
    const allNodes: AudioNode[] = [];
    const track = <T extends AudioNode>(n: T): T => {
      allNodes.push(n);
      return n;
    };

    const shaper = track(ctx.createWaveShaper());
    shaper.curve = this.getShaperCurve(tuning.driveAmount);
    shaper.oversample = "2x";

    const engineFilter = track(ctx.createBiquadFilter());
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = tuning.filterBaseHz;
    engineFilter.Q.value = 1.1;

    const exhaustPeak = track(ctx.createBiquadFilter());
    exhaustPeak.type = "peaking";
    exhaustPeak.frequency.value = tuning.resonanceHz;
    exhaustPeak.Q.value = 2.0;
    exhaustPeak.gain.value = tuning.resonanceGainDb;

    const engineGain = track(ctx.createGain());
    engineGain.gain.value = 0.0001;

    const shiftCutGain = track(ctx.createGain());
    shiftCutGain.gain.value = 1.0;

    shaper.connect(engineFilter);
    engineFilter.connect(exhaustPeak);
    exhaustPeak.connect(engineGain);
    engineGain.connect(shiftCutGain);
    shiftCutGain.connect(dryBus);

    // Multi-harmonic engine oscillators
    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < 3; i++) {
      const osc = track(ctx.createOscillator());
      osc.type = tuning.oscTypes[i];
      osc.frequency.value = tuning.idleHz * tuning.harmonics[i];
      osc.detune.value = tuning.detuneCents[i];
      const og = track(ctx.createGain());
      og.gain.value = tuning.harmonicGains[i];
      osc.connect(og);
      og.connect(shaper);
      osc.start();
      oscs.push(osc);
    }

    // Sub-bass exhaust rumble oscillator
    const subOsc = track(ctx.createOscillator());
    subOsc.type = "sine";
    subOsc.frequency.value = tuning.idleHz * 0.5;
    const subGain = track(ctx.createGain());
    subGain.gain.value = tuning.subGain;
    subOsc.connect(subGain);
    subGain.connect(shaper);
    subOsc.start();

    // Turbo spool high-frequency whine oscillator
    const turboOsc = track(ctx.createOscillator());
    turboOsc.type = "sine";
    turboOsc.frequency.value = tuning.turboBaseHz;
    const turboFilter = track(ctx.createBiquadFilter());
    turboFilter.type = "bandpass";
    turboFilter.frequency.value = tuning.turboBaseHz;
    turboFilter.Q.value = 4.0;
    const turboGain = track(ctx.createGain());
    turboGain.gain.value = 0.0001;
    turboOsc.connect(turboFilter);
    turboFilter.connect(turboGain);
    turboGain.connect(dryBus);
    turboOsc.start();

    // Tire screech dual-band resonant noise
    const tireSource = track(ctx.createBufferSource());
    tireSource.buffer = noiseBuffer;
    tireSource.loop = true;
    const tireBp1 = track(ctx.createBiquadFilter());
    tireBp1.type = "bandpass";
    tireBp1.frequency.value = 920;
    tireBp1.Q.value = 8.5;
    const tireBp2 = track(ctx.createBiquadFilter());
    tireBp2.type = "bandpass";
    tireBp2.frequency.value = 1880;
    tireBp2.Q.value = 10.0;
    const tireGain = track(ctx.createGain());
    tireGain.gain.value = 0.0001;
    tireSource.connect(tireBp1);
    tireSource.connect(tireBp2);
    tireBp1.connect(tireGain);
    tireBp2.connect(tireGain);
    tireGain.connect(dryBus);
    tireSource.start();

    // Gravel shoulder rumble noise
    const gravelSource = track(ctx.createBufferSource());
    gravelSource.buffer = noiseBuffer;
    gravelSource.loop = true;
    const gravelFilter = track(ctx.createBiquadFilter());
    gravelFilter.type = "bandpass";
    gravelFilter.frequency.value = 340;
    gravelFilter.Q.value = 1.2;
    const gravelGain = track(ctx.createGain());
    gravelGain.gain.value = 0.0001;
    gravelSource.connect(gravelFilter);
    gravelFilter.connect(gravelGain);
    gravelGain.connect(dryBus);
    gravelSource.start();

    // Nitro plasma jet burn layer
    const nitroSource = track(ctx.createBufferSource());
    nitroSource.buffer = noiseBuffer;
    nitroSource.loop = true;
    const nitroOsc = track(ctx.createOscillator());
    nitroOsc.type = "sawtooth";
    nitroOsc.frequency.value = 110;
    const nitroOscGain = track(ctx.createGain());
    nitroOscGain.gain.value = 0.3;
    const nitroFilter = track(ctx.createBiquadFilter());
    nitroFilter.type = "bandpass";
    nitroFilter.frequency.value = 950;
    nitroFilter.Q.value = 1.4;
    const nitroGain = track(ctx.createGain());
    nitroGain.gain.value = 0.0001;
    nitroSource.connect(nitroFilter);
    nitroOsc.connect(nitroOscGain);
    nitroOscGain.connect(nitroFilter);
    nitroFilter.connect(nitroGain);
    nitroGain.connect(dryBus);
    nitroSource.start();
    nitroOsc.start();

    // High-speed aerodynamic cabin wind layer
    const windSource = track(ctx.createBufferSource());
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    const windFilter = track(ctx.createBiquadFilter());
    windFilter.type = "bandpass";
    windFilter.frequency.value = 600;
    windFilter.Q.value = 1.1;
    const windGain = track(ctx.createGain());
    windGain.gain.value = 0.0001;
    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(dryBus);
    windSource.start();

    this.player = {
      profile,
      tuning,
      oscs,
      subOsc,
      turboOsc,
      turboGain,
      turboFilter,
      engineFilter,
      exhaustPeak,
      engineGain,
      shiftCutGain,
      tireSource,
      tireBp1,
      tireBp2,
      tireGain,
      gravelSource,
      gravelFilter,
      gravelGain,
      nitroSource,
      nitroOsc,
      nitroFilter,
      nitroGain,
      windSource,
      windFilter,
      windGain,
      allNodes,
    };
  }

  private playNitroIgnitionBurst(): void {
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(320, now);
    bp.frequency.exponentialRampToValueAtTime(2400, now + 0.14);
    bp.Q.value = 1.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.45, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
    src.start(now, Math.random());
    src.stop(now + 0.3);
  }

  private createRivalVoice(id: string, pos: Readonly<Vec3>, dist: number, now: number): RivalVoice {
    const ctx = this.ctx!;
    const osc1 = ctx.createOscillator();
    osc1.type = "sawtooth";
    osc1.frequency.value = 120;

    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.value = 180;
    osc2.detune.value = 7;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;

    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 6;
    panner.maxDistance = MAX_RIVAL_AUDIBLE_DIST;
    panner.rolloffFactor = 1.25;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(pos.x, now);
      panner.positionY.setValueAtTime(pos.y, now);
      panner.positionZ.setValueAtTime(pos.z, now);
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.dryBus!);

    osc1.start();
    osc2.start();

    return {
      id,
      osc1,
      osc2,
      filter,
      gain,
      panner,
      lastDist: dist,
      lastTimeSec: now,
      dopplerRatio: 1.0,
    };
  }

  private silenceRivalVoices(now: number): void {
    for (const v of this.rivalVoices.values()) {
      v.gain.gain.setTargetAtTime(0.0001, now, 0.04);
    }
  }

  private disposeRivalVoice(v: RivalVoice): void {
    try {
      v.osc1.stop();
      v.osc2.stop();
    } catch {
      // ignore
    }
    try {
      v.osc1.disconnect();
      v.osc2.disconnect();
      v.filter.disconnect();
      v.gain.disconnect();
      v.panner.disconnect();
    } catch {
      // ignore
    }
  }

  private clearRivalVoices(): void {
    for (const v of this.rivalVoices.values()) {
      this.disposeRivalVoice(v);
    }
    this.rivalVoices.clear();
  }

  private updateAudioListener(pos: Readonly<Vec3>, fwd: Readonly<Vec3>, now: number): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const len = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
    const fx = fwd.x / len;
    const fy = fwd.y / len;
    const fz = fwd.z / len;

    if (listener.positionX) {
      listener.positionX.setValueAtTime(pos.x, now);
      listener.positionY.setValueAtTime(pos.y, now);
      listener.positionZ.setValueAtTime(pos.z, now);
      listener.forwardX.setValueAtTime(fx, now);
      listener.forwardY.setValueAtTime(fy, now);
      listener.forwardZ.setValueAtTime(fz, now);
      listener.upX.setValueAtTime(0, now);
      listener.upY.setValueAtTime(1, now);
      listener.upZ.setValueAtTime(0, now);
    } else if (listener.setPosition) {
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  private getShaperCurve(drive: number): Float32Array<ArrayBuffer> {
    const existing = this.shaperCurves.get(drive);
    if (existing) return existing;
    const samples = 1024;
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.tanh(x * drive);
    }
    this.shaperCurves.set(drive, curve);
    return curve;
  }

  private buildWhiteNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  private buildTunnelImpulseResponse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        const decay = Math.exp(-t * 3.1);
        // Subtle concrete wall early slapback echoes at 35ms, 78ms, 130ms
        const slap =
          (Math.abs(t - 0.035) < 0.004 ? 1.8 : 1.0) *
          (Math.abs(t - 0.078) < 0.005 ? 1.5 : 1.0) *
          (Math.abs(t - 0.13) < 0.006 ? 1.3 : 1.0);
        data[i] = (Math.random() * 2 - 1) * decay * slap * 0.55;
      }
    }
    return buf;
  }
}
