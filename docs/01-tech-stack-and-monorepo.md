# 01 — Tech Stack & Monorepo Architecture

StrikeCore uses a TypeScript monorepo with `pnpm` workspaces. The browser and headless server share game rules, weapon stats, character movement, collision geometry, and network message types.

## Run locally

From the repository root, install dependencies with `pnpm install`. Start each process in its own terminal.

~~~sh
pnpm dev:server
~~~

~~~sh
pnpm dev:client
~~~

Open [http://localhost:5173/](http://localhost:5173/). Vite proxies `/ws` and `/api` to the game server on port `2567` by default. When you use another port, set `PORT` for the server and set `GAME_SERVER_PORT` to the same value for the client. The client also reads `GAME_SERVER_PORT` from `packages/client/.env.local`.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build shared, server, and client packages in dependency order |
| `pnpm test` | Build the shared package and run Vitest |
| `pnpm typecheck` | Type-check all three packages after the shared package has been built |
| `pnpm --filter @game/server start` | Run the compiled server after a build |

The game server provides `GET /api/health` for liveness and the movement protocol version, `GET /api/rooms` for public room summaries, and `/ws` for multiplayer messages. When hosting the built client, route `/ws` and `/api` to the server on the same origin.

## Tech stack

| Layer | Current implementation |
| --- | --- |
| Browser build | Vite, TypeScript, and HTML/CSS UI written in TypeScript |
| Rendering | Babylon.js 7 with WebGPU where available and WebGL fallback |
| Physics | Shared Rapier3D WASM world and kinematic character controller |
| Audio | Native Web Audio with positional panning, optional HRTF, and separate gunfire and hit-feedback controls |
| Multiplayer | Node.js HTTP server, `ws` WebSockets, and in-memory room management |
| Assets | Manifest-based background HTTP caching, model loading, graphics presets, and shader warm-up |

## Repository layout

~~~text
game-fun/
├── docs/
├── packages/
│   ├── shared/src/
│   │   ├── constants/      # Match rules and tick rates
│   │   ├── registries/     # Weapons, attachments, skins, throwables, maps
│   │   ├── physics/        # Character controller and collision queries
│   │   ├── systems/        # Weapon stats and shot spread
│   │   └── net/            # Input commands and packet codec
│   ├── client/
│   │   ├── public/assets/  # Asset manifest, models, materials, and audio
│   │   └── src/
│   │       ├── core/      # Rendering, audio, assets, VFX, and WebSocket client
│   │       ├── games/shooter/
│   │       ├── state/     # Guest profile and settings
│   │       └── ui/        # Lobby, loadout, settings, and HUD
│   └── server/src/
│       ├── GameServer.ts   # HTTP endpoints and WebSocket transport
│       ├── rooms/         # Room selection and authoritative match simulation
│       └── systems/      # Bot decisions and lag compensation
└── tools/                  # Asset fetching and a local browser verification script
~~~

See the [client](../packages/client/package.json), [server](../packages/server/package.json), and [shared](../packages/shared/package.json) manifests for dependencies and package scripts.

## Loading and frame pacing

The lobby preloads arena files from the asset manifest into the browser's HTTP cache. Entry into the arena initializes Rapier, loads the scene and models, and warms shaders before revealing the match. [AssetManager](../packages/client/src/core/AssetManager.ts) · [Asset manifest](../packages/client/public/assets/asset-manifest.json) · [ShaderWarmer](../packages/client/src/core/ShaderWarmer.ts)

The game loop advances gameplay at 60 Hz and interpolates visuals between simulation steps. VFX pools reuse meshes for effects such as tracers, and graphics presets adjust rendering cost. [GameLoop](../packages/client/src/core/GameLoop.ts) · [Server cadence and interpolation](./06-netcode-and-roadmap.md)
