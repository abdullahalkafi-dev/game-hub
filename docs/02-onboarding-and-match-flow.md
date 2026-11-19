# 02 — Guest Onboarding & Match Flow

## Join a room

The browser creates a guest profile on first launch. Your guest ID, callsign, settings, saved loadouts, and local stats are kept in the browser's local storage.

| Lobby action | What happens |
| --- | --- |
| **Quick Play** | Joins a public room that matches the selected mode, map, and bot settings, or creates one when a matching room has no open slot |
| **Create Room** | Opens a public room or a private invite-only room using the selected mode, map, and bot settings |
| **Join by Code** | Joins the room using its four-character code. An invite link also opens the room directly using `?room=CODE` |

Background preloading starts in the lobby. The loading screen shows scene setup and shader warm-up before play.

## Warm-Up and starting a match

1. Pick a mode and arena. For a private match with friends, turn off **Auto-Fill Empty Slots with Tactical AI Bots**.
2. Open the room and use **Invite** to share the link. The arena opens in Warm-Up while players join. Use the steel targets to test weapons, optics, and hit feedback.
3. The host can click **Start** when ready. A non-practice room can auto-start when bots fill the roster. A full public room can also auto-start after 45 seconds. The standalone **Warm-Up Aim Range** stays in practice.
4. Click **Lock mouse** or press `F2` to aim. `Escape` releases the mouse, and `M` opens the match menu.

## Match loops

### 4v4 Team Deathmatch

Each enemy elimination adds a team point while the surviving player keeps their position, current health, and equipment. The first team to 30 wins. At seven minutes, the leading team wins and equal scores produce a draw.

Defeated players respawn after three seconds. The server chooses a team spawn based on cover, enemy distance, and occupancy. Respawns have up to two seconds of protection, which ends on gunfire or a grenade throw. Open **Loadout** with `L` during the countdown to choose a saved setup for the next life.

**Healing works during combat phases in every mode.** After five seconds without taking damage, health returns at 10 HP per second up to 100. Any new damage restarts the timer. Check the HP panel for **Recovery in …** and **Recovering health**.

**Ranked TDM** matches eight human players with standard rules and tracks rating by guest profile. Custom rooms let the host pick a 30–900 second time limit and toggle friendly fire. The time limit applies to the full TDM match or to each round in round-based play.

### Round-based modes

Aim Duel, Gunfight, and Tactical Wipeout use a one-second freeze at the start of each round. After a round ends, there is a four-second result window before the next round or the match summary. Gunfight gives both teams a mirrored loadout and changes it every two rounds. Tactical Wipeout adds bomb planting and defusing. Full mode rules are in the [shooter guide](./03-game1-tactical-shooter.md#maps-and-modes).

## Reconnects, host changes, and rematches

| Event | What to expect |
| --- | --- |
| Refresh or connection loss | The server reserves the seat for up to 20 seconds using the guest ID. The game attempts to reconnect after a dropped connection. After a refresh, use the invite link or join by code if the lobby opens. |
| Host disconnects | The server promotes the longest-connected available human player. |
| A player leaves permanently | The seat opens after the reconnect window. A bot can fill it when bot fill is enabled. |
| Match ends | Two map choices appear for the ten-second vote. The room then starts a new match, or a player can use **Rematch** to proceed sooner. |

The [default controls and settings](./03-game1-tactical-shooter.md#default-controls) are the same place to look up weapon swaps, grenade selection, and aim recovery.
