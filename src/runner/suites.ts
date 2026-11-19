import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvalTask, ServerConfig, ToolManifest } from '../types.js';
import { lintLeakage } from '../analyzer/leakage.js';

export async function suitePaths() {
  const paths: string[] = [];
  for (const entry of (await readdir('suites', { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join('suites', entry.name);
    try { await readFile(join(path, 'manifest.json')); paths.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return paths;
}

export async function loadSuite(path: string) {
  const [configText, manifestText, tasksText] = await Promise.all(['config.json', 'manifest.json', 'tasks.json'].map(file => readFile(join(path, file), 'utf8')));
  const config = ServerConfig.parse(JSON.parse(configText!));
  const manifest = ToolManifest.parse(JSON.parse(manifestText!));
  const tasks = z.array(EvalTask).min(1).parse(JSON.parse(tasksText!));
  const names = new Set(manifest.tools.map(tool => tool.name));
  if (names.size !== manifest.tools.length) throw new Error('Duplicate manifest tool names');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.server_name !== config.server_name) throw new Error(`Task ${task.id} belongs to a different suite`);
    for (const name of task.expected_tools) if (!names.has(name)) throw new Error(`Task ${task.id} expects unknown tool ${name}`);
    for (const assertion of task.semantic_assertions) if ('matches' in assertion) new RegExp(assertion.matches);
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { config, manifest, tasks, leaks: lintLeakage(tasks, manifest.tools), manifest_sha256: hash(manifestText!), tasks_sha256: hash(tasksText!) };
}
export type Suite = Awaited<ReturnType<typeof loadSuite>>;
