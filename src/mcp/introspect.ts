import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { ToolManifest } from '../types.js';

export type SnapshotOptions = {
  cmd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export async function introspect(options: SnapshotOptions): Promise<ToolManifest> {
  if (Boolean(options.cmd) === Boolean(options.url)) throw new Error('Provide exactly one of --cmd or --url');
  const transport: Transport = options.cmd
    ? new StdioClientTransport({
      command: '/bin/sh', args: ['-c', `exec ${options.cmd}`],
      env: { ...getDefaultEnvironment(), ...options.env }, stderr: 'inherit',
    })
    : new StreamableHTTPClientTransport(new URL(options.url!), { requestInit: { headers: options.headers } });
  return captureTransport(transport, options.timeoutMs);
}

export async function captureTransport(transport: Transport, timeoutMs = 60_000): Promise<ToolManifest> {
  const client = new Client({ name: 'toolcall-bench', version: '1.0.0' });
  let protocolVersion: string | undefined;
  const setProtocolVersion = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version) => {
    protocolVersion = version;
    setProtocolVersion?.(version);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const tools: ToolManifest['tools'] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.request(
            { method: 'tools/list', params: cursor ? { cursor } : {} },
            z.object({ tools: ToolManifest.shape.tools, nextCursor: z.string().optional() }).passthrough(),
          );
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Repeated tools/list pagination cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        return ToolManifest.parse({ tools, serverInfo: client.getServerVersion(), protocolVersion, captured_at: new Date().toISOString() });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Snapshot timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}
