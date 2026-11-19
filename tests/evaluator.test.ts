import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAssertion, evaluateSuite, writeEvaluation } from '../src/runner/evaluator.js';
import { MockModelRunner, ModelRequestError, NativeModelRunner, type ModelRunner } from '../src/runner/models.js';
import { fixture } from './runner-fixture.js';

describe('offline evaluation', () => {
  it('runs tasks x trials with perfect mock output and writes report/traces', async () => {
    const output = await evaluateSuite(fixture(), new MockModelRunner('test', 7, 1, 0), { trials: 3, B: 100 });
    expect(output.report.results).toHaveLength(30);
    expect(output.report.driver).toBe('mock');
    expect(output.report.metrics.end_to_end_first_try_pass).toMatchObject({ mean: 1, ci_low: 1, ci_high: 1 });
    expect(output.report.schema_compilation_errors).toEqual({});
    const directory = await mkdtemp(join(tmpdir(), 'bench-evaluator-'));
    try {
      const file = await writeEvaluation(output, directory);
      expect(JSON.parse(await readFile(file, 'utf8')).driver).toBe('mock');
      const traces = (await readFile(file.replace(/\.json$/, '.traces.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(traces).toHaveLength(30);
      expect(traces[0]).toMatchObject({ prompt: fixture().tasks[0]!.prompt, call: { name: 'wait_ms', arguments: { timeout: 5000 } }, ajv_errors: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('is seed deterministic regardless of concurrency and limits active requests', async () => {
    const a = await evaluateSuite(fixture(), new MockModelRunner('test', 9), { concurrency: 1, B: 100 });
    let active = 0, max = 0;
    const mock = new MockModelRunner('test', 9);
    const runner: ModelRunner = { driver: 'mock', model: 'test', run: async request => {
      active++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      const result = await mock.run(request); active--; return result;
    } };
    const b = await evaluateSuite(fixture(), runner, { concurrency: 2, B: 100 });
    expect(a.report.metrics).toEqual(b.report.metrics);
    expect(a.report.results.map(r => [r.selected_tool, r.first_try_pass])).toEqual(b.report.results.map(r => [r.selected_tool, r.first_try_pass]));
    expect(max).toBe(2);
  });
  it('records invalid arguments, wrong tools, no calls and errors without crashing', async () => {
    const invalid = await evaluateSuite(fixture(), new MockModelRunner('test', 1, 1, 1), { B: 100 });
    expect(invalid.report.metrics.tool_selection_accuracy?.mean).toBe(1);
    expect(invalid.report.metrics.param_compliance_conditional?.mean).toBe(0);
    expect(invalid.traces[0]?.ajv_errors).not.toEqual([]);
    const wrong = await evaluateSuite(fixture(), new MockModelRunner('test', 1, 0, 0), { B: 100 });
    expect(wrong.report.metrics.param_compliance_conditional).toBeNull();
    expect(wrong.report.metrics.end_to_end_first_try_pass?.mean).toBe(0);
    const absent = await evaluateSuite(fixture(), { driver: 'mock', model: 'no-call', run: async () => ({ raw: {}, schema_transformations: [] }) }, { B: 100 });
    expect(absent.report.results[0]?.selected_tool).toBeNull();
    const error = await evaluateSuite(fixture(), { driver: 'mock', model: 'error', run: async () => { throw new Error('network unavailable'); } }, { B: 100 });
    expect(error.report.results[0]?.error).toBe('network unavailable');
    const failedHttp = await evaluateSuite(fixture(), { driver: 'mock', model: 'error', run: async () => { throw new ModelRequestError('HTTP 400', { status: 400, body: 'bad request' }); } }, { B: 100 });
    expect(failedHttp.traces[0]?.raw_response).toEqual({ status: 400, body: 'bad request' });
  });
  it('separates schema compliance from semantics and exposes strict compilation errors', async () => {
    const runner: ModelRunner = { driver: 'mock', model: 'test', run: async () => ({ raw: {}, call: { name: 'wait_ms', arguments: { timeout: 5 } }, schema_transformations: [] }) };
    const output = await evaluateSuite(fixture(), runner, { B: 100 });
    expect(output.report.results[0]).toMatchObject({ schema_valid: true, assertions_pass: false, first_try_pass: false });
    const suite = fixture(); suite.manifest.tools[0]!.inputSchema.unknownKeyword = true;
    const strict = await evaluateSuite(suite, runner, { B: 100 });
    expect(strict.report.schema_compilation_errors.wait_ms).toContain('unknown keyword');
    expect(strict.report.results[0]?.schema_valid).toBe(false);
  });
  it('marks generic executor selection N/A but retains parameter and end-to-end results', async () => {
    const suite = fixture(); suite.config.architecture_type = 'generic_executor';
    const output = await evaluateSuite(suite, new MockModelRunner('test', 1, 1, 0), { B: 100 });
    expect(output.report.selection_metric).toBe('not_applicable');
    expect(output.report.metrics.tool_selection_accuracy).toBeNull();
    expect(output.report.metrics.param_compliance_conditional?.mean).toBe(1);
  });
  it('rejects empty suites, leaks and invalid run parameters', async () => {
    const runner = new MockModelRunner();
    await expect(evaluateSuite({ ...fixture(), tasks: [] }, runner)).rejects.toThrow('empty');
    await expect(evaluateSuite({ ...fixture(), leaks: [{ task_id: 'x', tool: 'x', match: 'x', message: 'x' }] }, runner)).rejects.toThrow('leakage');
    await expect(evaluateSuite(fixture(), runner, { concurrency: 0 })).rejects.toThrow('positive');
  });
  it('checks all assertion operators, JSON Pointer escaping, absence and real ISO dates', () => {
    const args = { amount: 4999, mode: 'fast', date: '2026-01-01T00:00:00Z', 'a/b': { '~x': true } };
    for (const assertion of [{ path: '/amount', equals: 4999 }, { path: '/mode', matches: '^fa' }, { path: '/mode', oneOf: ['fast', 'slow'] },
      { path: '/date', iso8601: true as const }, { path: '/a~1b/~0x', exists: true }, { path: '/missing', exists: false }]) expect(checkAssertion(args, assertion).pass).toBe(true);
    expect(checkAssertion({}, { path: '/amount', equals: 4999 }).pass).toBe(false);
    expect(checkAssertion({ date: '2026-02-30T00:00:00Z' }, { path: '/date', iso8601: true }).pass).toBe(false);
  });
});

describe('native fetch model adapters (stubbed HTTP only)', () => {
  it.each(['anthropic', 'openai', 'gemini'] as const)('offers all tools with neutral messages and extracts only the first call: %s', async driver => {
    let payload: any;
    const call = { name: 'wait_ms', arguments: { timeout: 5000 } };
    const raw = driver === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }, { type: 'tool_use', name: call.name, input: call.arguments }, { type: 'tool_use', name: 'other', input: {} }] }
      : driver === 'openai' ? { choices: [{ message: { tool_calls: [{ function: { name: call.name, arguments: JSON.stringify(call.arguments) } }, { function: { name: 'other', arguments: '{}' } }] } }] }
      : { candidates: [{ content: { parts: [{ functionCall: { name: call.name, args: call.arguments } }, { functionCall: { name: 'other', args: {} } }] } }] };
    const stub: typeof fetch = async (_url, init) => { payload = JSON.parse(String(init?.body)); return Response.json(raw); };
    const suite = fixture();
    const result = await new NativeModelRunner(driver, 'test', { apiKey: 'dummy', fetch: stub }).run({ task: suite.tasks[0]!, tools: suite.manifest.tools, trial: 0 });
    expect(result.call).toEqual(call);
    expect(result.schema_transformations).toEqual([]);
    const offered = driver === 'gemini' ? payload.tools[0].functionDeclarations : payload.tools;
    expect(offered).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain('semantic_assertions');
    expect(JSON.stringify(payload)).not.toContain('expected_tools');
  });
  it('retries 429 and 5xx exponentially, not other errors', async () => {
    let calls = 0;
    const stub: typeof fetch = async () => { calls++; return calls < 3 ? new Response('', { status: calls === 1 ? 429 : 503 }) : Response.json({ choices: [] }); };
    const request = { task: fixture().tasks[0]!, tools: fixture().manifest.tools, trial: 0 };
    await new NativeModelRunner('openai', 'test', { apiKey: 'dummy', fetch: stub, backoffMs: 1 }).run(request);
    expect(calls).toBe(3);
    let bad = 0;
    const forbidden: typeof fetch = async () => { bad++; return new Response('', { status: 401 }); };
    await expect(new NativeModelRunner('openai', 'test', { apiKey: 'dummy', fetch: forbidden }).run(request)).rejects.toThrow('HTTP 401');
    expect(bad).toBe(1);
  });
});
