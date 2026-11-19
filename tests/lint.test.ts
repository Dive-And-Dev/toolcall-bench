import { describe, expect, it } from 'vitest';
import { lintTools, type Rule } from '../src/analyzer/lint.js';
import type { ToolManifest } from '../src/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tool = (properties: Record<string, unknown> = {}, description = 'Perform a useful operation'): ToolManifest['tools'][number] => ({
  name: 'test', description, inputSchema: { type: 'object', properties },
});
const findings = (rule: Rule, tools: ToolManifest['tools']) => lintTools(tools).findings.filter(f => f.rule === rule);

describe('deterministic lint rules', () => {
  it('finds missing tool and nested parameter descriptions, not documented parameters', () => {
    const result = findings('MISSING_DESCRIPTION', [tool({ parent: { type: 'object', description: 'Parent', properties: { child: { type: 'string' } } } }, ' ')]);
    expect(result.map(f => f.path)).toEqual(['/description', '/inputSchema/properties/parent/properties/child']);
    expect(findings('MISSING_DESCRIPTION', [tool({ value: { type: 'string', description: 'A value' } })])).toEqual([]);
  });
  it('finds untyped objects, but permits explicit guidance and empty argument lists', () => {
    expect(findings('UNTYPED_OBJECT', [tool({ data: { type: 'object', description: 'Data' } })])).toHaveLength(1);
    for (const additionalProperties of [true, false, { type: 'string' }]) {
      expect(findings('UNTYPED_OBJECT', [tool({ data: { type: 'object', additionalProperties } })])).toEqual([]);
    }
    expect(findings('UNTYPED_OBJECT', [tool()])).toEqual([]);
    expect(findings('UNTYPED_OBJECT', [tool({ data: { type: 'object', properties: { key: { type: 'string' } } } })])).toEqual([]);
  });
  it('finds ambiguous units and formats, but recognizes explicit schemas and descriptions', () => {
    for (const name of ['amount', 'price', 'cost', 'timeout', 'duration', 'delay', 'date', 'since', 'until', 'timestamp', 'time', 'size']) {
      expect(findings('AMBIGUOUS_UNIT_OR_FORMAT', [tool({ [name]: { type: 'string', description: 'Value' } })])).toHaveLength(1);
    }
    const properties = { timeout: { type: 'number', description: 'Wait in milliseconds' }, amount: { type: 'number', description: 'Amount in cents' },
      since: { type: 'string', description: 'Start time (ISO string)' }, date: { type: 'string', format: 'date' },
      timestamp: { type: 'string', enum: ['last_edited_time'] }, size: { type: 'number', description: 'Size in bytes' },
      'limit-bytes': { type: 'number' }, timeoutMs: { type: 'number' }, username: { type: 'string' },
      time: { type: 'string', description: 'The name of the timestamp to sort against' } };
    expect(findings('AMBIGUOUS_UNIT_OR_FORMAT', [tool(properties)])).toEqual([]);
  });
  it('finds explicit finite prose options without imposing enums on examples or conditional values', () => {
    for (const description of ['One of red, blue, green', "'x' or 'y'", 'Options: fast, slow', "Options are:\n- 'add' - add item.\n- 'remove' - remove item. Use either ID to locate the item."]) {
      expect(findings('MISSING_ENUM_CONSTRAINT', [tool({ mode: { type: 'string', description } })])).toHaveLength(1);
    }
    for (const description of ['Free text', 'Examples would be \'tomorrow\' or \'Friday\'', "Branch (e.g., 'main' or 'master')", 'Such as `a` or `b`',
      "If checkbox, use 'true' or 'false'. Otherwise free text.", 'Use one of filePath, content, or url.', "Cannot be combined with 'value' or 'delete'."]) {
      expect(findings('MISSING_ENUM_CONSTRAINT', [tool({ mode: { type: 'string', description } })])).toEqual([]);
    }
    expect(findings('MISSING_ENUM_CONSTRAINT', [tool({ mode: { type: 'string', description: 'One of a, b', enum: ['a', 'b'] } })])).toEqual([]);
  });
  it('compares normalized description token Jaccard at the threshold', () => {
    const left = tool({}, 'Read the project account settings');
    const right = { ...tool({}, 'Read project account settings.'), name: 'other' };
    expect(findings('OVERLAPPING_TOOL_DESCRIPTIONS', [left, right])).toHaveLength(1);
    expect(findings('OVERLAPPING_TOOL_DESCRIPTIONS', [left, { ...right, description: 'Delete remote database entries' }])).toEqual([]);
    expect(findings('OVERLAPPING_TOOL_DESCRIPTIONS', [tool({}, ''), { ...right, description: '' }])).toEqual([]);
    expect(lintTools([left, { ...right, description: 'Read project account details' }], 0.5).counts.OVERLAPPING_TOOL_DESCRIPTIONS).toBe(1);
    expect(() => lintTools([], 2)).toThrow('threshold');
  });
  it('walks arrays, compositions and referenced definitions, ignoring unused definitions and cycles', () => {
    const schema = tool({ list: { type: 'array', description: 'List', items: { anyOf: [{ $ref: '#/$defs/item' }] } } });
    schema.inputSchema.$defs = { item: { type: 'object', properties: { 'a/b': { type: 'string' }, cycle: { $ref: '#/$defs/item' } } }, unused: { type: 'object' } };
    const report = lintTools([schema]);
    expect(report.findings.some(f => f.path.endsWith('/properties/a~1b'))).toBe(true);
    expect(report.findings.some(f => f.path.includes('unused'))).toBe(false);
    expect(report.total_findings).toBe(report.findings.length);
    expect(report.findings_per_tool).toBe(report.findings.length);
    expect(report.per_tool[0]?.findings).toBe(report.findings.length);
    expect(lintTools([])).toMatchObject({ findings: [], total_findings: 0, findings_per_tool: 0 });
  });
});

it('CLI handles a manifest, an empty suite directory, JSON and invalid inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolcall-bench-lint-'));
  const cli = resolve('src/cli.ts');
  const tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', tsx, cli, 'lint', ...args], { cwd: directory });
  try {
    await mkdir(join(directory, 'suites'));
    const manifest = { tools: [tool()], serverInfo: { name: 'fixture', version: '1' }, protocolVersion: '2025-03-26', captured_at: '2026-01-01T00:00:00Z' };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(JSON.parse((await run('manifest.json', '--json')).stdout).tokens.tool_count).toBe(1);
    expect((await run('manifest.json')).stdout).toContain('Median tokens/tool:');
    expect(JSON.parse((await run('--all', '--json')).stdout)).toEqual([]);
    await expect(run()).rejects.toThrow('Provide a manifest');
    await expect(run('manifest.json', '--all')).rejects.toThrow('Provide a manifest');
    await writeFile(join(directory, 'invalid.json'), '{}');
    await expect(run('invalid.json')).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
