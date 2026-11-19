import type { ToolManifest } from '../types.js';

export const RULES = ['MISSING_DESCRIPTION', 'UNTYPED_OBJECT', 'AMBIGUOUS_UNIT_OR_FORMAT', 'MISSING_ENUM_CONSTRAINT', 'OVERLAPPING_TOOL_DESCRIPTIONS'] as const;
export type Rule = typeof RULES[number];
export type Finding = { rule: Rule; tool: string; path: string; message: string };
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);
const described = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const escapePointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

function ambiguous(name: string, schema: Schema): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('-', '_');
  if (!/^(amount|price|cost|timeout|duration|delay|date|since|until|timestamp|time|size|limit_bytes)$/.test(normalized)) return false;
  if (normalized === 'limit_bytes' || described(schema.format) || 'enum' in schema || 'const' in schema) return false;
  const description = typeof schema.description === 'string' ? schema.description.toLowerCase() : '';
  if (/\bname of (?:the )?timestamp\b/.test(description)) return false;
  const temporal = /\b(milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|ms|utc|unix|epoch|iso(?:[ -]?8601)?|rfc[ -]?3339|yyyy|hh:mm|date-time)\b/;
  const money = /\b(cents?|dollars?|usd|eur|gbp|currency|minor units?|major units?|decimal places?)\b/;
  const size = /\b(bytes?|kilobytes?|megabytes?|gigabytes?|kib|mib|gib|kb|mb|gb|pixels?|characters?|items?|entries|elements?|rows?|records?)\b/;
  return !( /^(amount|price|cost)$/.test(normalized) ? money : normalized === 'size' ? size : temporal).test(description);
}

function finiteOptions(description: string): boolean {
  if (/e\.g\.|\b(such as|including|etc|for example|examples?|if|cannot be combined|use one of)\b/i.test(description)) return false;
  const quoted = "(?:'[^'\\n]+'|\"[^\"\\n]+\"|`[^`\\n]+`)";
  if (new RegExp(`^\\s*(?:(?:must be|can be|value(?: is|:)?|mode(?: is|:)?)\\s+)?${quoted}\\s+or\\s+${quoted}[.!]?\\s*$`, 'i').test(description)) return true;
  const options = description.match(/\boptions(?: are)?\s*:\s*([\s\S]+)/i)?.[1];
  if (options && (options.match(/^\s*-\s*['"`][^'"`]+['"`]/gm) ?? []).length >= 2) return true;
  const list = description.match(/(?:\bone of\b|\boptions(?: are)?\s*:)\s+([^.!?]+)/i)?.[1];
  if (!list) return false;
  const parts = list.trim().split(/\s*,\s*|\s+(?:or|and)\s+/i).filter(Boolean);
  return parts.length >= 2 && parts.every(part => /^[`'"]?[\w-]+[`'"]?$/.test(part));
}

const stopwords = new Set('a an the to of for and or in on with by from this that is are be tool'.split(' '));
function tokens(description: string): Set<string> {
  return new Set((description.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => !stopwords.has(token)));
}

export function lintTools(tools: ToolManifest['tools'], threshold = 0.6) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Overlap threshold must be between 0 and 1');
  const findings: Finding[] = [];
  const add = (rule: Rule, tool: string, path: string, message: string) => findings.push({ rule, tool, path, message });
  for (const tool of tools) {
    const visitedRefs = new Set<string>();
    if (!described(tool.description)) add('MISSING_DESCRIPTION', tool.name, '/description', 'Tool has no description');
    const visit = (schema: unknown, path: string, param?: string) => {
      if (!object(schema)) return;
      if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/') && !visitedRefs.has(schema.$ref)) {
        visitedRefs.add(schema.$ref);
        let resolved: unknown = tool.inputSchema;
        for (const key of schema.$ref.slice(2).split('/')) resolved = object(resolved) ? resolved[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
        visit(resolved, `/inputSchema${schema.$ref.slice(1)}`, param);
      }
      if (param !== undefined) {
        const alternatives = ['$ref', 'oneOf', 'anyOf', 'allOf'].some(key => key in schema);
        if (!described(schema.description) && !alternatives) add('MISSING_DESCRIPTION', tool.name, path, 'Parameter has no description');
        if (ambiguous(param, schema)) add('AMBIGUOUS_UNIT_OR_FORMAT', tool.name, path, 'Parameter lacks an explicit unit or format');
        if (schema.type === 'string' && !('enum' in schema) && !('const' in schema) && described(schema.description) && finiteOptions(schema.description)) {
          add('MISSING_ENUM_CONSTRAINT', tool.name, path, 'Description lists finite options without an enum');
        }
      }
      if (schema.type === 'object' && (!object(schema.properties) || Object.keys(schema.properties).length === 0)
        && !('additionalProperties' in schema) && !('$ref' in schema) && !('patternProperties' in schema)
        && !['oneOf', 'anyOf', 'allOf'].some(key => key in schema)
        && !(path === '/inputSchema' && (!Array.isArray(schema.required) || schema.required.length === 0))) {
        add('UNTYPED_OBJECT', tool.name, path, 'Object has no properties or additionalProperties guidance');
      }
      if (object(schema.properties)) for (const [key, value] of Object.entries(schema.properties)) visit(value, `${path}/properties/${escapePointer(key)}`, key);
      for (const key of ['items', 'additionalProperties', 'patternProperties'] as const) {
        const value = schema[key];
        if (object(value)) {
          if (key === 'patternProperties') for (const [name, child] of Object.entries(value)) visit(child, `${path}/${key}/${escapePointer(name)}`);
          else visit(value, `${path}/${key}`);
        }
      }
      for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) if (Array.isArray(schema[key])) schema[key].forEach((child, index) => visit(child, `${path}/${key}/${index}`));
    };
    visit(tool.inputSchema, '/inputSchema');
  }
  const descriptions = tools.map(tool => tokens(tool.description ?? ''));
  for (let i = 0; i < tools.length; i++) for (let j = i + 1; j < tools.length; j++) {
    const left = descriptions[i]!, right = descriptions[j]!;
    if (left.size < 3 || right.size < 3) continue;
    const intersection = [...left].filter(token => right.has(token)).length;
    const score = intersection / new Set([...left, ...right]).size;
    if (score >= threshold) add('OVERLAPPING_TOOL_DESCRIPTIONS', tools[i]!.name, '/description', `Description overlaps ${tools[j]!.name} (Jaccard ${score.toFixed(3)})`);
  }
  const counts = Object.fromEntries(RULES.map(rule => [rule, findings.filter(finding => finding.rule === rule).length])) as Record<Rule, number>;
  return { findings, counts, total_findings: findings.length, findings_per_tool: tools.length ? findings.length / tools.length : 0,
    per_tool: tools.map(tool => ({ tool: tool.name, findings: findings.filter(finding => finding.tool === tool.name).length })) };
}
