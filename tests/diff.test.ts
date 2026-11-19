import { expect, it } from 'vitest';
import { evaluateSuite } from '../src/runner/evaluator.js';
import { MockModelRunner } from '../src/runner/models.js';
import { diffReports, markdownDiff } from '../src/runner/diff.js';
import { fixture } from './runner-fixture.js';

it('pairs identical runs by task id and reports zero deltas', async () => {
  const { report } = await evaluateSuite(fixture(), new MockModelRunner(), { B: 100 });
  const diff = diffReports(report, report, { B: 100 });
  expect(diff.metrics.tool_selection_accuracy).toMatchObject({ delta: 0, p_value: 1, verdict: 'not_significant', n_tasks: 10 });
  expect(diff).toMatchObject({ token_delta: 0, lint_delta: 0, regression: false });
  expect(markdownDiff(diff)).toContain('| tool_selection_accuracy |');
});

it('detects clear improvements and regressions and computes lint/token deltas', async () => {
  const { report: bad } = await evaluateSuite(fixture(), new MockModelRunner('bad', 1, 0, 0), { B: 100 });
  const { report: good } = await evaluateSuite(fixture(), new MockModelRunner('good', 2, 1, 0), { B: 100 });
  good.tokens.catalog_tokens += 5;
  good.lint.total_findings += 2;
  good.lint.counts.MISSING_DESCRIPTION = (good.lint.counts.MISSING_DESCRIPTION ?? 0) + 2;
  const improvement = diffReports(bad, good, { B: 100 });
  expect(improvement.metrics.end_to_end_first_try_pass).toMatchObject({ delta: 1, verdict: 'improvement' });
  expect(improvement).toMatchObject({ token_delta: 5, lint_delta: 2, regression: false });
  expect(diffReports(good, bad, { B: 100 }).regression).toBe(true);
  expect(improvement.metrics.param_compliance_conditional).toBeNull();
});

it('refuses cross-suite and changed-task comparisons', async () => {
  const { report } = await evaluateSuite(fixture(), new MockModelRunner(), { B: 100 });
  expect(() => diffReports(report, { ...report, server_name: 'other' })).toThrow('different suites');
  expect(() => diffReports(report, { ...report, tasks_sha256: 'changed' })).toThrow('task definitions');
});

it('handles generic executors and no shared conditional denominators', async () => {
  const suite = fixture(); suite.config.architecture_type = 'generic_executor';
  const { report } = await evaluateSuite(suite, new MockModelRunner(), { B: 100 });
  const diff = diffReports(report, report, { B: 100 });
  expect(diff.metrics.tool_selection_accuracy).toBeNull();
  expect(markdownDiff(diff)).toContain('N/A');
});
