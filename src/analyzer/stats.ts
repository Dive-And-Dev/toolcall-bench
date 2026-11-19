export type BootstrapOptions = { B?: number; seed?: number };
export type TaskOutcomes = { id: string; outcomes: readonly number[] };

function settings(options: BootstrapOptions) {
  const { B = 5000, seed = 42 } = options;
  if (!Number.isInteger(B) || B < 1) throw new Error('B must be a positive integer');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be a uint32');
  return { B, seed };
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function taskMean(outcomes: readonly number[]): number {
  if (!outcomes.length || outcomes.some(value => value !== 0 && value !== 1)) throw new Error('Each task needs nonempty binary trial outcomes');
  return mean(outcomes);
}

function percentile(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
}

function bootstrap(values: number[], options: BootstrapOptions) {
  if (!values.length) throw new Error('At least one task is required');
  const { B, seed } = settings(options);
  const random = mulberry32(seed);
  const draws = Array.from({ length: B }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    return sum / values.length;
  }).sort((a, b) => a - b);
  const ci_low = percentile(draws, 0.025), ci_high = percentile(draws, 0.975);
  return { draws, ci_low, ci_high, half_width: (ci_high - ci_low) / 2, B, seed };
}

export function clusterBootstrap(tasks: readonly (readonly number[])[], options: BootstrapOptions = {}) {
  const means = tasks.map(taskMean);
  const { draws: _, ...summary } = bootstrap(means, options);
  return { mean: mean(means), ...summary, n_tasks: tasks.length, n_trials: tasks.reduce((sum, task) => sum + task.length, 0) };
}

export function pairedBootstrap(baseline: readonly TaskOutcomes[], candidate: readonly TaskOutcomes[], options: BootstrapOptions = {}) {
  const index = (tasks: readonly TaskOutcomes[]) => {
    const result = new Map<string, { mean: number; trials: number }>();
    for (const task of tasks) {
      if (!task.id || result.has(task.id)) throw new Error('Task ids must be nonempty and unique');
      result.set(task.id, { mean: taskMean(task.outcomes), trials: task.outcomes.length });
    }
    return result;
  };
  const left = index(baseline), right = index(candidate);
  const ids = [...left.keys()].filter(id => right.has(id)).sort();
  const deltas = ids.map(id => right.get(id)!.mean - left.get(id)!.mean);
  const { draws, ...summary } = bootstrap(deltas, options);
  const delta = mean(deltas);
  const p_value = Math.min(1, 2 * draws.filter(value => delta >= 0 ? value <= 0 : value >= 0).length / draws.length);
  const verdict = summary.ci_low > 0 ? 'improvement' : summary.ci_high < 0 ? 'regression' : 'not_significant';
  return { delta, ...summary, p_value, verdict, n_tasks: ids.length,
    n_trials: ids.reduce((sum, id) => sum + left.get(id)!.trials + right.get(id)!.trials, 0),
    matched_task_ids: ids, unmatched_baseline: left.size - ids.length, unmatched_candidate: right.size - ids.length };
}
