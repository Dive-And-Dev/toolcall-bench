import { expect, it } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { analyzeTokens } from '../src/analyzer/tokens.js';

it('counts the full serialized catalog and individual schemas with o200k_base', () => {
  const tools = [
    { name: 'hello', description: 'Say hello 👋 世界', inputSchema: { type: 'object' as const, properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'longer', description: 'A considerably longer description with more words.', inputSchema: { type: 'object' as const } },
  ];
  const encoding = getEncoding('o200k_base');
  const schemas = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const sizes = schemas.map(tool => encoding.encode(JSON.stringify(tool)).length);
  expect(analyzeTokens(tools)).toEqual({ encoding: 'o200k_base', catalog_tokens: encoding.encode(JSON.stringify(schemas)).length,
    tool_count: 2, median_tokens_per_tool: (sizes[0]! + sizes[1]!) / 2,
    per_tool: schemas.map((tool, i) => ({ tool: tool.name, tokens: sizes[i] })) });
  expect(analyzeTokens([tools[0]!]).median_tokens_per_tool).toBe(sizes[0]);
});

it('handles an empty catalog and absent descriptions deterministically', () => {
  expect(analyzeTokens([])).toMatchObject({ tool_count: 0, median_tokens_per_tool: 0, per_tool: [] });
  expect(analyzeTokens([]).catalog_tokens).toBe(getEncoding('o200k_base').encode('[]').length);
  const tools = [{ name: 'bare', inputSchema: { type: 'object' as const } }];
  expect(analyzeTokens(tools)).toEqual(analyzeTokens(tools));
});

it('treats special-token-looking text as literal schema text', () => {
  const tools = [{ name: 'literal', description: '<|endoftext|>', inputSchema: { type: 'object' as const } }];
  expect(analyzeTokens(tools).catalog_tokens).toBe(getEncoding('o200k_base').encode(JSON.stringify(tools), [], []).length);
});
