#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { introspect } from './mcp/introspect.js';
import { EvalReport, ToolManifest } from './types.js';
import { analyzeTokens } from './analyzer/tokens.js';
import { lintTools, RULES } from './analyzer/lint.js';
import { loadSuite, suitePaths } from './runner/suites.js';
import { MockModelRunner, NativeModelRunner, type Driver } from './runner/models.js';
import { evaluateSuite, writeEvaluation } from './runner/evaluator.js';
import { diffReports, markdownDiff } from './runner/diff.js';
import { buildSite } from './site/generator.js';

export function parsePairs(values: string[], separator: string): Record<string, string> {
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf(separator);
    if (index <= 0) throw new Error(`Expected KEY${separator}VALUE`);
    return [value.slice(0, index).trim(), separator === ':' ? value.slice(index + 1).trim() : value.slice(index + 1)];
  }));
}

const program = new Command().name('toolcall-bench').description('Evaluate MCP tool-calling developer experience');
program.command('build-site')
  .option('--results <directory>', 'Evaluation reports and neighboring traces', 'results')
  .option('--out <directory>', 'Static site output', 'dist-site')
  .option('--allow-mock-preview', 'Watermark every page as synthetic preview data')
  .action(async options => {
    const built = await buildSite(options);
    console.log(`Built ${built.servers} server pages from ${built.runs} runs in ${built.out}`);
  });
program.command('lint-tasks [suite]')
  .option('--all', 'Validate every captured suite')
  .action(async (suite: string | undefined, options) => {
    if (suite && options.all) throw new Error('Provide a suite or --all, not both');
    let leaks = 0, count = 0;
    for (const path of suite ? [suite] : await suitePaths()) {
      const loaded = await loadSuite(path);
      count += loaded.tasks.length; leaks += loaded.leaks.length;
      console.log(`${loaded.config.server_name}: ${loaded.tasks.length} tasks, ${loaded.leaks.length} leaks`);
      for (const finding of loaded.leaks) console.log(`${finding.task_id}: ${finding.tool}: ${finding.match}`);
    }
    console.log(`${count} tasks validated; ${leaks} leaks`);
    if (leaks) process.exitCode = 1;
  });
program.command('run')
  .option('--suite <path>', 'Suite directory')
  .option('--all', 'Run all captured suites')
  .requiredOption('--driver <driver>', 'anthropic, openai, gemini, zenmux, or mock')
  .option('--base-url <url>', 'OpenAI-compatible API base URL (zenmux defaults to https://zenmux.ai/api/v1)')
  .option('--model <model>', 'Provider model identifier (mock defaults to mock-v1)')
  .option('--trials <n>', 'Trials per task', '3')
  .option('--concurrency <n>', 'Maximum simultaneous model requests', '4')
  .option('--seed <n>', 'Mock and bootstrap seed', '42')
  .option('--selection-probability <p>', 'Mock correct selection probability', '0.8')
  .option('--invalid-arguments-probability <p>', 'Mock invalid arguments probability', '0.2')
  .option('--ci', 'Explicitly allow synthetic mock execution')
  .option('--out <directory>', 'Report and trace output directory', 'results')
  .action(async options => {
    if (Boolean(options.suite) === Boolean(options.all)) throw new Error('Provide --suite or --all, not both');
    if (!['anthropic', 'openai', 'gemini', 'zenmux', 'mock'].includes(options.driver)) throw new Error('Unknown driver');
    const driver = options.driver as Driver;
    if (driver === 'mock' && !options.ci && process.env.CI !== 'true') throw new Error('Mock driver requires --ci or CI=true');
    if (driver !== 'mock' && !options.model) throw new Error('--model is required for live drivers');
    if (options.baseUrl && driver !== 'openai' && driver !== 'zenmux') throw new Error('--base-url is supported only for openai and zenmux');
    const keyName = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', zenmux: 'ZENMUX_API_KEY', mock: '' }[driver];
    if (keyName && !process.env[keyName]) throw new Error(`Missing ${keyName}`);
    const seed = Number(options.seed);
    const runner = driver === 'mock'
      ? new MockModelRunner(options.model ?? 'mock-v1', seed, Number(options.selectionProbability), Number(options.invalidArgumentsProbability))
      : new NativeModelRunner(driver, options.model, { baseUrl: options.baseUrl });
    console.log('suite\tdriver\tmodel\tselection\tconditional_params\tfirst_try\tschema_errors');
    for (const path of options.all ? await suitePaths() : [options.suite]) {
      const output = await evaluateSuite(await loadSuite(path), runner, { trials: Number(options.trials), concurrency: Number(options.concurrency), seed });
      const file = await writeEvaluation(output, options.out);
      const metric = (name: string) => output.report.metrics[name]?.mean.toFixed(4) ?? 'N/A';
      console.log([output.report.server_name, driver, runner.model, metric('tool_selection_accuracy'), metric('param_compliance_conditional'),
        metric('end_to_end_first_try_pass'), Object.keys(output.report.schema_compilation_errors).length].join('\t'));
      console.log(`Report: ${file}; selection metric: ${output.report.selection_metric}`);
    }
  });
program.command('diff <baseline> <candidate>')
  .option('--markdown', 'Print a Markdown comparison')
  .option('--fail-on-regression', 'Exit 1 for a significant metric regression')
  .action(async (baseline: string, candidate: string, options) => {
    const [left, right] = await Promise.all([baseline, candidate].map(async path => EvalReport.parse(JSON.parse(await readFile(path, 'utf8')))));
    const diff = diffReports(left!, right!);
    console.log(options.markdown ? markdownDiff(diff) : JSON.stringify(diff, null, 2));
    if (options.failOnRegression && diff.regression) process.exitCode = 1;
  });
program.command('lint [manifest]')
  .description('Analyze a manifest, or all suites relative to the current directory')
  .option('--all', 'Analyze suites/*/manifest.json')
  .option('--json', 'Print machine-readable JSON')
  .action(async (manifest: string | undefined, options) => {
    if (Boolean(manifest) === Boolean(options.all)) throw new Error('Provide a manifest or --all, not both');
    const paths = options.all
      ? (await readdir('suites', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join('suites', entry.name, 'manifest.json')).sort()
      : [manifest!];
    const reports = [];
    for (const path of paths) {
      let contents: string;
      try { contents = await readFile(path, 'utf8'); }
      catch (error) {
        if (options.all && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const parsed = ToolManifest.parse(JSON.parse(contents));
      reports.push({ server: options.all ? dirname(path).split('/').pop()! : parsed.serverInfo.name, path,
        tokens: analyzeTokens(parsed.tools), lint: lintTools(parsed.tools) });
    }
    if (options.json) console.log(JSON.stringify(options.all ? reports : reports[0], null, 2));
    else {
      console.log(['server', 'tools', 'tokens', ...RULES, 'findings/tool'].join('\t'));
      for (const report of reports) {
        console.log([report.server, report.tokens.tool_count, report.tokens.catalog_tokens,
          ...RULES.map(rule => report.lint.counts[rule]), report.lint.findings_per_tool.toFixed(3)].join('\t'));
        if (!options.all) {
          console.log(`Median tokens/tool: ${report.tokens.median_tokens_per_tool}`);
          for (const finding of report.lint.findings) console.log(`${finding.rule} ${finding.tool}${finding.path}: ${finding.message}`);
        }
      }
    }
  });
program.command('snapshot')
  .option('--cmd <cmd>', 'Trusted local shell command (executed through /bin/sh)')
  .option('--url <url>', 'Streamable HTTP MCP endpoint')
  .option('--env <K=V>', 'Child environment override', (value: string, previous: string[]) => [...previous, value], [])
  .option('--header <header>', 'HTTP header as Name: Value', (value: string, previous: string[]) => [...previous, value], [])
  .option('--timeout <ms>', 'Total snapshot timeout', '60000')
  .requiredOption('--out <path>', 'Output manifest JSON')
  .action(async (options) => {
    const timeoutMs = Number(options.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be positive');
    const manifest = await introspect({ cmd: options.cmd, url: options.url, env: parsePairs(options.env, '='), headers: parsePairs(options.header, ':'), timeoutMs });
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Captured ${manifest.tools.length} tools from ${manifest.serverInfo.name} -> ${options.out}`);
  });

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  program.parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
