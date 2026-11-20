import "./styles/main.css";
import {
  MAP_REGISTRY,
  RACE_MODE_CONFIGS,
  TRACK_REGISTRY,
  sanitizeCarSetup,
  type BotDifficulty,
  type CarSetupConfig,
  type GameMode,
  type MatchRules,
  type RaceEventMessage,
  type RaceMode,
  type RaceRoomStateBroadcast,
  type RoomStateBroadcast,
  type TrackId,
} from "@game/shared";
import { AssetManager } from "./core/AssetManager.js";
import { EngineApp } from "./core/EngineApp.js";
import { NetClient } from "./core/NetClient.js";
import { SpatialAudio } from "./core/SpatialAudio.js";
import { EngineAudioSynth } from "./games/racer/EngineAudioSynth.js";
import { GaragePreviewScene } from "./games/racer/GaragePreviewScene.js";
import { RaceNetClient } from "./games/racer/RaceNetClient.js";
import { RacerScene } from "./games/racer/RacerScene.js";
import { GunsmithPreviewScene } from "./games/shooter/GunsmithPreviewScene.js";
import { ShooterScene } from "./games/shooter/ShooterScene.js";
import { loadGuestProfile, saveGuestProfile } from "./state/UserProfileStore.js";
import { LoadingScreen } from "./ui/LoadingScreen.js";
import { LobbyScreen } from "./ui/LobbyScreen.js";
import { RaceGarageScreen } from "./ui/RaceGarageScreen.js";
import { RaceHud } from "./ui/RaceHud.js";
import { SettingsModal } from "./ui/SettingsModal.js";
import { ShooterHud } from "./ui/ShooterHud.js";

type ActiveGameHub = "SHOOTER" | "RACER";

class RaceLoadingOverlay {
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "loading-overlay interactive hidden";
    parent.appendChild(this.root);
  }

  show(trackId: TrackId, roomCode: string, mode: RaceMode): void {
    const track = TRACK_REGISTRY[trackId] ?? TRACK_REGISTRY.tokyo_midnight;
    const modeLabel = RACE_MODE_CONFIGS[mode]?.label ?? mode;
    this.root.innerHTML = `
      <div class="loading-box race-loading-box">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:11px;color:#fb7185;font-weight:900;letter-spacing:1.5px;">
              GRID DEPLOYMENT // ROOM ${roomCode} • ${modeLabel}
            </div>
            <div style="font-size:24px;font-weight:900;margin-top:2px;">${track.name}</div>
          </div>
          <div id="race-load-pct" style="font-family:var(--font-mono);font-size:24px;font-weight:900;color:#fb7185;">5%</div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);">${track.subtitle}</div>
        <div class="progress-track"><div class="progress-bar race-progress-bar" id="race-load-bar" style="width:5%;"></div></div>
        <div id="race-load-detail" style="font-size:12px;color:#e2e8f0;font-family:var(--font-mono);">
          Preparing 3D supercar rigs, 2K PBR road textures &amp; HDR skies...
        </div>
        <div class="stage-list">
          <div class="stage-pill active" id="race-st-assets">1. 3D Cars &amp; 2K PBR</div>
          <div class="stage-pill" id="race-st-track">2. Spline Track &amp; Audio</div>
          <div class="stage-pill" id="race-st-shaders">3. GPU Clearcoat Warm-Up</div>
        </div>
      </div>
    `;
    this.root.classList.remove("hidden");
  }

  update(pct: number, detail: string): void {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const bar = this.root.querySelector<HTMLElement>("#race-load-bar");
    const pctEl = this.root.querySelector<HTMLElement>("#race-load-pct");
    const detEl = this.root.querySelector<HTMLElement>("#race-load-detail");

    if (bar) bar.style.width = `${clamped}%`;
    if (pctEl) pctEl.textContent = `${clamped}%`;
    if (detEl) detEl.textContent = detail;
    const s1 = this.root.querySelector("#race-st-assets");
    const s2 = this.root.querySelector("#race-st-track");
    const s3 = this.root.querySelector("#race-st-shaders");

    if (clamped < 65) {
      s1?.classList.add("active");
    } else if (clamped < 85) {
      s1?.classList.remove("active");
      s1?.classList.add("done");
      s2?.classList.add("active");
    } else if (clamped < 100) {
      s1?.classList.add("done");
      s2?.classList.remove("active");
      s2?.classList.add("done");
      s3?.classList.add("active");
    } else {
      s1?.classList.add("done");
      s2?.classList.add("done");
      s3?.classList.remove("active");
      s3?.classList.add("done");
    }
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  dispose(): void {
    this.root.remove();
  }
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById("render-canvas") as HTMLCanvasElement;
  const uiRoot = document.getElementById("ui-root") as HTMLDivElement;

  const profile = loadGuestProfile();
  const app = new EngineApp(canvas);
  await app.init(false);

  const assetManager = new AssetManager();
  const audio = new SpatialAudio();
  audio.setConfig(profile.settings);

  const raceAudio = new EngineAudioSynth();
  raceAudio.setMasterVolume(profile.settings.masterVolume);

  let audioMuted = false;
  const applyMasterVolume = (volume: number, announce: boolean): void => {
    profile.settings.masterVolume = Math.min(1, Math.max(0, Math.round(volume * 100) / 100));
    if (profile.settings.masterVolume > 0) audioMuted = false;
    audio.setMuted(audioMuted);
    audio.setConfig(profile.settings);
    raceAudio.setMasterVolume(audioMuted ? 0 : profile.settings.masterVolume);
    saveGuestProfile(profile);
    hud?.syncVolumeControls(profile.settings.masterVolume);
    if (announce) hud?.showVolumeToast(profile.settings.masterVolume, audioMuted);
  };
  const onVolumeKey = (direction: -1 | 0 | 1): void => {
    if (direction === 0) {
      audioMuted = !audioMuted;
      audio.setMuted(audioMuted);
      raceAudio.setMasterVolume(audioMuted ? 0 : profile.settings.masterVolume);
      hud?.showVolumeToast(profile.settings.masterVolume, audioMuted);
      return;
    }
    applyMasterVolume(profile.settings.masterVolume + direction * 0.05, true);
  };

  const net = new NetClient();
  const raceNet = new RaceNetClient();

  const loadingScreen = new LoadingScreen(uiRoot);
  const raceLoadingScreen = new RaceLoadingOverlay(uiRoot);

  let activeHub: ActiveGameHub = "SHOOTER";
  let gunsmithStage: GunsmithPreviewScene | null = null;
  let garageStage: GaragePreviewScene | null = null;
  let activeShooter: ShooterScene | null = null;
  let activeRacer: RacerScene | null = null;
  let hud: ShooterHud | null = null;
  let raceHud: RaceHud | null = null;
  let joining = false;
  let matchGeneration = 0;

  const settingsModal = new SettingsModal(
    uiRoot,
    profile,
    () => {
      audio.setConfig(profile.settings);
      raceAudio.setMasterVolume(audioMuted ? 0 : profile.settings.masterVolume);
      hud?.syncVolumeControls(profile.settings.masterVolume);
      activeShooter?.applyUpdatedSettings();
      activeRacer?.applyUpdatedSettings();
    },
    (botDifficulty) => {
      if (activeRacer) {
        raceNet.send({ type: "RACE_UPDATE_SETTINGS", botDifficulty });
      } else {
        net.send({ type: "UPDATE_ROOM_SETTINGS", botDifficulty });
      }
    }
  );

  const lobby = new LobbyScreen(uiRoot, profile, {
    onQuickPlay: (opts) => void enterArenaMatch({ action: "QUICK_PLAY", ...opts, isPublic: true }),
    onCreateRoom: (opts) => void enterArenaMatch({ action: "CREATE", ...opts }),
    onJoinCode: (code) =>
      void enterArenaMatch({
        action: "JOIN_CODE",
        mode: "2v2",
        mapId: "cargo_docks",
        isPublic: true,
        botFill: true,
        roomCode: code,
      }),
    onRefreshPublicRooms: () => net.fetchPublicRooms(),
    onWeaponPreviewChanged: (cfg) => {
      gunsmithStage?.setWeaponConfig(cfg);
    },
    onOpenSettings: () => settingsModal.open(),
    onSwitchToRacer: () => switchGameHub("RACER"),
  });

  const raceGarage = new RaceGarageScreen(uiRoot, profile, {
    onQuickRace: (opts) => void enterRaceMatch({ action: "QUICK_PLAY", ...opts, isPublic: true }),
    onCreateRoom: (opts) => void enterRaceMatch({ action: "CREATE", ...opts }),
    onJoinCode: (code) =>
      void enterRaceMatch({
        action: "JOIN_CODE",
        mode: "GRAND_PRIX",
        trackId: "tokyo_midnight",
        isPublic: true,
        botFill: true,
        roomCode: code,
      }),
    onRefreshPublicRooms: () => raceNet.fetchPublicRooms(),
    onCarSetupChanged: (setup: CarSetupConfig) => {
      garageStage?.setCarSetup(setup);
    },
    onRevEngine: () => {
      raceAudio.unlock();
      raceAudio.setMasterVolume(profile.settings.masterVolume);
      garageStage?.triggerRevPreview();
    },
    onOpenSettings: () => settingsModal.open(),
    onSwitchToShooter: () => switchGameHub("SHOOTER"),
  });

  function stopAndDisposeAllStages(): void {
    matchGeneration++;
    settingsModal.close();
    loadingScreen.hide();
    raceLoadingScreen.hide();

    net.disconnect();
    raceNet.disconnect();

    activeShooter?.dispose();
    activeShooter = null;
    hud?.dispose();
    hud = null;

    activeRacer?.dispose();
    activeRacer = null;
    raceHud?.dispose();
    raceHud = null;

    gunsmithStage?.dispose();
    gunsmithStage = null;

    garageStage?.dispose();
    garageStage = null;
  }

  function startShooterShowroom(): void {
    raceGarage.hide();
    garageStage?.dispose();
    garageStage = null;

    if (!gunsmithStage) {
      gunsmithStage = new GunsmithPreviewScene(app, profile.loadout.primary);
    } else {
      gunsmithStage.setWeaponConfig(profile.loadout.primary);
    }
    gunsmithStage.start();
    lobby.show();
  }

  function startRacerShowroom(): void {
    lobby.hide();
    gunsmithStage?.dispose();
    gunsmithStage = null;

    const currentSetup = sanitizeCarSetup(profile.racing as Partial<CarSetupConfig>);
    if (!garageStage) {
      const stage = new GaragePreviewScene(app, currentSetup, raceAudio);
      garageStage = stage;
      void stage
        .preloadAssets((pct, detail) => {
          if (garageStage !== stage) return;
          raceGarage.setPreloadStatus(pct >= 100 ? "Showroom ready" : detail);
        })
        .catch(() => {
          if (garageStage === stage) {
            raceGarage.setPreloadStatus("Showroom ready · remaining track assets load at grid");
          }
        });
    } else {
      garageStage.setCarSetup(currentSetup);
    }
    garageStage.start();
    raceGarage.show();
  }

  function switchGameHub(target: ActiveGameHub): void {
    if (joining) return;
    activeHub = target;
    stopAndDisposeAllStages();
    if (target === "RACER") {
      startRacerShowroom();
    } else {
      startShooterShowroom();
    }
  }

  // =========================================================================
  // GAME 1: STRIKECORE TACTICAL SHOOTER FLOW (100% PRESERVED)
  // =========================================================================
  async function enterArenaMatch(opts: {
    action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
    mode: GameMode;
    mapId: string;
    isPublic: boolean;
    botFill: boolean;
    matchRules?: Partial<MatchRules>;
    botDifficulty?: BotDifficulty;
    roomCode?: string;
  }): Promise<void> {
    if (joining || activeShooter || activeRacer) return;
    joining = true;
    const generation = ++matchGeneration;
    try {
      lobby.setErrorBanner("");
      audio.unlock();

      const joinParams = {
        action: opts.action,
        guestUuid: profile.guestUuid,
        callsign: profile.callsign,
        mode: opts.mode,
        mapId: opts.mapId,
        isPublic: opts.isPublic,
        botFill: opts.botFill,
        matchRules: opts.matchRules,
        botDifficulty: opts.botDifficulty ?? profile.settings.botDifficulty,
        roomCode: opts.roomCode,
        loadout: profile.loadout,
      };
      const welcome = await net.connectAndJoin(joinParams);

      let latestRoom = welcome.room;
      let reconnectStatus = "";
      let reconnecting = false;
      const updateConnection = (status: string) => {
        reconnectStatus = status;
        hud?.setConnectionStatus(status);
      };
      async function reconnect(): Promise<void> {
        if (reconnecting || generation !== matchGeneration) return;
        reconnecting = true;
        activeShooter?.setPaused(true);
        activeShooter?.resetNetworkState();
        updateConnection("Connection lost. Rejoining the match…");

        for (const delayMs of [250, 750, 1200]) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (generation !== matchGeneration) return;
          try {
            const resumed = await net.connectAndJoin({ ...joinParams, action: "JOIN_CODE", roomCode: welcome.room.code });
            if (generation !== matchGeneration) return;
            if (!resumed.reconnected || resumed.yourPlayerId !== welcome.yourPlayerId) {
              net.disconnect();
              break;
            }
            latestRoom = resumed.room;
            activeShooter?.handleServerMessage({ type: "ROOM_STATE", room: latestRoom });
            updateConnection("");
            reconnecting = false;
            activeShooter?.setPaused(false);
            return;
          } catch {
            /* Retry while the server is holding the player's slot. */
          }
        }
        if (generation === matchGeneration) updateConnection("Unable to rejoin this match.");
      }
      const bufferedMessages: import("@game/shared").ServerToClientMessage[] = [];
      net.setCallbacks({
        onRoomState: (r) => {
          latestRoom = r;
          activeShooter?.handleServerMessage({ type: "ROOM_STATE", room: r });
        },
        onMessage: (m) => {
          if (activeShooter) activeShooter.handleServerMessage(m);
          else if (bufferedMessages.length < 150) bufferedMessages.push(m);
        },
        onError: (err) => lobby.setErrorBanner(err),
        onDisconnected: () => void reconnect(),
      });

      const room = latestRoom;
      gunsmithStage?.stop();
      lobby.hide();
      loadingScreen.show(room.mapId, room.code);

      await assetManager.prepareMatchStage1And2((stage, pct, detail) => {
        loadingScreen.update(stage, pct, detail);
      });

      hud = new ShooterHud(uiRoot, profile, {
        onResumeCombat: () => {
          if (!net.connected) return;
          activeShooter?.setPaused(false);
        },
        onOpenMenu: () => activeShooter?.setPaused(true),
        onLoadoutChanged: (open) => activeShooter?.setLoadoutOpen(open),
        onStartMatch: () => net.send({ type: "START_MATCH" }),
        onSwitchMap: (mId) => net.send({ type: "UPDATE_ROOM_SETTINGS", mapId: mId }),
        onVoteMap: (mId) => net.send({ type: "VOTE_MAP", mapId: mId }),
        onRematchNow: () => {
          net.send({ type: "REMATCH_NOW" });
          activeShooter?.setPaused(false);
        },
        onOpenSettings: () =>
          settingsModal.open({
            difficulty: latestRoom.botDifficulty ?? "NORMAL",
            canChange: latestRoom.players.some((player) => player.id === net.yourPlayerId && player.isHost),
          }),
        onMasterVolumeChange: (volume) => applyMasterVolume(volume, false),
        onUpdateLoadout: (loadout) => {
          net.send({ type: "SET_LOADOUT", loadout });
          activeShooter?.forceEquipLocalLoadout();
        },
        onLeaveRoom: () => returnToLobby(),
      });

      activeShooter = new ShooterScene(app, net, audio, profile, latestRoom, welcome.yourPlayerId, {
        onArenaEvent: (event) => {
          if (event.type === "MATCH_RESULTS") {
            const earned = event.players.find((person) => person.id === net.yourPlayerId);
            if (earned) {
              profile.stats.xp += earned.xpEarned;
              if (earned.rating !== undefined) profile.stats.rating = earned.rating;
              saveGuestProfile(profile);
            }
          }
          hud?.showArenaEvent(event);
        },
        onHudUpdate: (snap) => hud?.updateLiveHud(snap),
        onRoomUpdate: (nextRoom: RoomStateBroadcast) => {
          hud?.updateRoom(nextRoom);
        },
        onHitConfirm: (tier, damage, isWallbang) => {
          hud?.showHitMarker(tier, damage, isWallbang);
        },
        onDamageTaken: (relAngleRad) => {
          hud?.showDamageDirection(relAngleRad);
        },
        onKillFeed: (msg) => {
          if (msg.killerName === profile.callsign && msg.killerTeam !== msg.victimTeam) {
            profile.stats.kills++;
            if (msg.isHeadshot) profile.stats.headshots++;
            saveGuestProfile(profile);
          }
          if (msg.victimName === profile.callsign) {
            profile.stats.deaths++;
            saveGuestProfile(profile);
          }
          hud?.pushKillFeed(msg);
        },
        onDamageBreakdown: (bd) => hud?.showDamageBreakdown(bd),
        onMatchEnded: (msg) => {
          profile.stats.matches++;
          const local = activeShooter ? latestRoom.players.find((p) => p.id === welcome.yourPlayerId) : null;
          if (local && local.team === msg.winnerTeam) profile.stats.wins++;
          saveGuestProfile(profile);
          hud?.showMatchEnded(msg);
        },
        onDangerPing: (msg) => hud?.showDangerPingNotice(msg.playerId === welcome.yourPlayerId ? null : msg.callsign),
        onPauseChanged: (paused) => hud?.setPaused(paused),
        onPointerCaptureError: (message) => hud?.showPointerCaptureError(message),
        onScoreboardChanged: (visible) => hud?.setScoreboardVisible(visible),
        onToggleLoadout: () => {
          hud?.toggleLoadoutModal();
        },
        onVolumeKey,
      });
      hud.syncVolumeControls(profile.settings.masterVolume);

      for (const m of bufferedMessages) {
        activeShooter.handleServerMessage(m);
      }

      loadingScreen.update("SHADERS", 82, `Warming PBR shaders for ${MAP_REGISTRY[latestRoom.mapId]?.name ?? latestRoom.mapId}...`);
      await activeShooter.warmUpAndStart((pct, detail) => loadingScreen.update("SHADERS", pct, detail));

      loadingScreen.update("READY", 100, "Deployed!");
      loadingScreen.hide();
      hud.show(welcome.yourPlayerId, latestRoom);
      if (reconnectStatus) {
        hud.setConnectionStatus(reconnectStatus);
        activeShooter.setPaused(true);
      }
    } catch (err) {
      returnToLobby();
      lobby.setErrorBanner(err instanceof Error ? err.message : "Failed to join room.");
    } finally {
      joining = false;
    }
  }

  function returnToLobby(): void {
    activeHub = "SHOOTER";
    stopAndDisposeAllStages();
    startShooterShowroom();
  }

  // =========================================================================
  // GAME 2: APEXDRIVE STREET RACER FLOW
  // =========================================================================
  async function enterRaceMatch(opts: {
    action: "QUICK_PLAY" | "CREATE" | "JOIN_CODE";
    mode: RaceMode;
    trackId: TrackId;
    isPublic: boolean;
    botFill: boolean;
    botDifficulty?: BotDifficulty;
    roomCode?: string;
  }): Promise<void> {
    if (joining || activeShooter || activeRacer) return;
    joining = true;
    const generation = ++matchGeneration;
    try {
      raceGarage.setErrorBanner("");
      raceAudio.unlock();
      raceAudio.setMasterVolume(profile.settings.masterVolume);

      const setup = sanitizeCarSetup(profile.racing as Partial<CarSetupConfig>);
      const joinParams = {
        action: opts.action,
        guestUuid: profile.guestUuid,
        callsign: profile.callsign,
        mode: opts.mode,
        trackId: opts.trackId,
        isPublic: opts.isPublic,
        botFill: opts.botFill,
        botDifficulty: opts.botDifficulty ?? profile.settings.botDifficulty,
        roomCode: opts.roomCode,
        setup,
      };

      const welcome = await raceNet.connectAndJoin(joinParams);
      if (generation !== matchGeneration) return;

      let latestRaceRoom: RaceRoomStateBroadcast = welcome.room;
      let reconnectStatus = "";
      let reconnecting = false;

      const updateRaceConnection = (status: string) => {
        reconnectStatus = status;
        raceHud?.setConnectionStatus(status);
      };

      async function reconnectRace(): Promise<void> {
        if (reconnecting || generation !== matchGeneration) return;
        reconnecting = true;
        activeRacer?.setPaused(true);
        activeRacer?.resetNetworkState();
        updateRaceConnection("Connection lost. Rejoining the race grid…");

        for (const delayMs of [250, 750, 1200]) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (generation !== matchGeneration) return;
          try {
            const resumed = await raceNet.connectAndJoin({
              ...joinParams,
              action: "JOIN_CODE",
              roomCode: welcome.room.code,
            });
            if (generation !== matchGeneration) return;
            if (!resumed.reconnected || resumed.yourPlayerId !== welcome.yourPlayerId) {
              raceNet.disconnect();
              break;
            }
            latestRaceRoom = resumed.room;
            activeRacer?.handleRoomState(latestRaceRoom);
            updateRaceConnection("");
            reconnecting = false;
            activeRacer?.setPaused(false);
            return;
          } catch {
            /* Retry while the server holds the racer slot */
          }
        }
        if (generation === matchGeneration) updateRaceConnection("Unable to rejoin this race.");
      }

      const bufferedEvents: RaceEventMessage[] = [];
      raceNet.setCallbacks({
        onRoomState: (r) => {
          latestRaceRoom = r;
          if (activeRacer) activeRacer.handleRoomState(r);
          else raceHud?.updateRoom(r);
        },
        onEvent: (ev) => {
          if (activeRacer) {
            activeRacer.handleRaceEvent(ev);
          } else if (bufferedEvents.length < 100) {
            bufferedEvents.push(ev);
          }
        },
        onError: (err) => raceGarage.setErrorBanner(err),
        onDisconnected: () => void reconnectRace(),
      });

      garageStage?.dispose();
      garageStage = null;
      raceGarage.hide();

      raceLoadingScreen.show(latestRaceRoom.trackId, latestRaceRoom.code, latestRaceRoom.mode);

      raceHud = new RaceHud(uiRoot, profile, {
        onResumeDriving: () => {
          if (!raceNet.connected) return;
          activeRacer?.setPaused(false);
        },
        onOpenMenu: () => activeRacer?.setPaused(true),
        onStartRace: () => raceNet.send({ type: "RACE_START" }),
        onTouchControl: (control, pressed) => activeRacer?.setTouchControl(control, pressed),
        onRestartPractice: () => {
          raceNet.send({ type: "RACE_RESTART_PRACTICE" });
          activeRacer?.setPaused(false);
        },
        onSwitchTrack: (trackId) => raceNet.send({ type: "RACE_UPDATE_SETTINGS", trackId }),
        onVoteTrack: (trackId) => raceNet.send({ type: "RACE_VOTE_TRACK", trackId }),
        onRematchNow: () => {
          raceNet.send({ type: "RACE_REMATCH" });
          activeRacer?.setPaused(false);
        },
        onTransmissionChanged: (mode) => {
          activeRacer?.setTransmission(mode);
          if (latestRaceRoom.phase === "LOBBY") {
            raceNet.send({ type: "RACE_SET_SETUP", setup: sanitizeCarSetup(profile.racing as Partial<CarSetupConfig>) });
          }
        },
        onOpenSettings: () =>
          settingsModal.open({
            difficulty: latestRaceRoom.botDifficulty ?? "NORMAL",
            canChange: latestRaceRoom.phase === "LOBBY" && latestRaceRoom.mode !== "TIME_TRIAL" && latestRaceRoom.players.some((p) => p.id === raceNet.yourPlayerId && p.isHost),
          }),
        onLeaveRoom: () => returnToRaceGarage(),
      });

      activeRacer = new RacerScene(app, raceNet, raceAudio, profile, latestRaceRoom, welcome.yourPlayerId, {
        onHudUpdate: (snap) => raceHud?.updateLiveHud(snap),
        onRoomUpdate: (nextRoom) => {
          latestRaceRoom = nextRoom;
          raceHud?.updateRoom(nextRoom);
        },
        onRaceEvent: (ev) => raceHud?.handleRaceEvent(ev),
        onPauseChanged: (paused) => raceHud?.setPaused(paused),
        onStandingsChanged: (visible) => raceHud?.setStandingsVisible(visible),
        onGridLoading: (room) => {
          if (room) raceLoadingScreen.show(room.trackId, room.code, room.mode);
          else raceLoadingScreen.hide();
        },
        onFinishRace: (summary) => {
          const stats = profile.racing.stats;
          if (summary.mode === "TIME_TRIAL") {
            const lap = summary.bestLapMs;
            const previous = stats.bestTimeTrialMsByTrack[summary.trackId];
            if (!summary.dnf && lap && (!previous || lap < previous)) {
              stats.bestTimeTrialMsByTrack[summary.trackId] = lap;
              saveGuestProfile(profile);
            }
            return;
          }
          stats.races += 1;
          if (!summary.dnf && summary.rank === 1) {
            profile.racing.stats.wins += 1;
          }
          if (summary.totalDriftScore > profile.racing.stats.bestDriftScore) {
            profile.racing.stats.bestDriftScore = summary.totalDriftScore;
          }
          if (summary.bestLapMs && summary.bestLapMs > 0) {
            const prevBest = profile.racing.stats.bestLapMsByTrack[summary.trackId];
            if (!prevBest || summary.bestLapMs < prevBest) {
              profile.racing.stats.bestLapMsByTrack[summary.trackId] = summary.bestLapMs;
            }
          }
          saveGuestProfile(profile);
        },
      });

      for (const ev of bufferedEvents) {
        activeRacer.handleRaceEvent(ev);
      }

      await activeRacer.warmUpAndStart((pct, detail) => {
        raceLoadingScreen.update(pct, detail);
      });

      if (generation !== matchGeneration) return;

      raceLoadingScreen.update(100, "Ready on the grid");
      raceLoadingScreen.hide();
      raceHud.show(welcome.yourPlayerId, latestRaceRoom);
      activeRacer.markGridReady();
      if (reconnectStatus) {
        raceHud.setConnectionStatus(reconnectStatus);
        activeRacer.setPaused(true);
      }
    } catch (err) {
      returnToRaceGarage();
      raceGarage.setErrorBanner(err instanceof Error ? err.message : "Failed to join race grid.");
    } finally {
      joining = false;
    }
  }

  function returnToRaceGarage(): void {
    activeHub = "RACER";
    stopAndDisposeAllStages();
    startRacerShowroom();
  }

  // =========================================================================
  // INITIAL BOOT & DEEP-LINK ROUTING (?game=racer, ?race=CODE, ?room=CODE)
  // =========================================================================
  const params = new URLSearchParams(window.location.search);
  const deepRaceCode = params.get("race")?.trim().toUpperCase();
  const deepGameParam = params.get("game")?.trim().toLowerCase();
  const deepRoomCode = params.get("room")?.trim().toUpperCase();

  if (deepRaceCode) {
    activeHub = "RACER";
    startRacerShowroom();
    void enterRaceMatch({
      action: "JOIN_CODE",
      mode: "GRAND_PRIX",
      trackId: "tokyo_midnight",
      isPublic: true,
      botFill: true,
      roomCode: deepRaceCode,
    });
  } else if (deepGameParam === "racer" || deepGameParam === "apexdrive") {
    activeHub = "RACER";
    startRacerShowroom();
  } else {
    activeHub = "SHOOTER";
    startShooterShowroom();

    void assetManager
      .preloadArena((pct) => {
        lobby.setPreloadStatus(pct === 100 ? "Arena assets preloaded" : `Preloading arena assets · ${pct}%`);
      })
      .then((preloaded) => {
        if (!preloaded) lobby.setPreloadStatus("Arena assets will finish loading at deployment");
      });

    if (deepRoomCode) {
      void enterArenaMatch({
        action: "JOIN_CODE",
        mode: "2v2",
        mapId: "cargo_docks",
        isPublic: true,
        botFill: true,
        roomCode: deepRoomCode,
      });
    }
  }

  void activeHub;
}

void bootstrap();
