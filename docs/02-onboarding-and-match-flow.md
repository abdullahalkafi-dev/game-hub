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

### Continuous deathmatch (every mode)

1v1 Duel, 2v2 Team Duel, and 4v4 Team Deathmatch all play the same way. There are no rounds. Each enemy elimination adds a point to the killer's team while the killer stays exactly where they are, with their current health and equipment. The defeated player respawns after three seconds at a team spawn chosen for cover and distance from enemies, with up to two seconds of spawn protection that ends on gunfire or a grenade throw.

A match ends when a team reaches the **kill limit** or when the **time limit** runs out. The team with the most kills wins, and equal scores at timeout produce a draw. In a 1v1 the "team" is the single player, so the player with the most kills wins.

Open **Loadout** with `L` to choose a saved setup for your next life.

**Healing works during combat in every mode.** After five seconds without taking damage, health returns at 10 HP per second up to 100. Any new damage restarts the timer. Check the HP panel for **Recovery in …** and **Recovering health**.

### Room settings

When you host a room (or use Quick Play), pick:

| Setting | Options | Default |
| --- | --- | --- |
| Match length | 5, 8, 10, 15 minutes, or Unlimited | 8 minutes |
| Kill limit | 10, 15, 20, 30, 50, or None | 20 kills |
| Friendly fire | On / off | Off |

Unlimited time with no kill limit never ends on its own. **Public Rooms** lists each room's mode, rules, and live state (for example, "In progress 7:2 • 3:42 left", where 7:2 is the current score), and you can join a match already under way.

**Ranked TDM** matches eight human players with fixed rules (30 kills or seven minutes) and tracks rating by guest profile.

## Reconnects, host changes, and rematches

| Event | What to expect |
| --- | --- |
| Refresh or connection loss | The server reserves the seat for up to 20 seconds using the guest ID. The game attempts to reconnect after a dropped connection. After a refresh, use the invite link or join by code if the lobby opens. |
| Host disconnects | The server promotes the longest-connected available human player. |
| A player leaves permanently | The seat opens after the reconnect window. A bot can fill it when bot fill is enabled. |
| Match ends | Two map choices appear for the ten-second vote. The room then starts a new match, or a player can use **Rematch** to proceed sooner. |

The [default controls and settings](./03-game1-tactical-shooter.md#default-controls) are the same place to look up weapon swaps, grenade selection, and aim recovery.
