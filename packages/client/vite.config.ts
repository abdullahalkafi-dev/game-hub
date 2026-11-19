import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const { GAME_SERVER_PORT = "2567" } = loadEnv(mode, process.cwd(), "GAME_SERVER_PORT");
  const gameServer = `127.0.0.1:${GAME_SERVER_PORT}`;
  return {
    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api": {
          target: `http://${gameServer}`,
          changeOrigin: true,
        },
        "/ws": {
          target: `ws://${gameServer}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      exclude: ["@dimforge/rapier3d-compat"],
    },
    build: {
      target: "es2022",
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("@babylonjs/core") || id.includes("@babylonjs/loaders")) {
              return "vendor-babylon";
            }
            if (id.includes("@dimforge/rapier3d-compat")) {
              return "vendor-rapier";
            }
          },
        },
      },
    },
  };
});
