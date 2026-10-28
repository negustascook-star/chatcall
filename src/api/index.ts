import path from "node:path";
import { CallAgent } from "../agent/callAgent.js";
import { createApiServer } from "./server.js";

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Neteisingas PORT: ${process.env.PORT}`);
  process.exit(1);
}

const agent = new CallAgent({ dataDir });
const server = createApiServer({ dataDir, agent });

server.listen(port, () => {
  console.log(`Chatcall API veikia: http://localhost:${port}`);
  console.log(`Duomenų katalogas: ${dataDir}`);
  console.log("Sveikatos patikra: GET /health");
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
