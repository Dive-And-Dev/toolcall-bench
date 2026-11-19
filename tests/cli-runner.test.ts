import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './runner-fixture.js';

it('enforces mock opt-in, writes runs, exits on regression and rejects task leakage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-cli-'));
  const cli = resolve('src/cli.ts'), tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', tsx, cli, ...args], { cwd: directory, env: { ...process.env, CI: 'false' } });
  try {
    const suite = fixture();
    await Promise.all([['config.json', suite.config], ['manifest.json', suite.manifest], ['tasks.json', suite.tasks]].map(([file, value]) => writeFile(join(directory, String(file)), JSON.stringify(value))));
    await expect(run('run', '--suite', directory, '--driver', 'mock')).rejects.toThrow('requires --ci');
    const baseArgs = ['run', '--suite', directory, '--driver', 'mock', '--ci', '--trials', '1', '--invalid-arguments-probability', '0'];
    await run(...baseArgs, '--selection-probability', '1', '--model', 'base');
    await run(...baseArgs, '--selection-probability', '0', '--model', 'candidate', '--seed', '43');
    const baseline = join(directory, 'results/fixture.mock.base.json');
    const candidate = join(directory, 'results/fixture.mock.candidate.json');
    expect(JSON.parse(await readFile(baseline, 'utf8')).results).toHaveLength(10);
    expect((await run('diff', baseline, candidate, '--markdown')).stdout).toContain('regression');
    await expect(run('diff', baseline, candidate, '--fail-on-regression')).rejects.toMatchObject({ code: 1 });
    await run('lint-tasks', directory);
    suite.tasks[0]!.prompt = 'Use waitMs for this request';
    await writeFile(join(directory, 'tasks.json'), JSON.stringify(suite.tasks));
    await expect(run('lint-tasks', directory)).rejects.toMatchObject({ code: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
