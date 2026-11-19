import type { EvalTask, ToolManifest } from '../types.js';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function splitIdentifier(name: string): string[] {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

export function lintLeakage(tasks: readonly EvalTask[], tools: ToolManifest['tools']) {
  const findings: { task_id: string; tool: string; match: string; message: string }[] = [];
  for (const task of tasks) for (const tool of tools) {
    const parts = splitIdentifier(tool.name);
    if (!parts.length) continue;
    const identifier = parts.map(escape).join('[-_\\s]*');
    const pattern = parts.length === 1
      ? new RegExp('`\\s*' + escape(tool.name) + '\\s*`|(?<![a-z0-9_])' + escape(tool.name) + '(?![a-z0-9_])\\s*(?:\\(|tool\\b)', 'i')
      : new RegExp('(?<![a-z0-9_])(?:' + escape(tool.name) + '|' + identifier + ')(?![a-z0-9_])', 'i');
    const match = task.prompt.match(pattern);
    if (match) findings.push({ task_id: task.id, tool: tool.name, match: match[0], message: 'Prompt reveals a catalog tool identifier' });
  }
  return findings;
}
