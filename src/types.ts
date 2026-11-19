import { z } from 'zod';

const timestamp = z.iso.datetime();
export const ServerConfig = z.object({
  server_name: z.string().min(1),
  repo_url: z.url(),
  architecture_type: z.enum(['static_catalog', 'dynamic_toolset', 'generic_executor']),
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

export const EvalTask = z.object({
  id: z.string().min(1),
  server_name: z.string().min(1),
  prompt: z.string().min(1),
  expected_tools: z.array(z.string()),
  expected_arguments: z.record(z.string(), z.unknown()).optional(),
});
export type EvalTask = z.infer<typeof EvalTask>;
export const TrialResult = z.object({
  task_id: z.string(),
  model: z.string(),
  trial: z.number().int().nonnegative(),
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })),
  success: z.boolean(),
  duration_ms: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type TrialResult = z.infer<typeof TrialResult>;
export const EvalReport = z.object({
  generated_at: timestamp,
  server_name: z.string(),
  results: z.array(TrialResult),
});
export type EvalReport = z.infer<typeof EvalReport>;
