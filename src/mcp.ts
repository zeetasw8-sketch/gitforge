// MCP surface (Streamable HTTP, JSON-RPC 2.0) at POST /mcp.
//
// Two protocol eras, both answered:
//   modern  2026-07-28: `server/discover` returns identity + supportedVersions;
//           every request declares its revision in `_meta`.
//   legacy  2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// The suite's client (mcp-client.ts) probes server/discover first and falls
// back to the handshake when it answers -32601. Plain JSON replies are
// accepted by the client (no SSE needed). No protocol-level session is issued.

import { createRepo, getRepo, squashMerge, VIEWER } from './store.ts';
import type { Repo, Store } from './store.ts';
import { createIssueRecord, createPullRecord, issueJson, prJson, repoJson } from './rest.ts';
import type { RestContext } from './rest.ts';

const SERVER_NAME = 'gitforge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PREFERRED_REVISION = '2026-07-28';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): McpToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, schema] of Object.entries(properties)) props[key] = schema;
  return { name, description, inputSchema: { type: 'object', properties: props, required, additionalProperties: true } };
}

const S = (description: string): { type: string; description: string } => ({ type: 'string', description });
const B = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const I = (description: string): { type: string; description: string } => ({ type: 'integer', description });

// The six required tools (canonical github-mcp-server names). The array is a
// module-level constant, so two tools/list calls are byte-identical.
const TOOLS: McpToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the viewer.', {
    owner: S('Login of the repository owner (defaults to the viewer).'),
    name: S('Name of the repository to create.'),
    description: S('A short description of the repository.'),
    private: B('Whether the repository is private.'),
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: S('Login of the repository owner.'),
    repo: S('Name of the repository.'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: S('Login of the repository owner.'),
    repo: S('Name of the repository.'),
    title: S('Title of the issue.'),
    body: S('Body of the issue.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: S('Login of the repository owner.'),
    repo: S('Name of the repository.'),
    state: S('Issue state filter: open, closed, or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: S('Login of the repository owner.'),
    repo: S('Name of the repository.'),
    title: S('Title of the pull request.'),
    body: S('Body of the pull request.'),
    head: S('Name of the head branch.'),
    base: S('Name of the base branch.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash merge.', {
    owner: S('Login of the repository owner.'),
    repo: S('Name of the repository.'),
    pull_number: I('Number of the pull request to merge.'),
  }, ['owner', 'repo', 'pull_number']),
];

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

function numArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/** The reply shape the app layer sends back to the HTTP client. */
export interface McpReply {
  status: number;
  body: unknown;
  /** True when the request was a notification (no id): answer with an empty 202. */
  notification?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolText(payload: unknown): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function missingArgs(toolDef: McpToolDef, args: Record<string, unknown>): string[] {
  return toolDef.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

function resolveRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  const owner = strArg(args, 'owner') || VIEWER.login;
  const name = strArg(args, 'repo') || strArg(args, 'name');
  if (name === '') return { error: 'repo is required' };
  const repo = getRepo(store, owner, name);
  if (repo === undefined) return { error: `Repository ${owner}/${name} not found` };
  return { repo };
}

/** Execute one tool call. Errors are tool errors (isError:true), never throws. */
function callTool(ctx: RestContext, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError: boolean } {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) return toolError(`Unknown tool: ${name}`);
  const missing = missingArgs(def, args);
  if (missing.length > 0) return toolError(`Missing required arguments: ${missing.join(', ')}`);
  const store = ctx.store;

  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      const owner = strArg(args, 'owner') || VIEWER.login;
      if (owner !== VIEWER.login) return toolError(`Cannot create a repository for ${owner}`);
      if (getRepo(store, owner, repoName) !== undefined) return toolError(`Repository ${owner}/${repoName} already exists`);
      const repo = createRepo(store, { name: repoName, description: strArg(args, 'description'), private: boolArg(args, 'private') });
      return toolText(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const found = resolveRepo(store, args);
      if ('error' in found) return toolError(found.error);
      return toolText(repoJson(ctx, found.repo));
    }
    case 'create_issue': {
      const found = resolveRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const title = strArg(args, 'title');
      const created = createIssueRecord(ctx, found.repo, title, strArg(args, 'body'), []);
      if ('error' in created) return toolError(created.error);
      return toolText(issueJson(ctx, found.repo, created.issue));
    }
    case 'list_issues': {
      const found = resolveRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const state = strArg(args, 'state') || 'open';
      const list = state === 'all' ? found.repo.issues : found.repo.issues.filter((i) => i.state === state);
      return toolText(list.map((i) => issueJson(ctx, found.repo, i)));
    }
    case 'create_pull_request': {
      const found = resolveRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const created = createPullRecord(ctx, found.repo, strArg(args, 'title'), strArg(args, 'body'), strArg(args, 'head'), strArg(args, 'base') || found.repo.default_branch);
      if ('error' in created) return toolError(created.error);
      return toolText(prJson(ctx, found.repo, created.pr));
    }
    case 'merge_pull_request': {
      const found = resolveRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const number = numArg(args, 'pull_number');
      if (number === null) return toolError('pull_number must be an integer');
      const pr = found.repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return toolError(`Pull request #${number} not found`);
      if (pr.merged || pr.state === 'closed') return toolError('Pull request is already merged or closed');
      const result = squashMerge(store, found.repo, pr);
      if (!result.ok) return toolError('Merge conflict');
      return toolText({ merged: true, sha: result.sha, number: pr.number, state: pr.state });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one decoded JSON-RPC request object at POST /mcp.
 * `body` is the already-parsed JSON value (the app layer answers -32700 for
 * unparseable bodies before calling this).
 */
export function handleMcp(ctx: RestContext, body: unknown): McpReply {
  if (!isRecord(body)) return rpcError(null, -32600, 'Invalid Request', 400);
  const id = 'id' in body ? (body.id as JsonValue) : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and expect no JSON-RPC reply.
  if (id === undefined) {
    return { status: 202, body: '', notification: true };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        supportedVersions: [...SUPPORTED_REVISIONS],
        protocolVersion: PREFERRED_REVISION,
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (toolName === '') return rpcError(id, -32602, 'Invalid params: tool name is required');
      if (TOOLS.find((t) => t.name === toolName) === undefined) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      return rpcResult(id, callTool(ctx, toolName, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
