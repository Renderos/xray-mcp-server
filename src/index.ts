import express, { type Request, type Response, type NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { authenticate, InvalidCredentialsError, jwtExp, withXrayToken } from "./xray.js";

// ---- OAuth sin secretos en el servidor ----
// El "OAuth Client ID / Secret" que el usuario carga en el conector de Claude ES su API Key de Xray.
// /token canjea esas credenciales por un JWT de Xray y lo entrega como access_token; el servidor
// no guarda nada. El código de autorización solo transporta el reto PKCE (no es un secreto:
// sin client_secret válido no sirve para nada).

const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const EXTRA_REDIRECTS = (process.env.OAUTH_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function redirectAllowed(uri: string): boolean {
  if (DEFAULT_REDIRECTS.includes(uri) || EXTRA_REDIRECTS.includes(uri)) return true;
  try {
    const u = new URL(uri); // clientes locales (Claude Code, MCP Inspector)
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// URL pública del servidor (Railway termina TLS en un proxy, de ahí trust proxy).
const baseUrl = (req: Request) => (process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

interface AuthCode { c: string; r: string; ch: string; e: number }

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

// Credenciales del cliente: client_secret_basic o client_secret_post.
function clientCredentials(req: Request): { id: string; secret: string } | null {
  const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const raw = Buffer.from(basic, "base64").toString("utf8");
    const i = raw.indexOf(":");
    try {
      const id = decodeURIComponent(raw.slice(0, i)), secret = decodeURIComponent(raw.slice(i + 1));
      if (i > 0 && id && secret) return { id, secret };
    } catch { /* codificación inválida: probar el body */ }
  }
  const { client_id, client_secret } = req.body ?? {};
  return typeof client_id === "string" && typeof client_secret === "string" ? { id: client_id, secret: client_secret } : null;
}

// Exige Bearer con un JWT de Xray vigente; si no, 401 con el puntero a la metadata OAuth.
function auth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const exp = jwtExp(token);
  if (exp && exp * 1000 > Date.now()) { res.locals.xrayToken = token; return next(); }
  res.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: "No autorizado" });
}

function createServer(): McpServer {
  const server = new McpServer({ name: "xray-mcp-server", version: "1.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => { // CORS para clientes de navegador (MCP Inspector)
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version", "Access-Control-Expose-Headers": "WWW-Authenticate" });
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
app.get("/", (_req, res) => { res.json({ ok: true, service: "xray-mcp-server" }); });

const protectedResource = (req: Request, res: Response) => {
  res.json({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], bearer_methods_supported: ["header"] });
};
app.get("/.well-known/oauth-protected-resource", protectedResource);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  });
});

app.get("/authorize", (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query as Record<string, string | undefined>;
  if (!redirect_uri || !redirectAllowed(redirect_uri)) return oauthError(res, 400, "invalid_request", "redirect_uri no permitido.");
  const back = new URL(redirect_uri);
  if (state) back.searchParams.set("state", state);
  if (response_type !== "code" || !client_id || !code_challenge || code_challenge_method !== "S256") {
    back.searchParams.set("error", "invalid_request");
    back.searchParams.set("error_description", "Se requiere response_type=code, client_id y PKCE S256.");
    return res.redirect(back.toString());
  }
  const code: AuthCode = { c: client_id, r: redirect_uri, ch: code_challenge, e: Date.now() + CODE_TTL_MS };
  back.searchParams.set("code", b64url(JSON.stringify(code)));
  res.redirect(back.toString());
});

app.post("/token", async (req, res) => {
  const creds = clientCredentials(req);
  if (!creds) return oauthError(res, 401, "invalid_client", "Faltan client_id/client_secret (API Key de Xray).");
  const { grant_type, code, code_verifier, redirect_uri } = req.body ?? {};

  if (grant_type === "authorization_code") {
    let parsed: AuthCode;
    try { parsed = JSON.parse(Buffer.from(String(code), "base64url").toString("utf8")); }
    catch { return oauthError(res, 400, "invalid_grant", "Código inválido."); }
    const challenge = b64url(createHash("sha256").update(String(code_verifier ?? "")).digest());
    if (parsed.e < Date.now() || parsed.c !== creds.id || parsed.r !== redirect_uri || parsed.ch !== challenge) {
      return oauthError(res, 400, "invalid_grant", "Código expirado o no coincide (client_id, redirect_uri o PKCE).");
    }
  } else if (grant_type !== "refresh_token") {
    return oauthError(res, 400, "unsupported_grant_type", "Solo authorization_code y refresh_token.");
  }

  // El refresh_token es opaco: renovar = volver a autenticar con las credenciales que el cliente reenvía.
  try {
    const token = await authenticate(creds.id, creds.secret);
    const exp = jwtExp(token);
    res.set("Cache-Control", "no-store").json({
      access_token: token,
      token_type: "Bearer",
      expires_in: exp ? Math.max(0, exp - Math.floor(Date.now() / 1000) - 300) : 23 * 3600,
      refresh_token: randomBytes(32).toString("base64url"),
    });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) return oauthError(res, 401, "invalid_client", e.message);
    oauthError(res, 502, "server_error", (e as Error).message);
  }
});

const handler = async (req: Request, res: Response): Promise<void> => {
  const server = createServer(); // modo stateless: un servidor por request
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await withXrayToken(res.locals.xrayToken as string, () => transport.handleRequest(req, res, req.body));
};
const notAllowed = (_req: Request, res: Response) => { res.status(405).json({ error: "Método no permitido" }); };

app.post("/mcp", auth, handler);
app.get("/mcp", auth, notAllowed);
app.delete("/mcp", auth, notAllowed);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.error(`xray-mcp-server escuchando en :${port}`));
