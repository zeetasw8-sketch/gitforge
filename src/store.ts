// In-memory store: repositories, issues, pull requests, labels, comments.
// Everything is deterministic: ids come from counters, timestamps from a logical
// clock (2025-01-01 + 1s per stamp), so a replayed trial produces identical state.

import { buildCommit, buildTree, hashObject, isAncestor, parseCommit, parseTree } from './git.ts';
import type { GitObject, GitStore, ObjType, TreeEntry } from './git.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const STRANGER_LOGIN = 'olgabauer';
export const TEAMMATE_LOGIN = 'quinnkeller';

/** The scenario's fixed epoch: every generated timestamp is this plus an offset. */
export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

export interface Label { id: number; name: string; color: string; description: string; }
export interface Comment { id: number; body: string; user: string; created_at: string; updated_at: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: string; comments: Comment[];
  created_at: string; updated_at: string; closed_at: string | null;
}
export interface PullRequest {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  user: string; created_at: string; updated_at: string; closed_at: string | null;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  default_branch: string; created_at: string; updated_at: string; pushed_at: string;
  git: GitStore;
  issues: Issue[]; pulls: PullRequest[]; labels: Map<string, Label>;
  nextIssue: number; nextPull: number;
}

export interface Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextNodeId: number;
  clock: number;
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 5000, nextNodeId: 10000, clock: 0 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Next logical timestamp (ISO string), strictly increasing. */
export function nowIso(store: Store): string {
  store.clock += 1;
  return new Date((EPOCH_SEC + store.clock) * 1000).toISOString();
}

/** Git author/committer line stamp for the logical clock (seconds, +0000). */
export function nowGitStamp(store: Store): number {
  store.clock += 1;
  return EPOCH_SEC + store.clock;
}

export function gitIdent(store: Store): { line: string; stamp: number } {
  const stamp = nowGitStamp(store);
  return { line: `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`, stamp };
}

export function createRepo(store: Store, input: { name: string; description?: string; private?: boolean; default_branch?: string }): Repo {
  const now = nowIso(store);
  const repo: Repo = {
    id: store.nextRepoId++,
    name: input.name,
    owner: VIEWER.login,
    description: input.description ?? '',
    private: input.private ?? false,
    default_branch: input.default_branch ?? 'main',
    created_at: now,
    updated_at: now,
    pushed_at: now,
    git: { objects: new Map(), refs: new Map(), defaultBranch: input.default_branch ?? 'main' },
    issues: [],
    pulls: [],
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
  };
  store.repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return store.repos.get(repoKey(owner, name));
}

// -------------------------------------------------------------------------------- git helpers

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.git.refs.get(`refs/heads/${branch}`);
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.git.objects.set(oid, { type, data });
  return oid;
}

/** Flatten a tree (recursively) into path -> { mode, oid }. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = repo.git.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
  }
  return out;
}

/** Build (and store) a tree from a flat path map. Returns the root tree oid. */
export function buildTreeFromMap(repo: Repo, flat: Map<string, TreeEntry>): string {
  // Group by directory.
  const dirs = new Map<string, Map<string, TreeEntry>>();
  for (const [path, entry] of flat) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    dirs.get(dir)!.set(name, { mode: entry.mode, name, oid: entry.oid });
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dirs.get(dir) ?? []) entries.push(entry);
    // Subdirectories of this dir.
    for (const [sub, subMap] of dirs) {
      if (sub === dir) continue;
      const slash = sub.lastIndexOf('/');
      const parent = slash < 0 ? '' : sub.slice(0, slash);
      if (parent !== dir) continue;
      const name = slash < 0 ? sub : sub.slice(slash + 1);
      entries.push({ mode: '40000', name, oid: buildDir(sub) });
      void subMap;
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

/** Create a commit object (stored) and return its oid. */
export function createCommit(repo: Repo, store: Store, input: { tree: string; parents: string[]; message: string }): string {
  const { line } = gitIdent(store);
  const data = buildCommit({ tree: input.tree, parents: input.parents, author: line, committer: line, message: input.message });
  return putObject(repo, 'commit', data);
}

export interface FileChange { path: string; content: Buffer; }

/**
 * Commit a set of file writes on `branch` (creating the branch ref when it does not exist).
 * `update` replaces existing paths; new paths are added. Returns the commit oid.
 */
export function commitFiles(repo: Repo, store: Store, branch: string, changes: FileChange[], message: string): string {
  const tip = branchTip(repo, branch);
  const flat = new Map<string, TreeEntry>();
  if (tip !== undefined) {
    const tipObj = repo.git.objects.get(tip);
    if (tipObj?.type === 'commit') flattenTree(repo, parseCommit(tipObj.data).tree, '', flat);
  }
  for (const change of changes) {
    const blobOid = putObject(repo, 'blob', change.content);
    flat.set(change.path, { mode: '100644', name: change.path, oid: blobOid });
  }
  const tree = buildTreeFromMap(repo, flat);
  const parents = tip !== undefined ? [tip] : [];
  const commit = createCommit(repo, store, { tree, parents, message });
  repo.git.refs.set(`refs/heads/${branch}`, commit);
  repo.updated_at = nowIso(store);
  repo.pushed_at = repo.updated_at;
  return commit;
}

/** Delete paths from a branch's tree and commit. Returns the commit oid. */
export function deleteFiles(repo: Repo, store: Store, branch: string, paths: string[], message: string): string {
  const tip = branchTip(repo, branch);
  if (tip === undefined) throw new Error('branch has no tip');
  const tipObj = repo.git.objects.get(tip);
  if (tipObj?.type !== 'commit') throw new Error('tip is not a commit');
  const flat = flattenTree(repo, parseCommit(tipObj.data).tree);
  for (const path of paths) flat.delete(path);
  const tree = buildTreeFromMap(repo, flat);
  const commit = createCommit(repo, store, { tree, parents: [tip], message });
  repo.git.refs.set(`refs/heads/${branch}`, commit);
  repo.updated_at = nowIso(store);
  return commit;
}

export interface DiffEntry { path: string; status: 'added' | 'removed' | 'modified'; oldOid?: string; newOid?: string; }

/** File-level diff between two trees (by root tree oid). */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): DiffEntry[] {
  const oldMap = oldTree === null ? new Map<string, TreeEntry>() : flattenTree(repo, oldTree);
  const newMap = newTree === null ? new Map<string, TreeEntry>() : flattenTree(repo, newTree);
  const out: DiffEntry[] = [];
  for (const [path, entry] of newMap) {
    const old = oldMap.get(path);
    if (old === undefined) out.push({ path, status: 'added', newOid: entry.oid });
    else if (old.oid !== entry.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of oldMap) {
    if (!newMap.has(path)) out.push({ path, status: 'removed', oldOid: entry.oid });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

export interface MergeOutcome { tree: Map<string, TreeEntry>; conflicts: string[]; }

/**
 * Three-way tree merge at file granularity: base, ours (base branch tip), theirs (head tip).
 * A path both sides changed differently (including delete-vs-modify) is a conflict.
 */
export function mergeTrees(repo: Repo, baseTree: string | null, oursTree: string | null, theirsTree: string | null): MergeOutcome {
  const base = baseTree === null ? new Map<string, TreeEntry>() : flattenTree(repo, baseTree);
  const ours = oursTree === null ? new Map<string, TreeEntry>() : flattenTree(repo, oursTree);
  const theirs = theirsTree === null ? new Map<string, TreeEntry>() : flattenTree(repo, theirsTree);
  const merged = new Map<string, TreeEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (a: TreeEntry | undefined, c: TreeEntry | undefined): boolean => (a?.oid ?? null) === (c?.oid ?? null);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { tree: merged, conflicts };
}

/** Merge-base of two commits: the nearest common ancestor (first-parent walk + BFS). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.git.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueA.push(p);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.git.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}

/** List commits from a tip, first-parent order, newest first. */
export function listCommits(repo: Repo, tip: string, limit: number): Array<{ sha: string; commit: CommitView }> {
  const out: Array<{ sha: string; commit: CommitView }> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.git.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    out.push({ sha: oid, commit: view });
    for (const p of view.parents) queue.push(p);
  }
  return out;
}

/** Resolve a ref name or sha to a commit oid (branch name, full ref, or raw sha). */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.git.refs.has(`refs/heads/${ref}`)) return repo.git.refs.get(`refs/heads/${ref}`);
  if (repo.git.refs.has(ref)) return repo.git.refs.get(ref);
  const obj = repo.git.objects.get(ref);
  if (obj?.type === 'commit') return ref;
  if (obj?.type === 'tag') {
    // Peel annotated tags to their commit.
    let current = ref;
    for (let i = 0; i < 10; i += 1) {
      const tagObj = repo.git.objects.get(current);
      if (tagObj?.type !== 'tag') break;
      const text = tagObj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match === null) break;
      current = match[1];
      if (repo.git.objects.get(current)?.type === 'commit') return current;
    }
  }
  return undefined;
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.git.objects.get(commitOid);
  if (obj?.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Walk a tree path (e.g. ['docs','x.md']) to a blob or subtree entry. */
export function lookupPath(repo: Repo, treeOid: string, segments: string[]): { entry: TreeEntry; isDir: boolean } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.git.objects.get(current);
    if (obj?.type !== 'tree') return null;
    const found = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (found === undefined) return null;
    if (i === segments.length - 1) return { entry: found, isDir: found.mode === '40000' };
    if (found.mode !== '40000') return null;
    current = found.oid;
  }
  return null;
}

export { isAncestor };
export type { GitObject };

/**
 * Squash-merge a pull request onto its base branch: three-way merge the trees,
 * commit the result on the base branch, close the pull request. Returns the
 * merge commit sha, or ok:false when the trees conflict.
 */
export function squashMerge(store: Store, repo: Repo, pr: PullRequest): { ok: boolean; sha?: string } {
  const headTip = branchTip(repo, pr.head.ref);
  const baseTip = branchTip(repo, pr.base.ref);
  if (headTip === undefined || baseTip === undefined) return { ok: false };
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const { tree, conflicts } = mergeTrees(repo, baseTree, commitTree(repo, baseTip), commitTree(repo, headTip));
  if (conflicts.length > 0) return { ok: false };
  const mergedTree = buildTreeFromMap(repo, tree);
  const { line } = gitIdent(store);
  let s = `tree ${mergedTree}\n`;
  s += `parent ${baseTip}\n`;
  s += `author ${line}\ncommitter ${line}\n\n${pr.title} (#${pr.number})`;
  const sha = putObject(repo, 'commit', Buffer.from(s, 'utf8'));
  repo.git.refs.set(`refs/heads/${pr.base.ref}`, sha);
  const now = nowIso(store);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = now;
  pr.merge_commit_sha = sha;
  pr.closed_at = now;
  pr.updated_at = now;
  repo.updated_at = now;
  return { ok: true, sha };
}
