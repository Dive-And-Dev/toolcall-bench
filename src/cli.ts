#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { introspect } from './mcp/introspect.js';

export function parsePairs(values: string[], separator: string): Record<string, string> {
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf(separator);
    if (index <= 0) throw new Error(`Expected KEY${separator}VALUE`);
    return [value.slice(0, index).trim(), separator === ':' ? value.slice(index + 1).trim() : value.slice(index + 1)];
  }));
}

const program = new Command().name('toolcall-bench').description('Evaluate MCP tool-calling developer experience');
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
