import { expect, it } from 'vitest';
import { loadSuite, suitePaths } from '../src/runner/suites.js';

it('validates all nine suites, task counts, real expected tools, unique ids and blind prompts', async () => {
  const paths = await suitePaths();
  expect(paths).toHaveLength(9);
  for (const path of paths) {
    const suite = await loadSuite(path);
    expect(suite.tasks.length).toBeGreaterThanOrEqual(suite.config.server_name === 'fetch' ? 10 : 20);
    expect(suite.leaks, path).toEqual([]);
    if (suite.config.server_name === 'fetch') expect(suite.config.selection_metric).toBe('trivial_single_tool');
  }
});
