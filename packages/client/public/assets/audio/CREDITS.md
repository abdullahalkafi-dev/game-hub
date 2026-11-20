# StrikeCore audio

- Weapon shot recordings: [Gunshot Sounds](https://opengameart.org/content/gunshot-sounds), Vincent Sevedge. The downloaded archive credits the recordings under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/). The game uses trimmed, faded, normalized mono excerpts.
- Reload action: [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds), SpringySpringo, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- The optional spoken headshot callout uses original synthesized speech for StrikeCore using Microsoft David Desktop.
- The enemy-spotted ping uses original synthesized speech for StrikeCore using Windows System Speech.
- The default headshot impact and the steel practice-target ping are synthesized in the game's Web Audio code.
- Footsteps: concrete/stone and sand from [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone), Fantozzi, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/); metal from [Metal Footsteps on Concrete](https://opengameart.org/content/metal-footsteps-on-concrete), CC0 1.0. Trimmed, normalised and converted to mono WAV with `tools/convert-audio.mjs`.
- Explosions: [Explosion](https://opengameart.org/content/explosion-0), [Chunky Explosion](https://opengameart.org/content/chunky-explosion) and [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) (by Nenad Simic), all CC0 1.0.
- Additional gunshots (`gun-*.wav`), hit-marker cues (`hit-*.wav`), the bullet whiz and the glass shatter were generated for StrikeCore with the [ElevenLabs sound-effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) using `tools/generate-sfx.mjs`, then trimmed with `tools/convert-audio.mjs`. They are mixed with the recorded shots above, so each weapon type randomly picks from both sets.
- Event sounds (knife, grenade throw, smoke pop, flashbang, pickups, weapon switch, taking damage, death, respawn, countdown, match start, victory and defeat stingers, multi-kill, heartbeat, landing, ping and the reload sequence) were also generated with the ElevenLabs sound-effects API via `tools/generate-sfx.mjs`.
- Open `/sound-test.html` while the client is running to audition every sound, with distance and wall muffling.
