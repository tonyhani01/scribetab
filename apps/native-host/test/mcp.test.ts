import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_JS, rmrf, tempHome } from './helpers.js';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('MCP stdio server', () => {
  let home: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = undefined;
    }
    if (home) {
      await rmrf(home);
      home = undefined;
    }
  });

  it('lists and fetches a transcript from ~/ScribeTab/meetings', async () => {
    home = await tempHome();
    const dir = join(home, 'ScribeTab', 'meetings', '2026-08-27-mcp-demo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'transcript.md'),
      '# MCP Demo\n\n[0:00] hello from disk\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'transcript.json'),
      JSON.stringify({
        session: {
          id: 'mcp-session-1',
          title: 'MCP Demo',
          startedAt: '2026-08-27T09:00:00.000Z',
          platform: 'other',
          status: 'complete',
        },
        segments: [
          {
            id: 's',
            sessionId: 'mcp-session-1',
            startMs: 0,
            endMs: 500,
            text: 'hello from disk',
            source: 'audio',
          },
        ],
      }),
      'utf8',
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_JS],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    client = new Client({ name: 'scribetab-test', version: '0.0.1' });
    await client.connect(transport);

    const listed = await client.callTool({ name: 'list_transcripts', arguments: {} });
    const listText = textOf(listed as { content: Array<{ type: string; text?: string }> });
    expect(listText).toContain('2026-08-27-mcp-demo');
    expect(listText).toContain('mcp-session-1');

    const got = await client.callTool({
      name: 'get_transcript',
      arguments: { id: 'mcp-session-1' },
    });
    const body = textOf(got as { content: Array<{ type: string; text?: string }> });
    expect(body).toContain('hello from disk');
    expect(body).toContain('MCP Demo');

    const noQuery = await client.callTool({ name: 'search_transcripts', arguments: {} });
    expect((noQuery as { isError?: boolean }).isError).toBe(true);
    expect(textOf(noQuery as { content: Array<{ type: string; text?: string }> })).toMatch(/query is required/);

    const badFmt = await client.callTool({
      name: 'export_transcript',
      arguments: { id: 'mcp-session-1', format: 'docx' },
    });
    expect((badFmt as { isError?: boolean }).isError).toBe(true);
    expect(textOf(badFmt as { content: Array<{ type: string; text?: string }> })).toMatch(/format must be md or json/);
  });
});
