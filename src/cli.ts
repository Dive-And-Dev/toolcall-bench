#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { introspect } from './mcp/introspect.js';
import { ToolManifest } from './types.js';
import { analyzeTokens } from './analyzer/tokens.js';
import { lintTools, RULES } from './analyzer/lint.js';

export function parsePairs(values: string[], separator: string): Record<string, string> {
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf(separator);
    if (index <= 0) throw new Error(`Expected KEY${separator}VALUE`);
    return [value.slice(0, index).trim(), separator === ':' ? value.slice(index + 1).trim() : value.slice(index + 1)];
  }));
}

const program = new Command().name('toolcall-bench').description('Evaluate MCP tool-calling developer experience');
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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  program.parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
