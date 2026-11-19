import { createGameServer } from "./GameServer.js";

const port = Number(process.env.PORT || 2567);

try {
  const { server } = await createGameServer();
  server.on("error", (err) => {
    console.error("Failed to start server:", err);
    process.exitCode = 1;
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[StrikeCore Server] Authoritative 60Hz FPS server listening on http://0.0.0.0:${port}`);
  });
} catch (err) {
  console.error("Failed to initialize server:", err);
  process.exitCode = 1;
}
