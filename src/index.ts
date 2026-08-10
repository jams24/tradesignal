import "dotenv/config";
import http from "http";
import { orchestrator } from "./core/orchestrator";
import { logger } from "./utils/logger";

const PORT = parseInt(process.env.PORT || "3000", 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
});

server.listen(PORT, () => {
  logger.info(`Health check server on port ${PORT}`);
});

async function main(): Promise<void> {
  try {
    await orchestrator.start();
  } catch (err: any) {
    console.error("Fatal startup error:", err.message);
    process.exit(1);
  }
}

main();
