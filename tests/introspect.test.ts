import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { captureTransport, introspect } from '../src/mcp/introspect.js';
import { ProcessGroupStdioTransport } from '../src/mcp/stdio.js';
import { parsePairs } from '../src/cli.js';

describe('snapshots', () => {
  it.each(['timeout', 'error', 'success', 'cli-timeout', 'cli-SIGINT', 'cli-SIGTERM', 'cli-SIGHUP'])('kills the shell, stubborn server and grandchild on %s', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'bench-stubborn-'));
    const pidFile = join(directory, 'pids.json');
    let pids: number[] = [];
    let cli: ChildProcess | undefined;
    try {
      const script = join(directory, 'server.mjs');
      await writeFile(script, `import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const pidFile = process.env.PID_FILE;
process.on('SIGTERM', () => writeFileSync(pidFile + '.' + process.pid + '.term', 'received'));
setInterval(() => {}, 1000);
const worker = spawn(process.execPath, ['-e', \`const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => writeFileSync(process.env.PID_FILE + '.' + process.pid + '.term', 'received'));
setInterval(() => {}, 1000);
process.send('ready');\`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const ready = new Promise(resolve => worker.once('message', () => {
  writeFileSync(pidFile, JSON.stringify([process.ppid, process.pid, worker.pid]));
  writeFileSync(pidFile + '.ready', String(Date.now()));
  resolve();
}));
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  await ready;
  if (request.method === 'tools/list' && (process.env.MODE.endsWith('timeout') || process.env.MODE.startsWith('cli-'))) return;
  const response = request.method === 'tools/list' && process.env.MODE === 'error'
    ? { error: { code: -32603, message: 'catalog unavailable' } }
    : { result: request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1' } }
      : { tools: [] } };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }));
});`);
      const cmd = `"${process.execPath}" "${script}"; :`;
      const started = Date.now();
      if (mode.startsWith('cli-')) {
        const execution = promisify(execFile)(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli.ts'),
          'snapshot', '--cmd', cmd, '--env', `PID_FILE=${pidFile}`, '--env', `MODE=${mode}`, '--timeout', mode === 'cli-timeout' ? '500' : '60000', '--out', join(directory, 'manifest.json')],
        { timeout: 10_000 });
        cli = execution.child;
        const outcome = execution.catch(error => error);
        if (mode === 'cli-timeout') {
          expect(await outcome).toMatchObject({ code: 1, stderr: expect.stringContaining('Snapshot timed out') });
        } else {
          await expect.poll(async () => {
            try { await readFile(`${pidFile}.ready`); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
          }, { timeout: 8000, interval: 20 }).toBe(true);
          const signal = mode.slice(4) as 'SIGINT' | 'SIGTERM' | 'SIGHUP';
          expect(cli.kill(signal)).toBe(true);
          expect(await outcome).toMatchObject({ code: { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal], signal: null });
        }
      } else {
        const capture = introspect({ cmd, env: { PID_FILE: pidFile, MODE: mode }, timeoutMs: 500 });
        if (mode === 'success') expect((await capture).tools).toEqual([]);
        else await expect(capture).rejects.toThrow(mode === 'error' ? 'catalog unavailable' : 'Snapshot timed out');
      }
      const snapshotStarted = mode.startsWith('cli-') ? Number(await readFile(`${pidFile}.ready`, 'utf8')) : started;
      expect(Date.now() - snapshotStarted).toBeLessThan(2500);
      pids = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(pids).toHaveLength(3);
      for (const pid of pids.slice(1)) expect(await readFile(`${pidFile}.${pid}.term`, 'utf8')).toBe('received');
      await expect.poll(() => pids.every(pid => {
        try { process.kill(pid, 0); return false; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return true;
        }
      }), { timeout: 1000, interval: 10 }).toBe(true);
    } finally {
      if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      if (!pids.length) {
        try { pids = JSON.parse(await readFile(pidFile, 'utf8')); } catch {}
      }
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
  it('shares signal handlers across active transports and removes only those handlers after the final close', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map(signal => process.listeners(signal));
    const transports = [0, 1].map(() => new ProcessGroupStdioTransport(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`));
    const expectHandlers = (extra: number) => signals.forEach((signal, index) => {
      expect(process.listenerCount(signal)).toBe(before[index]!.length + extra);
      for (const handler of before[index]!) expect(process.listeners(signal)).toContain(handler);
    });
    try {
      await Promise.all(transports.map(transport => transport.start()));
      expectHandlers(1);
      await transports[0]!.close();
      expectHandlers(1);
      await transports[1]!.close();
      expectHandlers(0);
    } finally { await Promise.all(transports.map(transport => transport.close())); }
  });
  it.each(['compound', 'assignment'])('supports %s shell commands while preserving environment overrides', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'bench-shell-'));
    try {
      const script = join(directory, 'server.mjs');
      await writeFile(script, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: process.env.LOCAL_VALUE, version: process.env.EXTRA_VALUE } }
    : { tools: [] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});`);
      const cmd = mode === 'compound'
        ? `cd "${directory}" && LOCAL_VALUE=from-shell "${process.execPath}" server.mjs`
        : `LOCAL_VALUE=from-shell "${process.execPath}" "${script}"`;
      const manifest = await introspect({ cmd, env: { EXTRA_VALUE: 'from-env' }, timeoutMs: 5000 });
      expect(manifest.serverInfo).toEqual({ name: 'from-shell', version: 'from-env' });
      expect(manifest.tools).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('propagates shell command failures', async () => {
    await expect(introspect({ cmd: 'exit 7', timeoutMs: 1000 })).rejects.toThrow();
  });
  it('captures over Streamable HTTP with custom headers', async () => {
    const headers: Array<string | undefined> = [];
    const http = createServer(async (request, response) => {
      headers.push(request.headers.authorization);
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let body = '';
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } }
        : { tools: [] };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    try {
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('No HTTP port');
      const result = await introspect({ url: `http://127.0.0.1:${address.port}`, headers: { Authorization: 'Bearer dummy' } });
      expect(result.tools).toEqual([]);
      expect(result.serverInfo.name).toBe('http');
      expect(headers.length).toBeGreaterThanOrEqual(3);
      expect(headers.every(header => header === 'Bearer dummy')).toBe(true);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    }
  });
  it('preserves tools, extensions and pagination with negotiated metadata', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'fixture', version: '1.2.3' }, { capabilities: { tools: {} } });
    const tool = { name: 'example', inputSchema: { type: 'object' as const, properties: {} }, custom: { preserved: true } };
    server.setRequestHandler(ListToolsRequestSchema, async request => request.params?.cursor
      ? { tools: [{ ...tool, name: 'second' }] }
      : { tools: [tool], nextCursor: 'page2' });
    await server.connect(serverTransport);
    const manifest = await captureTransport(clientTransport);
    expect(manifest.tools).toEqual([tool, { ...tool, name: 'second' }]);
    expect(manifest.serverInfo).toEqual({ name: 'fixture', version: '1.2.3' });
    expect(manifest.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(manifest.captured_at))).toBe(false);
  });

  it('captures an empty catalog', async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'empty', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await server.connect(transport);
    expect((await captureTransport(client)).tools).toEqual([]);
  });

  it('propagates tools/list errors and closes', async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'error', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => { throw new Error('catalog unavailable'); });
    await server.connect(transport);
    await expect(captureTransport(client)).rejects.toThrow('catalog unavailable');
  });

  it('times out a silent transport', async () => {
    await expect(captureTransport({ start: async () => {}, send: async () => {}, close: async () => {} }, 10)).rejects.toThrow('timed out');
  });

  it('requires exactly one connection target', async () => {
    await expect(introspect({})).rejects.toThrow('exactly one');
    await expect(introspect({ cmd: 'true', url: 'https://example.com' })).rejects.toThrow('exactly one');
  });

  it('parses repeatable assignments and headers', () => {
    expect(parsePairs(['K=a=b'], '=')).toEqual({ K: 'a=b' });
    expect(parsePairs(['Authorization: Bearer dummy'], ':')).toEqual({ Authorization: 'Bearer dummy' });
    expect(parsePairs([], '=')).toEqual({});
    expect(() => parsePairs(['invalid'], '=')).toThrow('Expected');
  });
});
