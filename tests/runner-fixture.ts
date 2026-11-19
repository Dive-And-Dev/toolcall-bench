import { ServerConfig, type EvalTask } from '../src/types.js';
import type { Suite } from '../src/runner/suites.js';

export function fixture(): Suite {
  const captured_at = '2026-01-01T00:00:00Z';
  const config = ServerConfig.parse({ server_name: 'fixture', repo_url: 'https://example.com/repo', architecture_type: 'static_catalog',
    snapshot_meta: { package: 'fixture', package_version: '1', captured_at, capture_method: 'test', capture_cmd: 'test', requires_auth_for_tools_list: false } });
  const tasks: EvalTask[] = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, server_name: 'fixture', prompt: `Convert a five second waiting budget to milliseconds, case ${i}.`,
    expected_tools: ['wait_ms'], semantic_assertions: [{ path: '/timeout', equals: 5000 }], rationale: 'Milliseconds conversion', tags: ['unit_ambiguity'] }));
  return { config, manifest: { captured_at, serverInfo: { name: 'fixture', version: '1' }, protocolVersion: '2025-03-26', tools: [
    { name: 'wait_ms', description: 'Wait in milliseconds', inputSchema: { type: 'object', properties: { timeout: { type: 'integer', minimum: 0 } }, required: ['timeout'], additionalProperties: false } },
    { name: 'other', description: 'Different operation', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ] }, tasks, leaks: [], manifest_sha256: 'fixture-manifest', tasks_sha256: 'fixture-tasks' };
}
