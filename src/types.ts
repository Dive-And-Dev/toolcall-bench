import { z } from 'zod';

const timestamp = z.iso.datetime();
export const ServerConfig = z.object({
  server_name: z.string().min(1),
  repo_url: z.url(),
  architecture_type: z.enum(['static_catalog', 'dynamic_toolset', 'generic_executor']),
  selection_metric: z.enum(['standard', 'trivial_single_tool']).default('standard'),
  snapshot_meta: z.object({
    package: z.string().min(1),
    package_version: z.string().min(1),
    git_sha: z.string().optional(),
    captured_at: timestamp,
    capture_method: z.string().min(1),
    capture_cmd: z.string().min(1),
    requires_auth_for_tools_list: z.boolean(),
  }),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export const ToolManifest = z.object({
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
  }).passthrough()),
  serverInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
  protocolVersion: z.string().min(1),
  captured_at: timestamp,
});
export type ToolManifest = z.infer<typeof ToolManifest>;

export const SemanticAssertion = z.union([
  z.object({ path: z.string().regex(/^(?:\/|$)/), equals: z.json() }).strict(),
  z.object({ path: z.string().regex(/^(?:\/|$)/), matches: z.string() }).strict(),
  z.object({ path: z.string().regex(/^(?:\/|$)/), iso8601: z.literal(true) }).strict(),
  z.object({ path: z.string().regex(/^(?:\/|$)/), exists: z.boolean() }).strict(),
  z.object({ path: z.string().regex(/^(?:\/|$)/), oneOf: z.array(z.json()).min(1) }).strict(),
]);
export type SemanticAssertion = z.infer<typeof SemanticAssertion>;
export const EvalTask = z.object({
  id: z.string().min(1),
  server_name: z.string().min(1),
  prompt: z.string().min(1),
  expected_tools: z.array(z.string()).min(1),
  semantic_assertions: z.array(SemanticAssertion).min(1),
  rationale: z.string().min(1),
  tags: z.array(z.enum(['everyday', 'edge', 'unit_ambiguity'])).min(1),
  expected_arguments: z.record(z.string(), z.unknown()).optional(),
});
export type EvalTask = z.infer<typeof EvalTask>;
export const TrialResult = z.object({
  task_id: z.string(),
  model: z.string(),
  trial: z.number().int().nonnegative(),
  driver: z.enum(['anthropic', 'openai', 'gemini', 'mock']),
  selected_tool: z.string().nullable(),
  selection_correct: z.boolean().nullable(),
  param_compliance_eligible: z.boolean(),
  schema_valid: z.boolean(),
  assertions_pass: z.boolean(),
  first_try_pass: z.boolean(),
  duration_ms: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type TrialResult = z.infer<typeof TrialResult>;
export const EvalReport = z.object({
  started_at: timestamp,
  completed_at: timestamp,
  server_name: z.string(),
  driver: z.enum(['anthropic', 'openai', 'gemini', 'mock']),
  model: z.string(),
  trials: z.number().int().positive(),
  driver_options: z.record(z.string(), z.union([z.string(), z.number()])),
  seed: z.number().int().nonnegative(),
  snapshot: ServerConfig,
  manifest_sha256: z.string(),
  tasks_sha256: z.string(),
  metrics: z.record(z.string(), z.object({
    mean: z.number(), ci_low: z.number(), ci_high: z.number(), half_width: z.number(),
    n_tasks: z.number().int(), n_trials: z.number().int(), B: z.number().int(), seed: z.number().int(),
  }).nullable()),
  selection_metric: z.string(),
  tokens: z.object({ catalog_tokens: z.number(), tool_count: z.number() }).passthrough(),
  lint: z.object({ total_findings: z.number(), counts: z.record(z.string(), z.number()) }).passthrough(),
  schema_compilation_errors: z.record(z.string(), z.string()),
  results: z.array(TrialResult),
});
export type EvalReport = z.infer<typeof EvalReport>;
