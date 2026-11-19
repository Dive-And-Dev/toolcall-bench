import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function updateComment(api, repository, number, marker, body) {
  let existing;
  for (let page = 1; ; page++) {
    const comments = await api(`/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
    existing = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker));
    if (existing || comments.length < 100) break;
  }
  return existing ? api(`/repos/${repository}/issues/comments/${existing.id}`, 'PATCH', { body })
    : api(`/repos/${repository}/issues/${number}/comments`, 'POST', { body });
}

async function main() {
  const env = process.env;
  if (!['anthropic', 'openai', 'gemini'].includes(env.BENCH_DRIVER)) throw new Error('Action requires a live driver; mock is never posted');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (!event.pull_request?.number) throw new Error('Comparison action requires a pull_request event');
  if (!env.GH_TOKEN) throw new Error('Missing GitHub token');
  const directory = await mkdtemp(join(env.RUNNER_TEMP, 'toolcall-bench-'));
  const suite = resolve(env.BENCH_SUITE);
  const cli = join(env.BENCH_ACTION_PATH, 'dist/cli.js');
  const run = args => {
    const output = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (output.error) throw output.error;
    if (output.status !== 0) throw new Error(output.stderr || `Harness exited ${output.status}`);
    return output.stdout;
  };
  const reports = [];
  for (const side of ['BASELINE', 'CANDIDATE']) {
    const path = join(directory, side.toLowerCase());
    await mkdir(path);
    await copyFile(join(suite, 'tasks.json'), join(path, 'tasks.json'));
    await copyFile(resolve(env[`BENCH_${side}_CONFIG`] || join(suite, 'config.json')), join(path, 'config.json'));
    await copyFile(resolve(env[`BENCH_${side}_MANIFEST`]), join(path, 'manifest.json'));
    const output = join(path, 'results');
    run(['run', '--suite', path, '--driver', env.BENCH_DRIVER, '--model', env.BENCH_MODEL, '--trials', env.BENCH_TRIALS, '--out', output]);
    const report = (await readdir(output)).find(file => file.endsWith('.json'));
    if (!report) throw new Error('Harness produced no report');
    reports.push(join(output, report));
  }
  const diff = run(['diff', ...reports]);
  const markdown = run(['diff', ...reports, '--markdown']);
  await writeFile(join(directory, 'diff.json'), diff);
  await writeFile(join(directory, 'diff.md'), markdown);
  const marker = `<!-- toolcall-bench:${createHash('sha256').update(`${env.BENCH_SUITE}:${env.BENCH_DRIVER}:${env.BENCH_MODEL}`).digest('hex').slice(0, 16)} -->`;
  const body = `${marker}\n## MCP tool-calling comparison\n\nCommit: ${event.pull_request.head.sha}\n\n${markdown}\n\nSingle-turn, within-suite comparison only. Inspect strict-schema compatibility findings before attributing failures to a model.`;
  if (body.length > 60000) throw new Error('Comparison comment exceeds safe GitHub size');
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
      method, headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!response.ok) throw new Error(`GitHub comment API HTTP ${response.status}`);
    return response.json();
  };
  await updateComment(api, env.GITHUB_REPOSITORY, event.pull_request.number, marker, body);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `results=${directory}\n`);
  if (env.BENCH_FAIL === 'true' && JSON.parse(diff).regression) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
