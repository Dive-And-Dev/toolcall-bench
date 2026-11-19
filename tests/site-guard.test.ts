import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildSite } from '../src/site/generator.js';
import { evaluateSuite, writeEvaluation } from '../src/runner/evaluator.js';
import { MockModelRunner } from '../src/runner/models.js';
import { diffReports } from '../src/runner/diff.js';
import { fixture } from './runner-fixture.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'site-guard-')); directories.push(root);
  const suites = join(root, 'suites'), results = join(root, 'results'), out = join(root, 'site');
  await mkdir(suites);
  await writeFile(join(suites, 'config.json'), JSON.stringify(fixture().config));
  const output = await evaluateSuite(fixture(), new MockModelRunner(), { trials: 1, B: 20 });
  await writeEvaluation(output, results);
  return { root, suites, results, out, output };
}
it('rejects mock reports without explicit preview opt-in before writing', async () => {
  const options = await setup();
  await expect(buildSite(options)).rejects.toThrow('Mock results require');
  await expect(readdir(options.out)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects placeholder configs and embedded placeholder snapshot provenance even with preview opt-in', async () => {
  const options = await setup();
  await writeFile(join(options.suites, 'config.json'), JSON.stringify({ ...fixture().config, capture_status: 'placeholder' }));
  await expect(buildSite({ ...options, allowMockPreview: true })).rejects.toThrow('Placeholder');
  await writeFile(join(options.suites, 'config.json'), '{}');
  const file = join(options.results, 'fixture.mock.mock-v1.json');
  await writeFile(file, JSON.stringify({ ...options.output.report, snapshot: { ...options.output.report.snapshot, capture_status: 'placeholder' } }));
  await expect(buildSite({ ...options, allowMockPreview: true })).rejects.toThrow('Placeholder');
});
it('watermarks every preview page, escapes traces, renders intervals and paired diffs without cross-server scores', async () => {
  const options = await setup();
  options.output.traces[0]!.prompt = '<script>alert("unsafe")</script>';
  await writeEvaluation(options.output, options.results);
  await writeFile(join(options.results, 'diff.json'), JSON.stringify(diffReports(options.output.report, options.output.report, { B: 20 })));
  const second = structuredClone(options.output);
  second.report.model = 'second';
  await writeEvaluation(second, options.results);
  await buildSite({ ...options, allowMockPreview: true });
  const paths = (await readdir(options.out)).filter(path => path.endsWith('.html'));
  expect(paths).toHaveLength(2);
  for (const path of paths) {
    const html = await readFile(join(options.out, path), 'utf8');
    expect(html).toContain('MOCK DATA — NOT A BENCHMARK RESULT');
    expect(html).not.toMatch(/ranking|leaderboard|composite score|\bgrades?\b|buy now|contact sales/i);
    expect(html).not.toContain('<script>');
  }
  const index = await readFile(join(options.out, 'index.html'), 'utf8');
  expect(index).not.toMatch(/tool_selection_accuracy|catalog_tokens|first_try/);
  const card = await readFile(join(options.out, paths.find(path => path !== 'index.html')!), 'utf8');
  expect(card).toContain('aria-label="Mean');
  expect(card).toContain('not statistically distinguishable');
  expect(card).toContain('Deferred loading');
  expect(card).toContain('&lt;script&gt;');
  expect(card).toContain('Paired 95% CI');
  expect((await readdir(options.out)).filter(path => path.endsWith('.jsonl'))).toHaveLength(2);
});
it('lists servers alphabetically using identity-only columns and removes stale generated pages', async () => {
  const options = await setup();
  const other = structuredClone(options.output);
  other.report.server_name = 'aardvark';
  other.report.snapshot.server_name = 'aardvark';
  await writeEvaluation(other, options.results);
  await mkdir(options.out);
  await writeFile(join(options.out, 'suite-0000000000000000.html'), 'old unmarked output');
  await buildSite({ ...options, allowMockPreview: true });
  const html = await readFile(join(options.out, 'index.html'), 'utf8');
  expect(html.indexOf('>aardvark</a>')).toBeLessThan(html.indexOf('>fixture</a>'));
  expect(html.match(/<th>/g)).toHaveLength(3);
  expect(await readdir(options.out)).not.toContain('suite-0000000000000000.html');
});
it('supports non-mock reports without a watermark and refuses empty or missing trace inputs', async () => {
  const options = await setup();
  options.output.report.driver = 'openai';
  options.output.report.results.forEach(result => { result.driver = 'openai'; });
  options.output.traces.forEach(trace => { trace.driver = 'openai'; delete trace.raw_response; });
  await rm(options.results, { recursive: true });
  await writeEvaluation(options.output, options.results);
  await buildSite(options);
  expect(await readFile(join(options.out, 'index.html'), 'utf8')).not.toContain('MOCK DATA');
  await rm(join(options.results, 'fixture.openai.mock-v1.traces.jsonl'));
  await expect(buildSite(options)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(options.results, 'fixture.openai.mock-v1.json'));
  await expect(buildSite(options)).rejects.toThrow('No evaluation reports');
});
it('rejects embedded mock trials and mock diffs even if the top-level report says live', async () => {
  const options = await setup();
  options.output.report.driver = 'openai';
  await rm(options.results, { recursive: true });
  await writeEvaluation(options.output, options.results);
  await expect(buildSite(options)).rejects.toThrow('Mock results require');
  await rm(join(options.results, 'fixture.openai.mock-v1.json'));
  await writeFile(join(options.results, 'diff.json'), JSON.stringify(diffReports({ ...options.output.report, driver: 'mock' }, options.output.report, { B: 20 })));
  await expect(buildSite(options)).rejects.toThrow('Mock results require');
});
