import { setTimeout as delay } from 'node:timers/promises';
import type { EvalTask, ToolManifest } from '../types.js';

export type Driver = 'anthropic' | 'openai' | 'gemini' | 'zenmux' | 'mock';
export type ToolCall = { name: string; arguments: unknown };
export type ModelResponse = { raw: unknown; call?: ToolCall; schema_transformations: string[]; input_tokens?: number; output_tokens?: number; api_requests?: number };
export type ModelRequest = { task: EvalTask; tools: ToolManifest['tools']; trial: number };
export interface ModelRunner { driver: Driver; model: string; metadata?: Record<string, string | number>; run(request: ModelRequest): Promise<ModelResponse> }
const system = 'Help the user by choosing the appropriate available tool and supplying its arguments. Respond to the request in a single turn.';

export class ModelRequestError extends Error {
  constructor(message: string, public raw: unknown, public api_requests?: number) { super(message); }
}

function redact(value: unknown, key: string): unknown {
  if (typeof value === 'string') return value.replaceAll(key, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name.replaceAll(key, '[REDACTED]'), redact(item, key)]));
  return value;
}

export class NativeModelRunner implements ModelRunner {
  readonly baseUrl?: string;
  constructor(public driver: Exclude<Driver, 'mock'>, public model: string,
    private options: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch; retries?: number; backoffMs?: number } = {}) {
    if (options.baseUrl && driver !== 'openai' && driver !== 'zenmux') throw new Error('Base URL is supported only for openai and zenmux');
    if (driver === 'openai' || driver === 'zenmux') {
      let url: URL;
      try { url = new URL(options.baseUrl ?? (driver === 'zenmux' ? 'https://zenmux.ai/api/v1' : 'https://api.openai.com/v1')); }
      catch { throw new Error('Invalid base URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL must be HTTP(S), without credentials, query or fragment');
      this.baseUrl = url.href.replace(/\/+$/, '');
    }
  }

  get metadata(): Record<string, string | number> {
    return this.baseUrl ? { gateway: this.baseUrl, model_id: this.model } : {};
  }

  async run({ task, tools }: ModelRequest): Promise<ModelResponse> {
    const keyName = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', zenmux: 'ZENMUX_API_KEY' }[this.driver];
    const key = this.options.apiKey ?? process.env[keyName];
    if (!key) throw new Error(`Missing ${keyName}`);
    let url: string, body: unknown, headers: Record<string, string>;
    if (this.driver === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model: this.model, max_tokens: 4096, system, messages: [{ role: 'user', content: task.prompt }],
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) };
    } else if (this.driver === 'openai' || this.driver === 'zenmux') {
      url = `${this.baseUrl}/chat/completions`;
      headers = { Authorization: `Bearer ${key}` };
      body = { model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: task.prompt }],
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
      headers = { 'x-goog-api-key': key };
      body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: task.prompt }] }],
        tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] };
    }
    let raw: any;
    let api_requests = 0;
    const retries = this.options.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      api_requests++;
      try {
        const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            await response.body?.cancel();
            await delay((this.options.backoffMs ?? 500) * 2 ** attempt);
            continue;
          }
          const text = await response.text();
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = text; }
          throw new ModelRequestError(`${this.driver} HTTP ${response.status}`, redact({ status: response.status, body }, key), api_requests);
        }
        raw = redact(await response.json(), key);
        break;
      } catch (error) {
        if (error instanceof ModelRequestError) throw error;
        throw new ModelRequestError(String(redact(error instanceof Error ? error.message : String(error), key)), null, api_requests);
      }
    }
    let call: ToolCall | undefined;
    if (this.driver === 'anthropic') {
      const first = raw.content?.find((part: any) => part.type === 'tool_use');
      if (first) call = { name: first.name, arguments: first.input };
    } else if (this.driver === 'openai' || this.driver === 'zenmux') {
      const first = raw.choices?.[0]?.message?.tool_calls?.[0]?.function;
      if (first) {
        let args: unknown;
        try { args = JSON.parse(first.arguments); } catch { args = first.arguments; }
        call = { name: first.name, arguments: args };
      }
    } else {
      const first = raw.candidates?.[0]?.content?.parts?.find((part: any) => part.functionCall)?.functionCall;
      if (first) call = { name: first.name, arguments: first.args };
    }
    const input = this.driver === 'gemini' ? raw.usageMetadata?.promptTokenCount : this.driver === 'anthropic' ? raw.usage?.input_tokens : raw.usage?.prompt_tokens;
    const output = this.driver === 'gemini' ? raw.usageMetadata?.candidatesTokenCount : this.driver === 'anthropic' ? raw.usage?.output_tokens : raw.usage?.completion_tokens;
    const tokenCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    return { raw, call, schema_transformations: [], api_requests,
      ...(tokenCount(input) ? { input_tokens: input } : {}), ...(tokenCount(output) ? { output_tokens: output } : {}) };
  }
}

function randomFor(seed: number, key: string) {
  let state = seed >>> 0;
  for (const char of key) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(schema: any, root: any, depth = 0): any {
  if (!schema || depth > 12) return null;
  if (schema.$ref?.startsWith('#/')) {
    const resolved = schema.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return sample(resolved, root, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf ?? schema.oneOf)[0], root, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries((schema.required ?? []).map((key: string) => [key, sample(schema.properties?.[key], root, depth + 1)]));
  if (type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items, root, depth + 1));
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  if (schema.format === 'email') return 'person@example.com';
  if (schema.format === 'uuid') return '11111111-1111-4111-8111-111111111111';
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
  if (schema.format === 'uri') return 'https://example.com';
  return 'example'.padEnd(schema.minLength ?? 0, 'x');
}

export function setPointer(root: any, path: string, value: unknown): any {
  if (!path) return structuredClone(value);
  const keys = path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node = root;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe assertion pointer');
    if (i === keys.length - 1) node[key] = structuredClone(value);
    else { node[key] ??= /^\d+$/.test(keys[i + 1]!) ? [] : {}; node = node[key]; }
  }
  return root;
}

export class MockModelRunner implements ModelRunner {
  readonly driver = 'mock' as const;
  get metadata() { return { seed: this.seed, selection_probability: this.selectionProbability, invalid_arguments_probability: this.invalidArgumentsProbability }; }
  constructor(public model = 'mock-v1', public seed = 42, public selectionProbability = 0.8, public invalidArgumentsProbability = 0.2) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Mock seed must be a uint32');
    for (const p of [selectionProbability, invalidArgumentsProbability]) if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('Mock probabilities must be between 0 and 1');
  }
  async run({ task, tools, trial }: ModelRequest): Promise<ModelResponse> {
    const random = randomFor(this.seed, `${task.id}:${trial}`);
    const correct = random() < this.selectionProbability;
    const other = tools.filter(tool => !task.expected_tools.includes(tool.name));
    const name = correct ? task.expected_tools[Math.floor(random() * task.expected_tools.length)]! : other[Math.floor(random() * other.length)]?.name;
    if (!name) return { raw: { driver: 'mock', no_call: true }, schema_transformations: [] };
    const schema = tools.find(tool => tool.name === name)!.inputSchema;
    let args = sample(schema, schema);
    if (correct) for (const assertion of task.semantic_assertions) {
      if ('equals' in assertion) args = setPointer(args, assertion.path, assertion.equals);
      else if ('oneOf' in assertion) args = setPointer(args, assertion.path, assertion.oneOf[0]);
      else if ('iso8601' in assertion) args = setPointer(args, assertion.path, '2026-01-01T00:00:00Z');
      else if ('exists' in assertion && assertion.exists && assertion.path) args = setPointer(args, assertion.path, 'example');
    }
    if (random() < this.invalidArgumentsProbability) args = '__invalid_object__';
    const call = { name, arguments: args };
    return { raw: { driver: 'mock', call }, call, schema_transformations: [] };
  }
}
