# xray-mcp-server

MCP remoto (Streamable HTTP, stateless) para manipular **Xray Cloud** desde Claude: pasos de tests, Test Plans, ejecuciones y estados.

## Herramientas
| Herramienta | Qué hace |
|---|---|
| `xray_get_test` | Tipo, resumen y pasos (con `step_id`) |
| `xray_add_steps` / `xray_replace_steps` | Agrega pasos / reemplaza todos |
| `xray_update_step` / `xray_remove_step` | Edita / elimina un paso |
| `xray_get_test_plan` | Tests de un Test Plan |
| `xray_add_tests_to_plan` / `xray_remove_tests_from_plan` | Reemplaza el "Add Tests" manual |
| `xray_create_test_execution` | Crea ejecución (y la vincula a un plan) |
| `xray_add_tests_to_execution` | Agrega tests a una ejecución |
| `xray_get_test_run` | Estado de un test y sus pasos en una ejecución |
| `xray_update_test_run_status` | PASSED / FAILED / etc. del test |
| `xray_update_step_status` | Estado por paso (por número o `step_id`) |
| `xray_graphql` | Query/mutation libre (casos no cubiertos) |

Todas aceptan **keys Jira** (`CSC-9920`); el servidor las convierte al `issueId` que exige Xray.

## Autenticación (sin secretos en el servidor)
El servidor **no guarda credenciales de Xray**. Cada usuario carga su propia API Key de Xray como
*OAuth Client ID / Client Secret* del conector. El servidor actúa como servidor OAuth mínimo:
`/token` canjea esas credenciales contra Xray y devuelve el JWT de Xray (~24 h) como `access_token`;
al vencer, Claude lo renueva con `refresh_token` reenviando las mismas credenciales. Nada se persiste.

## Variables de entorno (todas opcionales)
- `XRAY_BASE_URL`: región, p. ej. `https://eu.xray.cloud.getxray.app`.
- `PUBLIC_URL`: URL pública, si no se deduce bien de la request.
- `OAUTH_REDIRECT_URIS`: redirect URIs extra (coma). Ya se permiten las de claude.ai/claude.com y `http://localhost`.

## Local
```bash
npm install
cp .env.example .env
npm run dev
npx @modelcontextprotocol/inspector   # URL: http://localhost:3000/mcp, auth OAuth con tu Client ID/Secret de Xray
```

## Despliegue en Railway
1. Subir este repo a GitHub (privado) y crear un servicio desde el repo.
2. No hace falta cargar variables (solo `XRAY_BASE_URL` si no usás la región global).
3. Railway detecta Node, corre `npm run build` y `npm start`. Generar dominio público.

## Conectar en Claude
*Settings → Connectors → Add custom connector*:
- URL: `https://<tu-dominio>.up.railway.app/mcp`
- *Advanced settings* → **OAuth Client ID** = `client_id` de tu API Key de Xray, **OAuth Client Secret** = su `client_secret`.

Luego *Connect*: Claude hace el flujo OAuth y queda conectado con tus permisos de Xray.
