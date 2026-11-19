import { getEncoding } from 'js-tiktoken';
import type { ToolManifest } from '../types.js';

const encoding = getEncoding('o200k_base');
const countTokens = (value: unknown) => encoding.encode(JSON.stringify(value), [], []).length;
export function analyzeTokens(tools: ToolManifest['tools']) {
  const schemas = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const per_tool = schemas.map(tool => ({ tool: tool.name, tokens: countTokens(tool) }));
  const sorted = per_tool.map(tool => tool.tokens).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    encoding: 'o200k_base',
    catalog_tokens: countTokens(schemas),
    tool_count: tools.length,
    median_tokens_per_tool: sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) : 0,
    per_tool,
  };
}
