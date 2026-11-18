// HTTP server: routes every surface the suite speaks to.
//   GET  /healthz                       -> {"ok":true} (no auth)
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//   /api/v3/*                           -> REST (Bearer MAKEFUN_SHOP_TOKEN when set)
//   POST /api/graphql                  -> GraphQL v4 (same auth)
//   POST /mcp                          -> MCP Streamable HTTP (same auth)
//   anything else                      -> 404 {"message":"Not Found"}
// Every JSON reply carries X-GitHub-Request-Id: req-<n>. Git routes carry no
// auth: the git client sends the token, the suite never enforces it there.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createStore, getRepo, VIEWER } from './src/store.ts';
import type { Store } from './src/store.ts';
import { routeRest } from './src/rest.ts';
import type { RestContext } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { infoRefs, receivePack, uploadPack } from './src/git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store: Store = createStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const requestSeq = { n: 0 };
  const baseCtx: RestContext = { store, token, host: 'localhost', requestSeq };

  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `req-${++requestSeq.n}`;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const host = req.headers.host ?? 'localhost';
        const ctx: RestContext = { ...baseCtx, host };
        const authHeader = req.headers.authorization ?? '';
        const authed = token === '' || authHeader === `Bearer ${token}`;
        const needAuth = (): boolean => {
          if (authed) return true;
          sendJson(res, 401, { message: 'Bad credentials' }, requestId);
          return false;
        };

        // Health: no auth, always up.
        if (path === '/healthz') {
          if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' }, requestId);
          return sendJson(res, 200, { ok: true }, requestId);
        }

        // Git smart-HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const tail = gitMatch[3];
          const repo = getRepo(store, owner, repoName);
          if (repo === undefined) return sendJson(res, 404, { message: 'Not Found' }, requestId);
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
          if (tail === 'info/refs') {
            if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' }, requestId);
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              return sendJson(res, 400, { message: 'Unknown service' }, requestId);
            }
            const out = infoRefs(repo.git, repo.default_branch, service, gitProtocol);
            res.writeHead(out.status, {
              'content-type': out.contentType,
              'x-github-request-id': requestId,
              'content-length': out.body.length,
            });
            return res.end(out.body);
          }
          if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, requestId);
          const body = await readBody(req);
          const out = tail === 'git-upload-pack' ? uploadPack(repo.git, body, gitProtocol) : receivePack(repo.git, body);
          res.writeHead(out.status, {
            'content-type': out.contentType,
            'x-github-request-id': requestId,
            'content-length': out.body.length,
          });
          return res.end(out.body);
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!needAuth()) return;
          const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
          const reply = routeRest(ctx, method, path, url.searchParams, body);
          if (reply === null) return sendJson(res, 404, { message: 'Not Found' }, requestId);
          if (reply.noBody || reply.status === 204) {
            res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
            return res.end();
          }
          return sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, requestId);
          if (!needAuth()) return;
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
          }
          const out = executeGraphQL({ store, host }, parsed);
          return sendJson(res, 200, out, requestId);
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            // Legacy session close: best-effort, always fine.
            res.writeHead(200, { 'x-github-request-id': requestId });
            return res.end();
          }
          if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, requestId);
          if (!needAuth()) return;
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
          }
          const reply = handleMcp(ctx, parsed);
          if (reply.notification === true) {
            res.writeHead(reply.status, { 'x-github-request-id': requestId });
            return res.end();
          }
          return sendJson(res, reply.status, reply.body, requestId);
        }

        return sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });

  // The viewer is the only account that exists; keep the import used.
  void VIEWER;
  return server;
}
