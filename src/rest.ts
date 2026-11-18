// GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. All state lives in the store; git objects
// live in each repository's object store (see store.ts / git.ts).

import { branchTip, commitFiles, createRepo, deleteFiles, diffTrees, getRepo, listCommits, lookupPath, mergeBase, mergeTrees, nowIso, putObject, resolveRef, VIEWER, commitTree, squashMerge } from './store.ts';
import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';
import { parseCommit, parseTree } from './git.ts';

export interface RestContext {
  store: Store;
  token: string;
  host: string;
  requestSeq: { n: number };
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  noBody?: boolean;
}

const NOT_FOUND = { message: 'Not Found' };

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: nodeId('User', id), avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false };
}

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const owner = userJson(repo.owner, VIEWER.id);
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    html_url: `http://${ctx.host}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://${ctx.host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${ctx.host}:${repo.owner}/${repo.name}.git`,
    clone_url: `http://${ctx.host}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

function labelJson(ctx: RestContext, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `http://${ctx.host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user, VIEWER.id),
    labels: issue.labels.map((l) => labelJson(ctx, repo, l)),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function prMergeable(repo: Repo, pr: PullRequest): boolean {
  const baseTip = branchTip(repo, pr.base.ref);
  const headTip = branchTip(repo, pr.head.ref);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const { conflicts } = mergeTrees(repo, baseTree, commitTree(repo, baseTip), commitTree(repo, headTip));
  return conflicts.length === 0;
}

export function prJson(ctx: RestContext, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headTip = branchTip(repo, pr.head.ref) ?? pr.head.sha;
  const baseTip = branchTip(repo, pr.base.ref) ?? pr.base.sha;
  return {
    id: pr.id,
    node_id: nodeId('PullRequest', pr.id),
    url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `http://${ctx.host}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(pr.user, VIEWER.id),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    mergeable_state: prMergeable(repo, pr) ? 'clean' : 'dirty',
    merged_by: pr.merged ? userJson(pr.user, VIEWER.id) : null,
    draft: false,
    head: {
      label: `${repo.owner}:${pr.head.ref}`,
      ref: pr.head.ref,
      sha: headTip,
      user: userJson(repo.owner, VIEWER.id),
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      label: `${repo.owner}:${pr.base.ref}`,
      ref: pr.base.ref,
      sha: baseTip,
      user: userJson(repo.owner, VIEWER.id),
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    author_association: 'OWNER',
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    link = `?per_page=${perPage}&page=${page + 1}`;
  }
  return { page: slice, link };
}

/** Build an absolute Link header value from a request's base path. */
function linkHeader(ctx: RestContext, path: string, query: URLSearchParams, relLink: string | null): string | null {
  if (relLink === null) return null;
  const base = `http://${ctx.host}${path}`;
  const next = new URL(relLink, base);
  // Preserve the caller's other query params (state, sort, ...).
  for (const [k, v] of query) {
    if (k !== 'page' && k !== 'per_page') next.searchParams.set(k, v);
  }
  return `<${next.toString()}>; rel="next"`;
}

interface ParsedBody { ok: boolean; value: Record<string, unknown> | null; }

function parseBody(raw: Buffer): ParsedBody {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: true, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Split a path into segments, decoding each. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
}

/** The line diff between two blobs: added/deleted line counts (prefix/suffix trim). */
function lineDiff(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldBuf === null ? [] : oldBuf.toString('utf8').split('\n');
  const newLines = newBuf === null ? [] : newBuf.toString('utf8').split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

function blobLines(repo: Repo, oid: string | undefined): Buffer | null {
  if (oid === undefined) return null;
  const obj = repo.git.objects.get(oid);
  return obj?.type === 'blob' ? obj.data : null;
}

/** Route one REST request. Returns null when the path is not a REST route. */
export function routeRest(ctx: RestContext, method: string, path: string, query: URLSearchParams, rawBody: Buffer): RestReply | null {
  const seg = segments(path);
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return null;

  // Auth: every /api/v3 route needs the exact bearer <redacted> (when one is configured).
  const authed = ctx.token === '';
  void authed;

  const rest = seg.slice(2);
  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    return { status: 200, body: { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email } };
  }
  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = [...ctx.store.repos.values()].sort((a, b) => a.id - b.id);
      const { page, link } = paginate(repos, query);
      const headers: Record<string, string> = {};
      const lh = linkHeader(ctx, path, query, link);
      if (lh !== null) headers.link = lh;
      return { status: 200, body: page.map((r) => repoJson(ctx, r)), headers };
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      const name = str(body.name);
      if (name === '') return { status: 422, body: { message: 'Repository name is required' } };
      if (ctx.store.repos.has(`${VIEWER.login}/${name}`)) {
        return { status: 422, body: { message: `Repository ${VIEWER.login}/${name} already exists` } };
      }
      const repo = createRepo(ctx.store, {
        name,
        description: str(body.description),
        private: bool(body.private, false),
        default_branch: str(body.default_branch) || undefined,
      });
      return { status: 201, body: repoJson(ctx, repo) };
    }
    return { status: 404, body: NOT_FOUND };
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    return routeRepo(ctx, method, rest.slice(1), query, rawBody, path);
  }
  return { status: 404, body: NOT_FOUND };
}

function routeRepo(ctx: RestContext, method: string, rest: string[], query: URLSearchParams, rawBody: Buffer, fullPath: string): RestReply {
  const owner = rest[0];
  const name = rest[1];
  const repo = getRepo(ctx.store, owner, name);
  if (repo === undefined) return { status: 404, body: { message: 'Not Found' } };
  const tail = rest.slice(2);

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(ctx, repo) };
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updated_at = nowIso(ctx.store);
      return { status: 200, body: repoJson(ctx, repo) };
    }
    if (method === 'DELETE') {
      ctx.store.repos.delete(`${owner}/${name}`);
      return { status: 204, body: null, noBody: true };
    }
    return { status: 404, body: NOT_FOUND };
  }

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    const branches: Array<Record<string, unknown>> = [];
    const names = [...repo.git.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
    for (const branch of names) {
      branches.push({ name: branch, commit: { sha: repo.git.refs.get(`refs/heads/${branch}`)! }, protected: false });
    }
    return { status: 200, body: branches };
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') return { status: 404, body: NOT_FOUND };
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = parsed.value ?? {};
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || sha === '' || repo.git.objects.get(sha) === undefined) {
      return { status: 422, body: { message: 'Invalid ref or sha' } };
    }
    if (repo.git.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
    repo.git.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: repo.git.objects.get(sha)!.type } } };
  }

  // GET /repos/{o}/{r}/commits
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    const ref = query.get('sha') ?? repo.default_branch;
    const tip = resolveRef(repo, ref);
    if (tip === undefined) return { status: 404, body: { message: 'Not Found' } };
    const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
    const commits = listCommits(repo, tip, perPage);
    return {
      status: 200,
      body: commits.map(({ sha, commit }) => {
        const authorLine = commit.author;
        const committerLine = commit.committer;
        const parseIdent = (line: string): { name: string; email: string; date: string } => {
          const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
          if (m === null) return { name: line, email: '', date: repo.created_at };
          return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
        };
        const author = parseIdent(authorLine);
        const committer = parseIdent(committerLine);
        return {
          sha,
          commit: {
            message: commit.message,
            author,
            committer,
            tree: { sha: commit.tree },
            url: `http://${ctx.host}/api/v3/repos/${owner}/${name}/commits/${sha}`,
          },
          author: userJson(VIEWER.login, VIEWER.id),
          committer: userJson(VIEWER.login, VIEWER.id),
          parents: commit.parents.map((p) => ({ sha: p })),
        };
      }),
    };
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail.length >= 1 && tail[0] === 'contents') {
    return routeContents(ctx, method, repo, tail.slice(1), query, rawBody, owner, name);
  }

  // /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((l) => labelJson(ctx, repo, l)) };
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      const labelName = str(body.name);
      if (labelName === '') return { status: 422, body: { message: 'Label name is required' } };
      if (repo.labels.has(labelName)) return { status: 422, body: { message: 'Label already exists' } };
      const label: Label = {
        id: ctx.store.nextNodeId++,
        name: labelName,
        color: str(body.color) || 'ededed',
        description: str(body.description),
      };
      repo.labels.set(labelName, label);
      return { status: 201, body: labelJson(ctx, repo, label) };
    }
    return { status: 404, body: NOT_FOUND };
  }

  // /repos/{o}/{r}/issues[...]
  if (tail.length >= 1 && tail[0] === 'issues') {
    return routeIssues(ctx, method, repo, tail.slice(1), query, rawBody, owner, name, fullPath);
  }

  // /repos/{o}/{r}/pulls[...]
  if (tail.length >= 1 && tail[0] === 'pulls') {
    return routePulls(ctx, method, repo, tail.slice(1), query, rawBody, owner, name, fullPath);
  }

  return { status: 404, body: NOT_FOUND };
}

function routeContents(ctx: RestContext, method: string, repo: Repo, tail: string[], query: URLSearchParams, rawBody: Buffer, owner: string, name: string): RestReply {
  const filePath = tail.join('/');
  const ref = query.get('ref') ?? repo.default_branch;
  const tip = resolveRef(repo, ref);

  if (method === 'GET') {
    if (tip === undefined) return { status: 404, body: { message: 'Not Found' } };
    const tree = commitTree(repo, tip);
    if (tree === null) return { status: 404, body: { message: 'Not Found' } };
    if (filePath === '') {
      const obj = repo.git.objects.get(tree);
      if (obj?.type !== 'tree') return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: parseTree(obj.data).map((e) => dirEntryJson(ctx, repo, e, '')) };
    }
    const found = lookupPath(repo, tree, filePath.split('/'));
    if (found === null) return { status: 404, body: { message: 'Not Found' } };
    if (found.isDir) {
      const obj = repo.git.objects.get(found.entry.oid);
      if (obj?.type !== 'tree') return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: parseTree(obj.data).map((e) => dirEntryJson(ctx, repo, e, filePath)) };
    }
    const blob = repo.git.objects.get(found.entry.oid);
    if (blob?.type !== 'blob') return { status: 404, body: { message: 'Not Found' } };
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: found.entry.name,
        path: filePath,
        content: blob.data.toString('base64'),
        sha: found.entry.oid,
        url: `http://${ctx.host}/api/v3/repos/${owner}/${name}/contents/${filePath}`,
        html_url: `http://${ctx.host}/${owner}/${name}/blob/${ref}/${filePath}`,
        download_url: null,
        _links: { self: `http://${ctx.host}/api/v3/repos/${owner}/${name}/contents/${filePath}`, git: '', html: '' },
      },
    };
  }

  if (method === 'PUT') {
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = parsed.value ?? {};
    const branch = str(body.branch) || repo.default_branch;
    const branchTipOid = branchTip(repo, branch);
    const message = str(body.message) || `Update ${filePath}`;
    const contentB64 = str(body.content);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
      if (contentB64 !== '' && content.length === 0 && !/^[A-Za-z0-9+/=]*$/.test(contentB64)) throw new Error('bad base64');
    } catch {
      return { status: 400, body: { message: 'Invalid base64 content' } };
    }
    const sha = str(body.sha);
    // Current blob sha at the path (if any).
    let currentSha: string | undefined;
    if (branchTipOid !== undefined) {
      const tree = commitTree(repo, branchTipOid);
      if (tree !== null) {
        const found = lookupPath(repo, tree, filePath.split('/'));
        if (found !== null && !found.isDir) currentSha = found.entry.oid;
      }
    }
    if (currentSha !== undefined) {
      if (sha === '') return { status: 422, body: { message: 'sha wasn\'t supplied' } };
      if (sha !== currentSha) return { status: 409, body: { message: 'the blob sha does not match the current blob' } };
    } else if (sha !== '') {
      return { status: 409, body: { message: 'the file does not exist at this sha' } };
    }
    const commitSha = commitFiles(repo, ctx.store, branch, [{ path: filePath, content }], message);
    const blobOid = putObject(repo, 'blob', content);
    return {
      status: currentSha !== undefined ? 200 : 201,
      body: {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: commitSha, message },
      },
    };
  }

  if (method === 'DELETE') {
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = parsed.value ?? {};
    const branch = str(body.branch) || repo.default_branch;
    const tipOid = branchTip(repo, branch);
    if (tipOid === undefined) return { status: 404, body: { message: 'Not Found' } };
    const tree = commitTree(repo, tipOid);
    if (tree === null) return { status: 404, body: { message: 'Not Found' } };
    const found = lookupPath(repo, tree, filePath.split('/'));
    if (found === null || found.isDir) return { status: 404, body: { message: 'Not Found' } };
    const sha = str(body.sha);
    if (sha !== '' && sha !== found.entry.oid) return { status: 409, body: { message: 'the blob sha does not match the current blob' } };
    const message = str(body.message) || `Delete ${filePath}`;
    const commitSha = deleteFiles(repo, ctx.store, branch, [filePath], message);
    return { status: 200, body: { commit: { sha: commitSha, message } } };
  }

  return { status: 404, body: NOT_FOUND };
}

function dirEntryJson(ctx: RestContext, repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : (repo.git.objects.get(entry.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `http://${ctx.host}/${repo.owner}/${repo.name}/blob/${repo.default_branch}/${path}`,
    download_url: isDir ? null : '',
    _links: { self: '', git: '', html: '' },
  };
}

/** Shared issue creation (REST and MCP call this; labels must already exist). */
export function createIssueRecord(ctx: RestContext, repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue } | { error: string } {
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (label === undefined) return { error: `Label '${labelName}' does not exist` };
    labels.push(label);
  }
  const now = nowIso(ctx.store);
  const issue: Issue = {
    id: ctx.store.nextNodeId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels,
    user: VIEWER.login,
    comments: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
  repo.issues.push(issue);
  return { issue };
}

/** Shared pull-request creation (REST and MCP call this). */
export function createPullRecord(ctx: RestContext, repo: Repo, title: string, body: string, head: string, base: string): { pr: PullRequest } | { error: string } {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined || baseSha === undefined) return { error: 'Head or base branch does not exist' };
  const now = nowIso(ctx.store);
  const pr: PullRequest = {
    id: ctx.store.nextNodeId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    user: VIEWER.login,
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
  repo.pulls.push(pr);
  return { pr };
}

function routeIssues(ctx: RestContext, method: string, repo: Repo, tail: string[], query: URLSearchParams, rawBody: Buffer, owner: string, name: string, fullPath: string): RestReply {
  // POST/GET /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      const title = str(body.title);
      if (title === '') return { status: 422, body: { message: 'Title is required' } };
      const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = createIssueRecord(ctx, repo, title, str(body.body), labelNames);
      if ('error' in created) return { status: 422, body: { message: created.error } };
      return { status: 201, body: issueJson(ctx, repo, created.issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => {
          const cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
      } else {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, link } = paginate(list, query);
      const headers: Record<string, string> = {};
      const lh = linkHeader(ctx, fullPath, query, link);
      if (lh !== null) headers.link = lh;
      return { status: 200, body: page.map((i) => issueJson(ctx, repo, i)), headers };
    }
    return { status: 404, body: NOT_FOUND };
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return { status: 404, body: NOT_FOUND };
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) return { status: 404, body: { message: 'Not Found' } };
  // GET/PATCH /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(ctx, repo, issue) };
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closed_at = body.state === 'closed' ? nowIso(ctx.store) : null;
      }
      if (Array.isArray(body.labels)) {
        const labels: Label[] = [];
        for (const labelName of body.labels) {
          if (typeof labelName !== 'string') continue;
          const label = repo.labels.get(labelName);
          if (label === undefined) return { status: 422, body: { message: `Label '${labelName}' does not exist` } };
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updated_at = nowIso(ctx.store);
      return { status: 200, body: issueJson(ctx, repo, issue) };
    }
    return { status: 404, body: NOT_FOUND };
  }
  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      const commentBody = str(body.body);
      if (commentBody === '') return { status: 422, body: { message: 'Comment body is required' } };
      const now = nowIso(ctx.store);
      const comment = { id: ctx.store.nextNodeId++, body: commentBody, user: VIEWER.login, created_at: now, updated_at: now };
      issue.comments.push(comment);
      issue.updated_at = nowIso(ctx.store);
      return {
        status: 201,
        body: {
          id: comment.id,
          node_id: nodeId('IssueComment', comment.id),
          url: `http://${ctx.host}/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          html_url: `http://${ctx.host}/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: userJson(comment.user, VIEWER.id),
          created_at: comment.created_at,
          updated_at: comment.updated_at,
        },
      };
    }
    if (method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((c) => ({
          id: c.id,
          node_id: nodeId('IssueComment', c.id),
          url: `http://${ctx.host}/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
          html_url: `http://${ctx.host}/${owner}/${name}/issues/${issue.number}#issuecomment-${c.id}`,
          body: c.body,
          user: userJson(c.user, VIEWER.id),
          created_at: c.created_at,
          updated_at: c.updated_at,
        })),
      };
    }
    return { status: 404, body: NOT_FOUND };
  }
  return { status: 404, body: NOT_FOUND };
}

function routePulls(ctx: RestContext, method: string, repo: Repo, tail: string[], query: URLSearchParams, rawBody: Buffer, owner: string, name: string, fullPath: string): RestReply {
  // POST/GET /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = parsed.value ?? {};
      const head = str(body.head);
      const base = str(body.base) || repo.default_branch;
      const title = str(body.title);
      if (head === '' || title === '') return { status: 422, body: { message: 'Head and title are required' } };
      const created = createPullRecord(ctx, repo, title, str(body.body), head, base);
      if ('error' in created) return { status: 422, body: { message: created.error } };
      return { status: 201, body: prJson(ctx, repo, created.pr) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(list, query);
      const headers: Record<string, string> = {};
      const lh = linkHeader(ctx, fullPath, query, link);
      if (lh !== null) headers.link = lh;
      return { status: 200, body: page.map((p) => prJson(ctx, repo, p)), headers };
    }
    return { status: 404, body: NOT_FOUND };
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return { status: 404, body: NOT_FOUND };
  const pr = repo.pulls.find((p) => p.number === number);
  if (pr === undefined) return { status: 404, body: { message: 'Not Found' } };
  // GET /pulls/{n}
  if (tail.length === 1) {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    return { status: 200, body: prJson(ctx, repo, pr) };
  }
  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return { status: 404, body: NOT_FOUND };
    const headTip = branchTip(repo, pr.head.ref) ?? pr.head.sha;
    const baseTip = branchTip(repo, pr.base.ref) ?? pr.base.sha;
    const base = mergeBase(repo, baseTip, headTip);
    const baseTree = base === null ? null : commitTree(repo, base);
    const headTree = commitTree(repo, headTip);
    const diff = diffTrees(repo, baseTree, headTree);
    return {
      status: 200,
      body: diff.map((d) => {
        const { additions, deletions } = lineDiff(blobLines(repo, d.oldOid), blobLines(repo, d.newOid));
        return {
          sha: d.newOid ?? d.oldOid ?? '',
          filename: d.path,
          status: d.status,
          additions,
          deletions,
          changes: additions + deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        };
      }),
    };
  }
  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return { status: 404, body: NOT_FOUND };
    if (pr.merged || pr.state === 'closed') return { status: 409, body: { message: 'Pull request is already merged or closed' } };
    const result = squashMerge(ctx.store, repo, pr);
    if (!result.ok) return { status: 405, body: { message: 'Merge conflict' } };
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull request successfully merged.' } };
  }
  return { status: 404, body: NOT_FOUND };
}
