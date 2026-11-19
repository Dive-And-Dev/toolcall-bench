import { EvalReport } from '../types.js';
import { pairedBootstrap, type BootstrapOptions } from '../analyzer/stats.js';
import { METRICS, metricTasks } from './evaluator.js';

export function diffReports(baseline: EvalReport, candidate: EvalReport, options: BootstrapOptions = {}) {
  baseline = EvalReport.parse(baseline); candidate = EvalReport.parse(candidate);
  if (baseline.server_name !== candidate.server_name) throw new Error('Cannot diff reports from different suites');
  if (baseline.tasks_sha256 !== candidate.tasks_sha256) throw new Error('Cannot pair reports with different task definitions');
  const metrics = Object.fromEntries(METRICS.map(metric => {
    const left = metricTasks(baseline.results, metric), right = metricTasks(candidate.results, metric);
    const shared = new Set(left.map(task => task.id));
    return [metric, right.some(task => shared.has(task.id)) ? pairedBootstrap(left, right, options) : null];
  }));
  const rules = new Set([...Object.keys(baseline.lint.counts), ...Object.keys(candidate.lint.counts)]);
  return { server_name: baseline.server_name, baseline: { driver: baseline.driver, model: baseline.model }, candidate: { driver: candidate.driver, model: candidate.model },
    metrics, token_delta: candidate.tokens.catalog_tokens - baseline.tokens.catalog_tokens,
    lint_delta: candidate.lint.total_findings - baseline.lint.total_findings,
    lint_rule_deltas: Object.fromEntries([...rules].map(rule => [rule, (candidate.lint.counts[rule] ?? 0) - (baseline.lint.counts[rule] ?? 0)])),
    regression: Object.values(metrics).some(metric => metric?.verdict === 'regression') };
}

export function markdownDiff(diff: ReturnType<typeof diffReports>) {
  return [`# ${diff.server_name} comparison`, '', '| Metric | Delta | 95% CI | p-value | Verdict |', '|---|---:|---|---:|---|',
    ...Object.entries(diff.metrics).map(([name, metric]) => metric
      ? `| ${name} | ${metric.delta.toFixed(4)} | [${metric.ci_low.toFixed(4)}, ${metric.ci_high.toFixed(4)}] | ${metric.p_value.toFixed(4)} | ${metric.verdict} |`
      : `| ${name} | N/A | N/A | N/A | not comparable |`), '', `Token delta: ${diff.token_delta}; lint finding delta: ${diff.lint_delta}`,
    ...Object.entries(diff.lint_rule_deltas).map(([rule, delta]) => `- ${rule}: ${delta}`)].join('\n');
}
