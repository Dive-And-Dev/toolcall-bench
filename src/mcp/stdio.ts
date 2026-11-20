import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const active = new Set<ProcessGroupStdioTransport>();
const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
let shuttingDown = false;
const handlers = Object.entries(exitCodes).map(([signal, code]) => ({ signal: signal as NodeJS.Signals, handle: () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([...active].map(transport => transport.close())).then(() => process.exit(code));
} }));

function register(transport: ProcessGroupStdioTransport) {
  if (!active.size) for (const { signal, handle } of handlers) process.on(signal, handle);
  active.add(transport);
}

function unregister(transport: ProcessGroupStdioTransport) {
  active.delete(transport);
  if (!active.size) for (const { signal, handle } of handlers) process.removeListener(signal, handle);
}

export class ProcessGroupStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private buffer = new ReadBuffer();

  constructor(private command: string, private env?: Record<string, string>) {}

  async start(): Promise<void> {
    if (this.child || this.closing) throw new Error('Transport already started or closed');
    if (shuttingDown) throw new Error('Process is shutting down');
    const child = this.child = spawn('/bin/sh', ['-c', this.command], {
      detached: true, stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...getDefaultEnvironment(), ...this.env },
    });
    register(this);
    this.exited = new Promise(resolve => child.once('close', () => { this.onclose?.(); resolve(); }));
    child.stdin?.on('error', error => this.onerror?.(error));
    child.stdout?.on('error', error => this.onerror?.(error));
    child.stdout?.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
        void this.close().catch(error => this.onerror?.(error));
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => { this.onerror?.(error); reject(error); });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || input.destroyed || this.closing) throw new Error('Not connected');
    await new Promise<void>((resolve, reject) => input.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    return this.closing ??= this.terminate().finally(() => unregister(this));
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, name); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        return false;
      }
    };
    try {
      if (signal('SIGTERM')) {
        await delay(250);
        signal('SIGKILL');
      }
    } finally {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.unref();
      this.buffer.clear();
    }
    await Promise.race([this.exited, delay(250)]);
  }
}
