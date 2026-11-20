import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeModelRunner } from '../src/runner/models.js';
import { evaluateSuite } from '../src/runner/evaluator.js';
import { fixture } from './runner-fixture.js';

afterEach(() => vi.unstubAllEnvs());
const key = 'unit-test-credential';
const model = 'anthropic/claude-sonnet-5.5';
const suite = () => { const value = fixture(); value.tasks = value.tasks.slice(0, 1); return value; };
const completion = () => ({ choices: [{ message: { tool_calls: [
  { function: { name: 'wait_ms', arguments: '{"timeout":5000}' } },
  { function: { name: 'other', arguments: '{}' } },
] } }], usage: { prompt_tokens: 123, completion_tokens: 45 } });

it('uses the ZenMux environment key, OpenAI payload and default endpoint; records usage and gateway provenance', async () => {
  vi.stubEnv('ZENMUX_API_KEY', key);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(completion()));
  const input = suite();
  const output = await evaluateSuite(input, new NativeModelRunner('zenmux', model, { fetch: fetcher }), { trials: 1, B: 10 });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://zenmux.ai/api/v1/chat/completions');
  expect(options?.headers).toMatchObject({ Authorization: `Bearer ${key}` });
  const payload = JSON.parse(String(options?.body));
  expect(payload.model).toBe(model);
  expect(payload.messages[1]).toEqual({ role: 'user', content: input.tasks[0]!.prompt });
  expect(payload.tools).toEqual(input.manifest.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })));
  for (const hidden of ['semantic_assertions', 'expected_tools', 'expected_arguments', 'rationale', 'tags', key]) expect(JSON.stringify(payload)).not.toContain(hidden);
  expect(output.report).toMatchObject({ driver: 'zenmux', model, driver_options: { gateway: 'https://zenmux.ai/api/v1', model_id: model } });
  expect(output.report.results[0]).toMatchObject({ selected_tool: 'wait_ms', first_try_pass: true, input_tokens: 123, output_tokens: 45, api_requests: 1 });
  expect(JSON.stringify(output)).not.toContain(key);
});

it('normalizes configurable endpoints and counts retry attempts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json(completion()));
  const input = suite();
  const runner = new NativeModelRunner('zenmux', model, { apiKey: key, baseUrl: 'https://gateway.example/v2///', fetch: fetcher, backoffMs: 1 });
  const result = await runner.run({ task: input.tasks[0]!, tools: input.manifest.tools, trial: 0 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([url]) => url === 'https://gateway.example/v2/chat/completions')).toBe(true);
  expect(runner.metadata.gateway).toBe('https://gateway.example/v2');
  expect(result.api_requests).toBe(3);
});

it('requires the ZenMux key, not another provider key, and rejects unsafe base URLs', async () => {
  vi.stubEnv('ZENMUX_API_KEY', undefined);
  vi.stubEnv('OPENAI_API_KEY', key);
  const input = suite();
  await expect(new NativeModelRunner('zenmux', model).run({ task: input.tasks[0]!, tools: [], trial: 0 })).rejects.toThrow('Missing ZENMUX_API_KEY');
  for (const baseUrl of ['not-a-url', 'file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret']) {
    expect(() => new NativeModelRunner('zenmux', model, { baseUrl })).toThrow(/base URL/i);
  }
});

it('handles an empty response/catalog and omits unavailable or invalid token usage', async () => {
  const input = suite();
  const result = await new NativeModelRunner('zenmux', model, { apiKey: key, fetch: async () => Response.json({ choices: [], usage: { prompt_tokens: -1, completion_tokens: 'unknown' } }) })
    .run({ task: input.tasks[0]!, tools: [], trial: 0 });
  expect(result.call).toBeUndefined();
  expect(result.input_tokens).toBeUndefined();
  expect(result.output_tokens).toBeUndefined();
});

it.each(['json-error', 'text-error', 'network-error', 'success'] as const)('redacts credentials before errors or raw responses enter reports/traces: %s', async kind => {
  const fetcher: typeof fetch = async () => {
    if (kind === 'network-error') throw new Error(`Request failed: ${key}`);
    if (kind === 'text-error') return new Response(`Access denied: ${key}`, { status: 401 });
    if (kind === 'json-error') return Response.json({ error: { credential: key } }, { status: 401 });
    return Response.json({ ...completion(), debug: [key, { [key]: key }] });
  };
  const output = await evaluateSuite(suite(), new NativeModelRunner('zenmux', model, { apiKey: key, fetch: fetcher }), { trials: 1, B: 10 });
  expect(JSON.stringify(output)).not.toContain(key);
  expect(JSON.stringify(output)).toContain('[REDACTED]');
  expect(output.report.results[0]?.api_requests).toBe(1);
  if (kind !== 'success') expect(output.report.results[0]?.error).toBeTruthy();
});

it('passes --driver zenmux and --base-url through the CLI to a local HTTP stub', async () => {
  let requested = '';
  const server = createServer((request, response) => {
    requested = request.url ?? '';
    expect(request.headers.authorization).toBe(`Bearer ${key}`);
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(completion()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  const directory = await mkdtemp(join(tmpdir(), 'bench-zenmux-'));
  try {
    const input = suite();
    for (const [file, value] of [['config.json', input.config], ['manifest.json', input.manifest], ['tasks.json', input.tasks]]) {
      await writeFile(join(directory, String(file)), JSON.stringify(value));
    }
    const gateway = `http://127.0.0.1:${address.port}/v1`;
    await promisify(execFile)(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli.ts'),
      'run', '--suite', directory, '--driver', 'zenmux', '--base-url', gateway, '--model', model, '--trials', '1', '--out', directory],
    { env: { ...process.env, ZENMUX_API_KEY: key } });
    expect(requested).toBe('/v1/chat/completions');
    const report = JSON.parse(await readFile(join(directory, 'fixture.zenmux.anthropic_claude-sonnet-5_5.json'), 'utf8'));
    expect(report.driver_options.gateway).toBe(gateway);
    expect(report.results[0].first_try_pass).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
