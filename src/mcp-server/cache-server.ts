// Standalone MCP stdio server — bundled separately to dist/cache-server.js and
// launched by AI tools as `node cache-server.js <workspaceRoot>`. Never imports
// vscode. stdout carries only newline-delimited JSON-RPC 2.0; logs go to stderr.
import * as readline from 'readline';
import { SemanticCacheStore, CacheScope } from '../cache/store';
import { CallLogStore } from '../cache/callLog';

const SERVER_NAME = 'token-cache';
const SERVER_VERSION = '0.1.1';
const PROTOCOL_VERSION = '2024-11-05';

const workspaceRoot = process.argv[2] || process.cwd();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  {
    name: 'cache_lookup',
    description:
      'Look up a previously cached answer for a question about this workspace. ' +
      'Call this BEFORE answering a question that may have been answered before. ' +
      'Returns { hit, answer, exact, similarity, stale, storedAt }. If hit is true and ' +
      'stale is false, reuse the answer instead of regenerating it. A stale hit means ' +
      'the code has changed since the answer was stored — verify before reusing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to look up' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cache_store',
    description:
      'Store a reusable, self-contained answer in the local semantic cache so repeated ' +
      'or similar questions can be served without regenerating. Use scope "durable" for ' +
      'answers independent of current code state (concepts, how-tos), "code" (default) for ' +
      'answers about this codebase. Do NOT store answers about uncommitted or actively changing code.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question being answered' },
        answer: { type: 'string', description: 'The full answer text to cache' },
        scope: { type: 'string', enum: ['code', 'durable'], description: 'Staleness scope (default: code)' },
      },
      required: ['query', 'answer'],
    },
  },
  {
    name: 'cache_stats',
    description: 'Report semantic cache statistics: entry count, total hits, estimated tokens saved.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// New store per call: re-reads the file from disk so this process stays
// coherent with the extension (e.g. after a clearCache command).
function callTool(name: string, args: Record<string, unknown>): unknown {
  const store = new SemanticCacheStore(workspaceRoot);
  const callLog = new CallLogStore(workspaceRoot);
  switch (name) {
    case 'cache_lookup': {
      if (typeof args.query !== 'string' || args.query.length === 0) {
        throw new Error('cache_lookup requires a non-empty "query" string');
      }
      const result = store.lookup(args.query);
      callLog.recordLookup(result);
      return result;
    }
    case 'cache_store': {
      if (typeof args.query !== 'string' || typeof args.answer !== 'string') {
        throw new Error('cache_store requires "query" and "answer" strings');
      }
      const scope: CacheScope = args.scope === 'durable' ? 'durable' : 'code';
      const entry = store.store(args.query, args.answer, scope);
      callLog.recordStore();
      return { stored: true, id: entry.id, scope: entry.scope };
    }
    case 'cache_stats':
      return store.stats();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function handleRequest(request: JsonRpcRequest): unknown | undefined {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOL_DEFINITIONS };
    case 'tools/call': {
      const params = request.params || {};
      const name = params.name as string;
      const args = (params.arguments as Record<string, unknown>) || {};
      try {
        const result = callTool(name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
    default:
      throw { code: -32601, message: `Method not found: ${request.method}` };
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) { return; }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // Notifications (no id) get no response.
  if (request.id === undefined || request.id === null) {
    return;
  }

  try {
    const result = handleRequest(request);
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (err) {
    const rpcError = err as { code?: number; message?: string };
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: typeof rpcError.code === 'number' ? rpcError.code : -32603,
        message: rpcError.message || 'Internal error',
      },
    });
  }
});

rl.on('close', () => process.exit(0));

process.stderr.write(`[${SERVER_NAME}] serving semantic cache for ${workspaceRoot}\n`);
