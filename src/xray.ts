// Cliente de Xray Cloud: autenticación (JWT cacheado) + GraphQL + resolución de keys.
const BASE = (process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app").replace(/\/$/, "");
const TIMEOUT_MS = 30_000;

let cached: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token;
  const client_id = process.env.XRAY_CLIENT_ID;
  const client_secret = process.env.XRAY_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error("Faltan XRAY_CLIENT_ID / XRAY_CLIENT_SECRET en el servidor.");
  const res = await fetch(`${BASE}/api/v2/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, client_secret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Autenticación con Xray falló (${res.status}): ${await res.text()}`);
  const token = (await res.json()) as string;
  cached = { token, exp: Date.now() + 23 * 3600 * 1000 }; // el JWT dura ~24 h
  return token;
}

interface GqlResponse<T> { data?: T; errors?: { message: string }[] }

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const call = async (token: string) =>
    fetch(`${BASE}/api/v2/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let res = await call(await getToken());
  if (res.status === 401) { cached = null; res = await call(await getToken()); }
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
