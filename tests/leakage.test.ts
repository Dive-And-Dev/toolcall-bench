import { describe, expect, it } from 'vitest';
import { lintLeakage, splitIdentifier } from '../src/analyzer/leakage.js';
import type { EvalTask, ToolManifest } from '../src/types.js';

const tools: ToolManifest['tools'] = ['browser_navigate', 'otherAction', 'fetch'].map(name => ({ name, inputSchema: { type: 'object' } }));
const task = (prompt: string): EvalTask => ({ id: 'one', server_name: 'test', prompt, expected_tools: ['otherAction'], semantic_assertions: [{ path: '', exists: true }], rationale: 'fixture', tags: ['everyday'] });
describe('tool identifier leakage', () => {
  it.each(['browser_navigate', 'browserNavigate', 'browser-navigate', 'browser navigate', 'BROWSER NAVIGATE', 'browsernavigate'])('detects %s even for an unexpected tool', prompt => {
    expect(lintLeakage([task(prompt)], tools)[0]?.tool).toBe('browser_navigate');
  });
  it.each(['`fetch`', 'fetch(', 'fetch (', 'fetch tool'])('detects identifier-looking single token %s', prompt => {
    expect(lintLeakage([task(prompt)], tools)[0]?.tool).toBe('fetch');
  });
  it('permits ordinary English and respects boundaries', () => {
    expect(lintLeakage([task('Please fetch this page. Anotherbrowsernavigate is not an identifier. fetchable tools.')], tools)).toEqual([]);
    expect(lintLeakage([], tools)).toEqual([]);
    expect(lintLeakage([task('Open this website')], [])).toEqual([]);
  });
  it('splits acronyms and camelCase identifiers', () => {
    expect(splitIdentifier('API-getUser')).toEqual(['API', 'get', 'User']);
    expect(lintLeakage([task('other action')], tools)).toHaveLength(1);
    expect(lintLeakage([task('file.read')], [{ name: 'file.read', inputSchema: { type: 'object' } }])).toHaveLength(1);
  });
});
