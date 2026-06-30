import { describe, expect, it } from '@jest/globals';
import type { AxiosInstance } from 'axios';

import { buildMcpServer } from '../mcp.js';
import { PerceptionEngine } from '../PerceptionEngine.js';
import { SourceStore } from '../SourceStore.js';

type RegisteredTool = {
  handler: (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function tool(server: unknown, name: string): RegisteredTool {
  return (server as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[name]!;
}

function textJson(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('Manager MCP canonical tools', () => {
  it('maps re.read_state to RE /api/state and pe.read_state to in-process PE state', async () => {
    const engine = new PerceptionEngine(4);
    const getCalls: string[] = [];
    const httpClient = {
      get: async (url: string) => {
        getCalls.push(url);
        return { data: { service: 're', url } };
      },
    } as unknown as AxiosInstance;

    const server = buildMcpServer({
      engine,
      store: new SourceStore('/tmp/re-mcp-canonical-tools'),
      push: async () => ({ success: true, timestamp: 1, globalStep: 0 }),
      startAuto: () => undefined,
      stopAuto: () => undefined,
      getAutoState: () => ({ running: false, intervalMs: 1000 }),
      getLastPush: () => null,
      saveAndBroadcast: async () => undefined,
      resetAndBroadcast: () => undefined,
      realityEngineUrl: 'http://re.test',
      httpClient,
    });

    const reState = await tool(server, 're.read_state').handler({});
    const peState = await tool(server, 'pe.read_state').handler({});

    expect(textJson(reState)).toEqual({ service: 're', url: 'http://re.test/api/state' });
    expect(getCalls).toEqual(['http://re.test/api/state']);
    expect((textJson(peState) as any).vectorSize).toBe(4);
  });

  it('maps re.read_machine to RE /api/machines/{id}', async () => {
    const getCalls: string[] = [];
    const httpClient = {
      get: async (url: string) => {
        getCalls.push(url);
        return { data: { id: 'machine/a' } };
      },
    } as unknown as AxiosInstance;

    const server = buildMcpServer({
      engine: new PerceptionEngine(4),
      store: new SourceStore('/tmp/re-mcp-canonical-tools'),
      push: async () => ({ success: true, timestamp: 1, globalStep: 0 }),
      startAuto: () => undefined,
      stopAuto: () => undefined,
      getAutoState: () => ({ running: false, intervalMs: 1000 }),
      getLastPush: () => null,
      saveAndBroadcast: async () => undefined,
      resetAndBroadcast: () => undefined,
      realityEngineUrl: 'http://re.test',
      httpClient,
    });

    const result = await tool(server, 're.read_machine').handler({ machine_id: 'machine/a' });

    expect(textJson(result)).toEqual({ id: 'machine/a' });
    expect(getCalls).toEqual(['http://re.test/api/machines/machine%2Fa']);
  });
});
