import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { meetingsDir } from './paths.js';
import {
  getLatestMeeting,
  getMeeting,
  listMeetings,
  meetingToText,
  searchMeetings,
  type MeetingRecord,
} from './meetings.js';

const TOOLS = [
  {
    name: 'list_transcripts',
    description: 'List meetings saved under ~/ScribeTab/meetings/',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_transcript',
    description: 'Get a meeting transcript by directory name or session id',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Directory name or session UUID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_latest_transcript',
    description: 'Get the most recently started meeting transcript',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'search_transcripts',
    description: 'Case-insensitive substring search over transcript text and titles',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'export_transcript',
    description: 'Return a meeting file (markdown or json) by directory name or session id',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['md', 'json'] },
      },
      required: ['id'],
    },
  },
];

function textResult(text: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text }], isError };
}

function listSummary(m: MeetingRecord): Record<string, unknown> {
  return {
    dir: m.dirName,
    id: m.session?.id,
    title: m.session?.title,
    startedAt: m.session?.startedAt,
    hasAudio: m.hasAudio,
    path: m.path,
  };
}

export function createMcpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const server = new Server({ name: 'scribetab', version: '0.0.1' }, { capabilities: { tools: {} } });
  const root = () => meetingsDir(env);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'list_transcripts': {
          const all = await listMeetings(root());
          return textResult(JSON.stringify(all.map(listSummary), null, 2));
        }
        case 'get_transcript': {
          const id = typeof args.id === 'string' ? args.id : '';
          if (!id) return textResult('id is required', true);
          const m = await getMeeting(root(), id);
          if (!m) return textResult('No meeting found for id', true);
          return textResult(meetingToText(m));
        }
        case 'get_latest_transcript': {
          const m = await getLatestMeeting(root());
          if (!m) return textResult('No meetings saved yet', true);
          return textResult(meetingToText(m));
        }
        case 'search_transcripts': {
          if (typeof args.query !== 'string' || !args.query.trim()) {
            return textResult('query is required', true);
          }
          const hits = await searchMeetings(root(), args.query);
          return textResult(JSON.stringify(hits.map(listSummary), null, 2));
        }
        case 'export_transcript': {
          const id = typeof args.id === 'string' ? args.id : '';
          if (!id) return textResult('id is required', true);
          const format = args.format === undefined ? 'md' : args.format;
          if (format !== 'md' && format !== 'json') {
            return textResult('format must be md or json', true);
          }
          const m = await getMeeting(root(), id);
          if (!m) return textResult('No meeting found for id', true);
          if (format === 'json') {
            return textResult(JSON.stringify({ session: m.session, segments: m.segments }, null, 2));
          }
          return textResult(m.transcriptMd);
        }
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  });

  return server;
}

const HELP = `scribetab-mcp — MCP stdio server for ~/ScribeTab/meetings/

Tools: list_transcripts, get_transcript, get_latest_transcript,
       search_transcripts, export_transcript

Usage:
  scribetab-mcp          Run MCP over stdio
  scribetab-mcp --help
`;

export async function runMcpCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const cmd = args[0];
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
