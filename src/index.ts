import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN ?? "";
if (ACCESS_TOKEN.length < 32) {
  console.error("MCP_ACCESS_TOKEN debe tener al menos 32 caracteres (ej: openssl rand -hex 32).");
  process.exit(1);
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Acepta el token en la ruta (/mcp/<token>, para conectores de Claude) o como Bearer.
function auth(req: Request, res: Response, next: NextFunction): void {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const provided = (req.params.token as string | undefined) ?? bearer;
  if (safeEq(provided, ACCESS_TOKEN)) return next();
  res.status(401).json({ error: "No autorizado" });
}

function createServer(): McpServer {
  const server = new McpServer({ name: "xray-mcp-server", version: "1.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => { res.json({ ok: true, service: "xray-mcp-server" }); });

const handler = async (req: Request, res: Response): Promise<void> => {
  const server = createServer(); // modo stateless: un servidor por request
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};
const notAllowed = (_req: Request, res: Response) => { res.status(405).json({ error: "Método no permitido" }); };

for (const path of ["/mcp", "/mcp/:token"]) {
  app.post(path, auth, handler);
  app.get(path, auth, notAllowed);
  app.delete(path, auth, notAllowed);
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.error(`xray-mcp-server escuchando en :${port}`));
