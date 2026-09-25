import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gql, resolveKey, resolveKeys } from "./xray.js";

const StepSchema = z.object({
  action: z.string().min(1).describe("Acción del paso"),
  data: z.string().default("").describe("Datos de prueba (opcional)"),
  result: z.string().default("").describe("Resultado esperado"),
});
const key = (d: string) => z.string().regex(/^[A-Za-z][A-Za-z0-9]+-\d+$/, "Formato esperado: PROYECTO-123").describe(d);
const keys = (d: string) => z.array(key("Key Jira")).min(1).max(200).describe(d);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A): Promise<ToolResult> => {
  try { return ok(await fn(a)); }
  catch (e) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
};

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

interface Step { id: string; action: string; data: string; result: string }
interface TestRun { id: string; status: { name: string }; steps: (Step & { status: { name: string } })[] }

async function getSteps(issueId: string): Promise<Step[]> {
  const d = await gql<{ getTest: { steps: Step[] } }>(
    `query($id: String!) { getTest(issueId: $id) { steps { id action data result } } }`, { id: issueId });
  return d.getTest.steps;
}

async function addSteps(issueId: string, steps: z.infer<typeof StepSchema>[]): Promise<Step[]> {
  const created: Step[] = [];
  for (const step of steps) { // secuencial para conservar el orden
    const d = await gql<{ addTestStep: Step }>(
      `mutation($id: String!, $step: CreateStepInput!) { addTestStep(issueId: $id, step: $step) { id action data result } }`,
      { id: issueId, step });
    created.push(d.addTestStep);
  }
  return created;
}

async function getRun(testKey: string, execKey: string): Promise<TestRun> {
  const [testId, execId] = await Promise.all([resolveKey(testKey, "test"), resolveKey(execKey, "testExecution")]);
  const d = await gql<{ getTestRun: TestRun | null }>(
    `query($t: String!, $e: String!) { getTestRun(testIssueId: $t, testExecIssueId: $e) {
       id status { name } steps { id action data result status { name } } } }`, { t: testId, e: execId });
  if (!d.getTestRun) throw new Error(`${testKey} no está en la ejecución ${execKey}. Usá xray_add_tests_to_execution primero.`);
  return d.getTestRun;
}

export function registerTools(server: McpServer): void {
  // ---------- Tests y pasos ----------
  server.registerTool("xray_get_test", {
    title: "Ver test de Xray",
    description: "Devuelve tipo, resumen y pasos (con stepId) de un test. Usalo antes de editar pasos.",
    inputSchema: { test_key: key("Key del test, ej. CSC-9920") }, annotations: RO,
  }, wrap(async ({ test_key }: { test_key: string }) => {
    const id = await resolveKey(test_key, "test");
    const d = await gql<{ getTest: unknown }>(
      `query($id: String!) { getTest(issueId: $id) { issueId testType { name } jira(fields: ["key","summary","status"])
         steps { id action data result } } }`, { id });
    return d.getTest;
  }));

  server.registerTool("xray_add_steps", {
    title: "Agregar pasos",
    description: "Agrega pasos al final de un test, en el orden dado.",
    inputSchema: { test_key: key("Key del test"), steps: z.array(StepSchema).min(1).max(50) }, annotations: WRITE,
  }, wrap(async ({ test_key, steps }: { test_key: string; steps: z.infer<typeof StepSchema>[] }) =>
    ({ test_key, added: await addSteps(await resolveKey(test_key, "test"), steps) })));

  server.registerTool("xray_replace_steps", {
    title: "Reemplazar todos los pasos",
    description: "Borra TODOS los pasos del test y carga los nuevos. Destructivo.",
    inputSchema: { test_key: key("Key del test"), steps: z.array(StepSchema).min(1).max(50) }, annotations: DESTRUCTIVE,
  }, wrap(async ({ test_key, steps }: { test_key: string; steps: z.infer<typeof StepSchema>[] }) => {
    const id = await resolveKey(test_key, "test");
    await gql(`mutation($id: String!) { removeAllTestSteps(issueId: $id) }`, { id });
    return { test_key, steps: await addSteps(id, steps) };
  }));

  server.registerTool("xray_update_step", {
    title: "Editar paso",
    description: "Modifica acción, datos o resultado esperado de un paso. Obtené el step_id con xray_get_test.",
    inputSchema: {
      step_id: z.string().describe("ID del paso (UUID)"),
      action: z.string().optional(), data: z.string().optional(), result: z.string().optional(),
    }, annotations: { ...WRITE, idempotentHint: true },
  }, wrap(async ({ step_id, ...fields }: { step_id: string; action?: string; data?: string; result?: string }) => {
    const step = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!Object.keys(step).length) throw new Error("Indicá al menos action, data o result.");
    const d = await gql<{ updateTestStep: { warnings: string[] } }>(
      `mutation($id: String!, $step: UpdateStepInput!) { updateTestStep(stepId: $id, step: $step) { warnings } }`,
      { id: step_id, step });
    return { step_id, updated: step, warnings: d.updateTestStep.warnings };
  }));

  server.registerTool("xray_remove_step", {
    title: "Eliminar paso",
    description: "Elimina un paso de un test por su step_id.",
    inputSchema: { step_id: z.string() }, annotations: DESTRUCTIVE,
  }, wrap(async ({ step_id }: { step_id: string }) => {
    await gql(`mutation($id: String!) { removeTestStep(stepId: $id) }`, { id: step_id });
    return { removed: step_id };
  }));

  // ---------- Test Plans ----------
  server.registerTool("xray_get_test_plan", {
    title: "Ver Test Plan",
    description: "Lista los tests asociados a un Test Plan.",
    inputSchema: { plan_key: key("Key del Test Plan") }, annotations: RO,
  }, wrap(async ({ plan_key }: { plan_key: string }) => {
    const id = await resolveKey(plan_key, "testPlan");
    const d = await gql<{ getTestPlan: unknown }>(
      `query($id: String!) { getTestPlan(issueId: $id) { issueId jira(fields: ["key","summary"])
         tests(limit: 100) { total results { issueId jira(fields: ["key","summary"]) } } } }`, { id });
    return d.getTestPlan;
  }));

  server.registerTool("xray_add_tests_to_plan", {
    title: "Agregar tests a Test Plan",
    description: "Asocia tests a un Test Plan (reemplaza el 'Add Tests' manual).",
    inputSchema: { plan_key: key("Key del Test Plan"), test_keys: keys("Keys de los tests") }, annotations: { ...WRITE, idempotentHint: true },
  }, wrap(async ({ plan_key, test_keys }: { plan_key: string; test_keys: string[] }) => {
    const [planId, tests] = await Promise.all([resolveKey(plan_key, "testPlan"), resolveKeys(test_keys, "test")]);
    const d = await gql<{ addTestsToTestPlan: unknown }>(
      `mutation($id: String!, $t: [String]!) { addTestsToTestPlan(issueId: $id, testIssueIds: $t) { addedTests warning } }`,
      { id: planId, t: [...tests.values()] });
    return d.addTestsToTestPlan;
  }));

  server.registerTool("xray_remove_tests_from_plan", {
    title: "Quitar tests de Test Plan",
    description: "Desasocia tests de un Test Plan (no borra los tests).",
    inputSchema: { plan_key: key("Key del Test Plan"), test_keys: keys("Keys de los tests") }, annotations: DESTRUCTIVE,
  }, wrap(async ({ plan_key, test_keys }: { plan_key: string; test_keys: string[] }) => {
    const [planId, tests] = await Promise.all([resolveKey(plan_key, "testPlan"), resolveKeys(test_keys, "test")]);
    await gql(`mutation($id: String!, $t: [String]!) { removeTestsFromTestPlan(issueId: $id, testIssueIds: $t) }`,
      { id: planId, t: [...tests.values()] });
    return { plan_key, removed: test_keys };
  }));

  // ---------- Ejecuciones ----------
  server.registerTool("xray_create_test_execution", {
    title: "Crear Test Execution",
    description: "Crea una Test Execution con los tests indicados y opcionalmente la vincula a un Test Plan.",
    inputSchema: {
      project_key: z.string().default("CSC"), summary: z.string().min(1),
      test_keys: keys("Tests a incluir"), plan_key: key("Test Plan a vincular").optional(),
    }, annotations: WRITE,
  }, wrap(async (a: { project_key: string; summary: string; test_keys: string[]; plan_key?: string }) => {
    const tests = await resolveKeys(a.test_keys, "test");
    const d = await gql<{ createTestExecution: { testExecution: { issueId: string; jira: { key: string } }; warnings: string[] } }>(
      `mutation($t: [String], $jira: JSON!) { createTestExecution(testIssueIds: $t, jira: $jira) {
         testExecution { issueId jira(fields: ["key"]) } warnings } }`,
      { t: [...tests.values()], jira: { fields: { summary: a.summary, project: { key: a.project_key } } } });
    const exec = d.createTestExecution.testExecution;
    if (a.plan_key) {
      await gql(`mutation($id: String!, $e: [String]!) { addTestExecutionsToTestPlan(issueId: $id, testExecIssueIds: $e) { addedTestExecutions warning } }`,
        { id: await resolveKey(a.plan_key, "testPlan"), e: [exec.issueId] });
    }
    return { execution_key: exec.jira.key, linked_plan: a.plan_key ?? null, warnings: d.createTestExecution.warnings };
  }));

  server.registerTool("xray_add_tests_to_execution", {
    title: "Agregar tests a ejecución",
    description: "Agrega tests a una Test Execution existente.",
    inputSchema: { execution_key: key("Key de la Test Execution"), test_keys: keys("Keys de los tests") }, annotations: { ...WRITE, idempotentHint: true },
  }, wrap(async ({ execution_key, test_keys }: { execution_key: string; test_keys: string[] }) => {
    const [execId, tests] = await Promise.all([resolveKey(execution_key, "testExecution"), resolveKeys(test_keys, "test")]);
    const d = await gql<{ addTestsToTestExecution: unknown }>(
      `mutation($id: String!, $t: [String]!) { addTestsToTestExecution(issueId: $id, testIssueIds: $t) { addedTests warning } }`,
      { id: execId, t: [...tests.values()] });
    return d.addTestsToTestExecution;
  }));

  server.registerTool("xray_get_test_run", {
    title: "Ver Test Run",
    description: "Estado de un test dentro de una ejecución, incluyendo estado por paso.",
    inputSchema: { test_key: key("Key del test"), execution_key: key("Key de la Test Execution") }, annotations: RO,
  }, wrap(async ({ test_key, execution_key }: { test_key: string; execution_key: string }) => getRun(test_key, execution_key)));

  const Status = z.string().toUpperCase().describe("Estado Xray: TODO, EXECUTING, PASSED, FAILED, ABORTED o uno personalizado");

  server.registerTool("xray_update_test_run_status", {
    title: "Cambiar estado de Test Run",
    description: "Cambia el estado global de un test en una ejecución.",
    inputSchema: { test_key: key("Key del test"), execution_key: key("Key de la Test Execution"), status: Status },
    annotations: { ...WRITE, idempotentHint: true },
  }, wrap(async ({ test_key, execution_key, status }: { test_key: string; execution_key: string; status: string }) => {
    const run = await getRun(test_key, execution_key);
    await gql(`mutation($id: String!, $s: String!) { updateTestRunStatus(id: $id, status: $s) }`, { id: run.id, s: status });
    return { test_key, execution_key, from: run.status.name, to: status };
  }));

  server.registerTool("xray_update_step_status", {
    title: "Cambiar estado de pasos",
    description: "Cambia el estado de uno o varios pasos de un test en una ejecución. Identificá cada paso por número (1 = primero) o step_id.",
    inputSchema: {
      test_key: key("Key del test"), execution_key: key("Key de la Test Execution"),
      updates: z.array(z.object({
        step: z.union([z.number().int().min(1), z.string()]).describe("Número de paso (1..n) o step_id"),
        status: Status,
      })).min(1).max(50),
    }, annotations: { ...WRITE, idempotentHint: true },
  }, wrap(async (a: { test_key: string; execution_key: string; updates: { step: number | string; status: string }[] }) => {
    const run = await getRun(a.test_key, a.execution_key);
    const results: unknown[] = [];
    for (const u of a.updates) {
      const s = typeof u.step === "number" ? run.steps[u.step - 1] : run.steps.find((x) => x.id === u.step);
      if (!s) throw new Error(`Paso ${u.step} no existe (el test tiene ${run.steps.length} pasos).`);
      const d = await gql<{ updateTestRunStepStatus: { warnings: string[] } }>(
        `mutation($r: String!, $s: String!, $st: String!) { updateTestRunStepStatus(testRunId: $r, stepId: $s, status: $st) { warnings } }`,
        { r: run.id, s: s.id, st: u.status });
      results.push({ step: u.step, from: s.status.name, to: u.status, warnings: d.updateTestRunStepStatus.warnings });
    }
    return { test_key: a.test_key, execution_key: a.execution_key, results };
  }));

  // ---------- Escape hatch ----------
  server.registerTool("xray_graphql", {
    title: "Consulta GraphQL directa",
    description: "Ejecuta una query o mutation GraphQL arbitraria contra Xray Cloud. Solo para casos no cubiertos por las otras herramientas.",
    inputSchema: { query: z.string().min(5), variables: z.record(z.unknown()).optional() }, annotations: DESTRUCTIVE,
  }, wrap(async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => gql(query, variables ?? {})));
}
