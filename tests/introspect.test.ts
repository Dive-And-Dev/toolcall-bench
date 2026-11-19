import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { captureTransport, introspect } from '../src/mcp/introspect.js';
import { parsePairs } from '../src/cli.js';

describe('snapshots', () => {
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
