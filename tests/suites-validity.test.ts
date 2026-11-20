import { expect, it } from 'vitest';
import { loadSuite, suitePaths } from '../src/runner/suites.js';

it('validates all nine suites, task counts, real expected tools, unique ids and blind prompts', async () => {
  const paths = await suitePaths();
  expect(paths).toHaveLength(9);
  for (const path of paths) {
    const suite = await loadSuite(path);
    expect(suite.tasks.length).toBeGreaterThanOrEqual(suite.config.server_name === 'fetch' ? 10 : 20);
    expect(suite.leaks, path).toEqual([]);
    for (const task of suite.tasks) for (const assertion of task.semantic_assertions) {
      if ('equals' in assertion && typeof assertion.equals === 'string' && /\s/.test(assertion.equals.trim())) {
        expect(task.prompt, `${task.id}: exact multi-word text must be explicit`).toContain(`"${assertion.equals}"`);
      }
    }
    if (suite.config.server_name === 'fetch') expect(suite.config.selection_metric).toBe('trivial_single_tool');
  }
});
