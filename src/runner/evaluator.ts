import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { EvalReport, type SemanticAssertion, type TrialResult } from '../types.js';
import { clusterBootstrap } from '../analyzer/stats.js';
import { analyzeTokens } from '../analyzer/tokens.js';
import { lintTools } from '../analyzer/lint.js';
import { ModelRequestError, type ModelRunner, type ModelResponse } from './models.js';
import type { Suite } from './suites.js';

export const METRICS = ['tool_selection_accuracy', 'param_compliance_conditional', 'end_to_end_first_try_pass'] as const;
export type Metric = typeof METRICS[number];

function pointer(value: unknown, path: string): { exists: boolean; value: unknown } {
  if (!path) return { exists: value !== undefined, value };
  for (const key of path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { exists: false, value: undefined };
    value = (value as Record<string, unknown>)[key];
  }
  return { exists: true, value };
}

export function checkAssertion(args: unknown, assertion: SemanticAssertion) {
  const actual = pointer(args, assertion.path);
  let pass = false;
  if ('exists' in assertion) pass = actual.exists === assertion.exists;
  else if (actual.exists) {
    if ('equals' in assertion) pass = isDeepStrictEqual(actual.value, assertion.equals);
    else if ('oneOf' in assertion) pass = assertion.oneOf.some(value => isDeepStrictEqual(actual.value, value));
    else if ('matches' in assertion) pass = typeof actual.value === 'string' && new RegExp(assertion.matches).test(actual.value);
    else pass = typeof actual.value === 'string' && z.iso.datetime({ offset: true }).safeParse(actual.value).success;
  }
  return { assertion, pass, actual: actual.value, exists: actual.exists };
}

export function metricTasks(results: TrialResult[], metric: Metric) {
  const tasks = new Map<string, number[]>();
  for (const result of results) {
    let value: boolean;
    if (metric === 'tool_selection_accuracy') {
      if (result.selection_correct === null) continue;
      value = result.selection_correct;
    } else if (metric === 'param_compliance_conditional') {
      if (!result.param_compliance_eligible) continue;
      value = result.schema_valid;
    } else value = result.first_try_pass;
    const outcomes = tasks.get(result.task_id) ?? [];
    outcomes.push(Number(value)); tasks.set(result.task_id, outcomes);
  }
  return [...tasks].map(([id, outcomes]) => ({ id, outcomes }));
}

export async function evaluateSuite(suite: Suite, runner: ModelRunner, options: { trials?: number; concurrency?: number; seed?: number; B?: number } = {}) {
  const { trials = 3, concurrency = 4, seed = 42, B = 5000 } = options;
  if (![trials, concurrency, B].every(n => Number.isInteger(n) && n > 0)) throw new Error('Trials, concurrency and B must be positive integers');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be a uint32');
  if (!suite.tasks.length) throw new Error('Cannot evaluate an empty suite');
  if (suite.leaks.length) throw new Error('Task leakage detected; run lint-tasks');
  const started_at = new Date().toISOString();
  const validators = new Map<string, ValidateFunction>();
  const schema_compilation_errors: Record<string, string> = {};
  for (const tool of suite.manifest.tools) {
    try {
      const version = String(tool.inputSchema.$schema ?? '');
      const Constructor = version.includes('2020-12') ? Ajv2020 : version.includes('2019-09') ? Ajv2019 : Ajv;
      const ajv = new Constructor({ strict: true, allErrors: true, validateFormats: true });
      (addFormats as unknown as (ajv: Ajv) => unknown)(ajv);
      ajv.addKeyword({ keyword: 'x-mcp-header', valid: true });
      validators.set(tool.name, ajv.compile(tool.inputSchema));
    } catch (error) { schema_compilation_errors[tool.name] = error instanceof Error ? error.message : String(error); }
  }
  const jobs = suite.tasks.flatMap(task => Array.from({ length: trials }, (_, trial) => ({ task, trial })));
  const traces: Array<Record<string, unknown>> = new Array(jobs.length);
  const results: TrialResult[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++, { task, trial } = jobs[index]!;
      const start = Date.now();
      let response: ModelResponse | undefined, error: string | undefined;
      try { response = await runner.run({ task, tools: suite.manifest.tools, trial }); }
      catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        if (cause instanceof ModelRequestError) response = { raw: cause.raw, schema_transformations: [] };
      }
      const call = response?.call;
      const selected = call !== undefined && task.expected_tools.includes(call.name);
      const validate = call ? validators.get(call.name) : undefined;
      const schema_valid = Boolean(validate && validate(call!.arguments));
      const ajv_errors = validate?.errors ? structuredClone(validate.errors) : [];
      const assertion_results = task.semantic_assertions.map(assertion => checkAssertion(call?.arguments, assertion));
      const assertions_pass = Boolean(call) && assertion_results.every(result => result.pass);
      const result: TrialResult = { task_id: task.id, trial, driver: runner.driver, model: runner.model,
        selected_tool: call?.name ?? null, selection_correct: suite.config.architecture_type === 'generic_executor' ? null : selected,
        param_compliance_eligible: selected,
        schema_valid, assertions_pass, first_try_pass: selected && schema_valid && assertions_pass,
        duration_ms: Date.now() - start, ...(error ? { error } : {}) };
      results[index] = result;
      traces[index] = { ...result, prompt: task.prompt, raw_response: response?.raw ?? null, call: call ?? null, ajv_errors,
        schema_error: call ? schema_compilation_errors[call.name] ?? (validate ? null : 'Unknown tool') : 'No tool call',
        assertion_results, schema_transformations: response?.schema_transformations ?? [] };
    }
  }));
  const metrics = Object.fromEntries(METRICS.map(metric => {
    const tasks = metricTasks(results, metric);
    return [metric, tasks.length ? clusterBootstrap(tasks.map(task => task.outcomes), { B, seed }) : null];
  }));
  const report = EvalReport.parse({ started_at, completed_at: new Date().toISOString(), server_name: suite.config.server_name,
    driver: runner.driver, model: runner.model, driver_options: runner.metadata ?? {}, trials, seed, snapshot: suite.config,
    manifest_sha256: suite.manifest_sha256, tasks_sha256: suite.tasks_sha256,
    metrics, selection_metric: suite.config.architecture_type === 'generic_executor' ? 'not_applicable' : suite.config.selection_metric,
    tokens: analyzeTokens(suite.manifest.tools), lint: lintTools(suite.manifest.tools), schema_compilation_errors, results });
  return { report, traces };
}

export async function writeEvaluation(output: Awaited<ReturnType<typeof evaluateSuite>>, directory: string) {
  await mkdir(directory, { recursive: true });
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = join(directory, `${safe(output.report.server_name)}.${output.report.driver}.${safe(output.report.model)}`);
  await writeFile(`${base}.json`, JSON.stringify(output.report, null, 2) + '\n');
  await writeFile(`${base}.traces.jsonl`, output.traces.map(trace => JSON.stringify(trace)).join('\n') + '\n');
  return `${base}.json`;
}
