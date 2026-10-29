// Cliente de Xray Cloud: autenticación + GraphQL + resolución de keys.
// Las credenciales NO viven en el servidor: el usuario las entrega vía OAuth (ver index.ts)
// y cada request trae su propio JWT de Xray, que se propaga con AsyncLocalStorage.
import { AsyncLocalStorage } from "node:async_hooks";

const BASE = (process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app").replace(/\/$/, "");
const TIMEOUT_MS = 30_000;

const requestToken = new AsyncLocalStorage<string>();

// Ejecuta fn con el JWT de Xray del request actual disponible para gql().
export function withXrayToken<T>(token: string, fn: () => T): T {
  return requestToken.run(token, fn);
}

// Canjea client_id/client_secret de Xray por un JWT (~24 h). No guarda nada.
export async function authenticate(client_id: string, client_secret: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v2/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, client_secret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new InvalidCredentialsError();
  if (!res.ok) throw new Error(`Autenticación con Xray falló (${res.status}): ${await res.text()}`);
  return (await res.json()) as string;
}

export class InvalidCredentialsError extends Error {
  constructor() { super("Credenciales de Xray inválidas."); }
}

// Lee el claim `exp` (segundos) del JWT sin verificar la firma: Xray la verifica en cada llamada.
export function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

interface GqlResponse<T> { data?: T; errors?: { message: string }[] }

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = requestToken.getStore();
  if (!token) throw new Error("No hay token de Xray en el request.");
  const res = await fetch(`${BASE}/api/v2/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error("Xray rechazó el token (401). Reconectá el conector para renovarlo.");
  if (res.status === 429) throw new Error("Límite de peticiones de Xray alcanzado (429). Esperá unos segundos y reintentá.");
  if (!res.ok) throw new Error(`Xray respondió ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) throw new Error("Xray GraphQL: " + body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}

// ---- Resolución de keys Jira (CSC-123) -> issueId numérico que exige Xray ----
export type IssueKind = "test" | "testPlan" | "testExecution";
const LIST_QUERY: Record<IssueKind, string> = {
  test: "getTests",
  testPlan: "getTestPlans",
  testExecution: "getTestExecutions",
};

interface JiraRef { issueId: string; jira: { key: string; summary?: string } }

export async function resolveKeys(keys: string[], kind: IssueKind): Promise<Map<string, string>> {
  const unique = [...new Set(keys.map((k) => k.trim().toUpperCase()))];
  const map = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const op = LIST_QUERY[kind];
    const data = await gql<Record<string, { results: JiraRef[] }>>(
      `query($jql: String!, $limit: Int!) { ${op}(jql: $jql, limit: $limit) { results { issueId jira(fields: ["key"]) } } }`,
      { jql: `key in (${chunk.join(",")})`, limit: chunk.length },
    );
    for (const r of data[op].results) map.set(r.jira.key.toUpperCase(), r.issueId);
  }
  const missing = unique.filter((k) => !map.has(k));
  if (missing.length) throw new Error(`No se encontraron como ${kind} en Xray: ${missing.join(", ")}. Verificá la key y el tipo de issue.`);
  return map;
}

export async function resolveKey(key: string, kind: IssueKind): Promise<string> {
  return (await resolveKeys([key], kind)).get(key.trim().toUpperCase())!;
}
