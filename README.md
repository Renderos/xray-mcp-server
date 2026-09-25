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

## Variables de entorno
- `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`: API Key de Xray.
- `MCP_ACCESS_TOKEN`: mínimo 32 caracteres (`openssl rand -hex 32`).
- `XRAY_BASE_URL` (opcional): región, p. ej. `https://eu.xray.cloud.getxray.app`.

## Local
```bash
npm install
cp .env.example .env   # completar valores
npm run dev
npx @modelcontextprotocol/inspector   # URL: http://localhost:3000/mcp/<TOKEN>
```

## Despliegue en Railway
1. Subir este repo a GitHub (privado) y crear un servicio desde el repo.
2. En *Variables*, cargar `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET` y `MCP_ACCESS_TOKEN`.
3. Railway detecta Node, corre `npm run build` y `npm start`. Generar dominio público.

## Conectar en Claude
*Settings → Connectors → Add custom connector*, URL:
```
https://<tu-dominio>.up.railway.app/mcp/<MCP_ACCESS_TOKEN>
```
El token en la URL es la protección: tratá esa URL como una contraseña. Para uso en equipo conviene migrar a OAuth.
