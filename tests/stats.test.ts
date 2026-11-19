import { describe, expect, it } from 'vitest';
import { clusterBootstrap, pairedBootstrap } from '../src/analyzer/stats.js';

describe('task cluster bootstrap', () => {
  it('has a degenerate interval for all ones', () => {
    expect(clusterBootstrap([[1, 1], [1, 1]])).toMatchObject({ mean: 1, ci_low: 1, ci_high: 1, half_width: 0, n_tasks: 2, n_trials: 4, B: 5000, seed: 42 });
  });
  it('weights tasks equally, not trials', () => {
    expect(clusterBootstrap([[0], [1, 1, 1]])).toMatchObject({ mean: 0.5, n_trials: 4 });
  });
  it('is deterministic with a seed', () => {
    const tasks = [[0, 1], [1, 1], [0, 0], [0, 1]];
    expect(clusterBootstrap(tasks, { seed: 123, B: 321 })).toEqual(clusterBootstrap(tasks, { seed: 123, B: 321 }));
    expect(clusterBootstrap(tasks, { B: 321 }).B).toBe(321);
  });
  it('shrinks interval width with more independent tasks', () => {
    const small = Array.from({ length: 10 }, (_, i) => [i % 2]);
    const large = Array.from({ length: 1000 }, (_, i) => [i % 2]);
    expect(clusterBootstrap(large).half_width).toBeLessThan(clusterBootstrap(small).half_width);
  });
  it('handles a single task without treating trials as clusters', () => {
    expect(clusterBootstrap([[0, 1]])).toMatchObject({ mean: 0.5, ci_low: 0.5, ci_high: 0.5 });
  });
  it('rejects empty/nonbinary data and invalid settings', () => {
    for (const tasks of [[], [[]], [[2]], [[NaN]]]) expect(() => clusterBootstrap(tasks)).toThrow();
    for (const options of [{ B: 0 }, { B: 1.5 }, { seed: -1 }, { seed: NaN }]) expect(() => clusterBootstrap([[1]], options)).toThrow();
  });
});

describe('paired task bootstrap', () => {
  const baseline = [{ id: 'b', outcomes: [0, 1] }, { id: 'a', outcomes: [0, 0] }];
  it('has no significant difference for identical inputs', () => {
    expect(pairedBootstrap(baseline, [...baseline].reverse())).toMatchObject({ delta: 0, ci_low: 0, ci_high: 0, p_value: 1, verdict: 'not_significant' });
  });
  it('detects a clear improvement and regression', () => {
    const candidate = baseline.map(task => ({ id: task.id, outcomes: [1, 1] }));
    expect(pairedBootstrap(baseline, candidate)).toMatchObject({ delta: 0.75, p_value: 0, verdict: 'improvement', n_tasks: 2, n_trials: 8 });
    expect(pairedBootstrap(candidate, baseline).verdict).toBe('regression');
  });
  it('matches by id and explicitly reports unmatched tasks', () => {
    const candidate = [{ id: 'a', outcomes: [1] }, { id: 'other', outcomes: [0] }];
    expect(pairedBootstrap(baseline, candidate)).toMatchObject({ delta: 1, n_tasks: 1, unmatched_baseline: 1, unmatched_candidate: 1, matched_task_ids: ['a'] });
  });
  it('is seeded and keeps a zero-touching CI nonsignificant', () => {
    const candidate = [{ id: 'a', outcomes: [1] }, { id: 'b', outcomes: [0] }];
    const base = candidate.map(task => ({ ...task, outcomes: [0] }));
    const result = pairedBootstrap(base, candidate, { seed: 8 });
    expect(result).toEqual(pairedBootstrap(base, candidate, { seed: 8 }));
    expect(result).toMatchObject({ ci_low: 0, verdict: 'not_significant' });
    expect(result.p_value).toBeGreaterThan(0);
    expect(result.p_value).toBeLessThanOrEqual(1);
  });
  it('rejects no shared tasks, duplicate ids, and invalid outcomes', () => {
    expect(() => pairedBootstrap([], [])).toThrow();
    expect(() => pairedBootstrap(baseline, [{ id: 'other', outcomes: [1] }])).toThrow();
    expect(() => pairedBootstrap([...baseline, baseline[0]!], baseline)).toThrow('unique');
    expect(() => pairedBootstrap(baseline, [{ id: 'a', outcomes: [] }])).toThrow('binary');
  });
});
