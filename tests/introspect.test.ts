import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { captureTransport, introspect } from '../src/mcp/introspect.js';
import { parsePairs } from '../src/cli.js';

describe('snapshots', () => {
  it.each(['timeout', 'error', 'success', 'cli-timeout'])('kills the shell, stubborn server and grandchild on %s', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'bench-stubborn-'));
    const pidFile = join(directory, 'pids.json');
    let pids: number[] = [];
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
  resolve();
}));
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  await ready;
  if (request.method === 'tools/list' && process.env.MODE.endsWith('timeout')) return;
  const response = request.method === 'tools/list' && process.env.MODE === 'error'
    ? { error: { code: -32603, message: 'catalog unavailable' } }
    : { result: request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1' } }
      : { tools: [] } };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }));
});`);
      const cmd = `"${process.execPath}" "${script}"; :`;
      const started = Date.now();
      if (mode === 'cli-timeout') {
        await expect(promisify(execFile)(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli.ts'),
          'snapshot', '--cmd', cmd, '--env', `PID_FILE=${pidFile}`, '--env', `MODE=${mode}`, '--timeout', '500', '--out', join(directory, 'manifest.json')],
        { timeout: 2500 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Snapshot timed out') });
      } else {
        const capture = introspect({ cmd, env: { PID_FILE: pidFile, MODE: mode }, timeoutMs: 500 });
        if (mode === 'success') expect((await capture).tools).toEqual([]);
        else await expect(capture).rejects.toThrow(mode === 'error' ? 'catalog unavailable' : 'Snapshot timed out');
      }
      expect(Date.now() - started).toBeLessThan(2500);
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
      if (!pids.length) {
        try { pids = JSON.parse(await readFile(pidFile, 'utf8')); } catch {}
      }
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
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
