// GraphQL v4 subset: a small parser + executor for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts), plus __type introspection
// for Issue / PullRequest / Repository / SearchType, node(id:), and batched bodies.

import { branchTip, commitTree, diffTrees, getRepo, mergeBase, mergeTrees, nowIso, squashMerge, VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { nodeId } from './rest.ts';

// -------------------------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlField[] | null;
  fragmentType: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue?: GqlValue }>;
  selections: GqlField[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{ }|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }
  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind, name, variables: [], selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value as string;
    } else {
      throw new Error('expected a GraphQL operation');
    }
    const variables: GqlOperation['variables'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: GqlValue | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): string {
    const token = this.next();
    let type: string;
    if (token.kind === 'punct' && token.value === '[') {
      type = `[${this.parseType()}]`;
    } else if (token.kind === 'name') {
      type = token.value;
    } else {
      throw new Error('expected a GraphQL type');
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): GqlField {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        const typeName = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '', args: [], selections, fragmentType: typeName };
      }
      // Named fragment spread: unsupported by the documents; treat as empty.
      this.expectName();
      this.skipDirectives();
      return { alias: null, name: '', args: [], selections: [], fragmentType: null };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArgs() : [];
    this.skipDirectives();
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseArgs(): Array<{ name: string; value: GqlValue }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: GqlValue }> = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected GraphQL value');
  }
}

// -------------------------------------------------------------------------------- schema model

interface TypeField { name: string; type: string; }

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: TypeField[]; enumValues?: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'String' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'description', type: 'String' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'closedAt', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'comments', type: 'IssueCommentConnection' },
      { name: 'url', type: 'String' },
      { name: 'repository', type: 'Repository' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'headRefOid', type: 'String' },
      { name: 'baseRefOid', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'mergeCommit', type: 'Commit' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'closedAt', type: 'String' },
      { name: 'mergedAt', type: 'String' },
      { name: 'url', type: 'String' },
      { name: 'repository', type: 'Repository' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'id', type: 'ID' }] },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Issue' },
      { name: 'edges', type: 'IssueEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequest' },
      { name: 'edges', type: 'PullRequestEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequestChangedFile' },
      { name: 'edges', type: 'PullRequestChangedFileEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String' },
      { name: 'additions', type: 'Int' },
      { name: 'deletions', type: 'Int' },
      { name: 'changeType', type: 'String' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'body', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  SearchType: { kind: 'ENUM', enumValues: ['DISCUSSION', 'ISSUE', 'MARKETPLACE', 'ORGANIZATION', 'PULLREQUEST', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  Node: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID' }] },
  Commit: { kind: 'OBJECT', fields: [{ name: 'oid', type: 'String' }, { name: 'message', type: 'String' }] },
  Label: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'name', type: 'String' },
      { name: 'color', type: 'String' },
      { name: 'description', type: 'String' },
    ],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Label' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'IssueComment' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Issue' },
      { name: 'cursor', type: 'String' },
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequest' },
      { name: 'cursor', type: 'String' },
    ],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequestChangedFile' },
      { name: 'cursor', type: 'String' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }] },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'kind', type: 'String' },
      { name: 'fields', type: '__Field' },
      { name: 'enumValues', type: '__EnumValue' },
      { name: 'description', type: 'String' },
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'type', type: '__Type' },
      { name: 'description', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'types', type: '__Type' },
      { name: 'queryType', type: '__Type' },
      { name: 'mutationType', type: '__Type' },
    ],
  },
};

// -------------------------------------------------------------------------------- execution

export interface GqlContext {
  store: Store;
  host: string;
}

type AnyRecord = Record<string, unknown>;

interface ResolverValue {
  __typename: string;
  [key: string]: unknown;
}

function decodeGlobalId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1], num: parseInt(match[2], 10) };
  } catch {
    return null;
  }
}

function repoByGlobalId(store: Store, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  for (const repo of store.repos.values()) if (repo.id === decoded.num) return repo;
  return undefined;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return undefined;
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === decoded.num);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
  for (const repo of store.repos.values()) {
    const pr = repo.pulls.find((p) => p.id === decoded.num);
    if (pr !== undefined) return { repo, pr };
  }
  return undefined;
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'int': case 'float': case 'string': case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: GqlField, variables: Record<string, unknown>): AnyRecord {
  const out: AnyRecord = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeable(repo: Repo, pr: PullRequest): string {
  const baseTip = branchTip(repo, pr.base.ref);
  const headTip = branchTip(repo, pr.head.ref);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const { conflicts } = mergeTrees(repo, baseTree, commitTree(repo, baseTip), commitTree(repo, headTip));
  return conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

function repoValue(repo: Repo): ResolverValue {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, name: VIEWER.name, email: VIEWER.email, id: nodeId('User', VIEWER.id) },
    defaultBranchRef: { __typename: 'Ref', name: repo.default_branch, id: nodeId('Ref', repo.id) },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    url: '',
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
  };
}

function issueValue(repo: Repo, issue: Issue): ResolverValue {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: nodeId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: { __typename: 'User', login: issue.user, id: nodeId('User', VIEWER.id) },
    url: '',
    repository: repoValue(repo),
  };
}

function prValue(repo: Repo, pr: PullRequest): ResolverValue {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: nodeId('PullRequest', pr.id),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    headRefOid: branchTip(repo, pr.head.ref) ?? pr.head.sha,
    baseRefOid: branchTip(repo, pr.base.ref) ?? pr.base.sha,
    mergeable: prMergeable(repo, pr),
    merged: pr.merged,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    url: '',
    repository: repoValue(repo),
  };
}

/** A `node(id:)` result resolves its fields against its concrete type. */
function effectiveType(parentType: string, parent: ResolverValue): string {
  return parentType === 'Node' ? parent.__typename : parentType;
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly ctx: GqlContext;
  private readonly variables: Record<string, unknown>;
  constructor(ctx: GqlContext, variables: Record<string, unknown>) {
    this.ctx = ctx;
    this.variables = variables;
  }
  execute(op: GqlOperation): { data: AnyRecord | null; errors: Array<{ message: string }> } {
    this.errors = [];
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data: AnyRecord = {};
    const root: ResolverValue = { __typename: rootType };
    for (const field of op.selections) {
      const key = field.alias ?? field.name;
      data[key] = this.resolveField(rootType, root, field);
    }
    return { data, errors: this.errors };
  }

  private fieldTypeName(parentType: string, fieldName: string): string | null {
    if (fieldName === '__type' || fieldName === '__schema') return '__Type';
    const def = SCHEMA[parentType];
    if (def?.kind !== 'OBJECT' || def.fields === undefined) return null;
    return def.fields.find((f) => f.name === fieldName)?.type ?? null;
  }
  private resolveField(parentType: string, parent: ResolverValue, field: GqlField): unknown {
    if (field.fragmentType !== null) {
      // Inline fragment: only apply when the type matches.
      if (field.fragmentType !== parent.__typename && !(field.fragmentType === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(parent.__typename))) {
        return undefined;
      }
      const out: AnyRecord = {};
      for (const sub of field.selections ?? []) {
        const key = sub.alias ?? sub.name;
        const value = this.resolveField(parent.__typename, parent, sub);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (field.name === '') return undefined;
    // Introspection.
    if (field.name === '__type') {
      const args = argMap(field, this.variables);
      const typeName = args.name as string;
      const def = SCHEMA[typeName];
      if (def === undefined) return null;
      return this.typeValue(typeName, def, field);
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', types: Object.keys(SCHEMA).map((name) => ({ name })) };
    }
    const typeName = this.fieldTypeName(effectiveType(parentType, parent), field.name);
    if (typeName === null) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      return null;
    }
    const value = this.resolveLeaf(effectiveType(parentType, parent), parent, field);
    if (field.selections === null || field.selections.length === 0) return value;
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveObject(typeName, item, field.selections!));
    }
    if (typeof value === 'object') {
      return this.resolveObject(typeName, value as ResolverValue, field.selections);
    }
    return value;
  }

  private resolveObject(typeName: string, value: ResolverValue, selections: GqlField[]): AnyRecord {
    const out: AnyRecord = {};
    for (const sub of selections) {
      const resolved = this.resolveField(typeName, value, sub);
      if (resolved === undefined) continue;
      if (sub.fragmentType !== null) {
        // Inline fragments merge their fields into the enclosing object.
        if (resolved !== null && typeof resolved === 'object') Object.assign(out, resolved as AnyRecord);
        continue;
      }
      out[sub.alias ?? sub.name] = resolved;
    }
    return out;
  }

  private typeValue(name: string, def: { kind: 'OBJECT' | 'ENUM'; fields?: TypeField[]; enumValues?: string[] }, field: GqlField): ResolverValue {
    const out: ResolverValue = { __typename: '__Type', name, kind: def.kind };
    for (const sub of field.selections ?? []) {
      if (sub.name === 'fields') {
        out.fields = (def.fields ?? []).map((f) => ({ __typename: '__Field', name: f.name, type: { name: f.type } }));
      } else if (sub.name === 'enumValues') {
        out.enumValues = (def.enumValues ?? []).map((v) => ({ __typename: '__EnumValue', name: v }));
      } else if (sub.name === 'name') {
        out.name = name;
      } else if (sub.name === 'kind') {
        out.kind = def.kind;
      }
    }
    return out;
  }

  private resolveLeaf(parentType: string, parent: ResolverValue, field: GqlField): unknown {
    const args = argMap(field, this.variables);
    const store = this.ctx.store;
    // Root fields.
    if (parentType === 'Query') {
      if (field.name === 'viewer') {
        return { __typename: 'User', login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, id: nodeId('User', VIEWER.id) };
      }
      if (field.name === 'repository') {
        const repo = getRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoValue(repo);
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(store, id);
          return repo === undefined ? null : repoValue(repo);
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(store, id);
          return found === undefined ? null : issueValue(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, id);
          return found === undefined ? null : prValue(found.repo, found.pr);
        }
        return null;
      }
    }
    if (parentType === 'Mutation') {
      return this.resolveMutation(field, args);
    }
    // Repository fields.
    if (parentType === 'Repository') {
      const repo = parent.__repo as Repo;
      if (field.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue === undefined ? null : issueValue(repo, issue);
      }
      if (field.name === 'issues') {
        return this.issuesConnection(repo, args);
      }
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.find((p) => p.number === Number(args.number));
        return pr === undefined ? null : prValue(repo, pr);
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const list = [...repo.pulls].filter((p) => p.state === 'open').sort((a, b) => b.number - a.number).slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: list.map((p) => prValue(repo, p)),
          totalCount: list.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      const direct = (parent as AnyRecord)[field.name];
      if (direct !== undefined) return direct;
      return null;
    }
    // Issue fields.
    if (parentType === 'Issue') {
      const issue = parent.__issue as Issue;
      const repo = parent.__repo as Repo;
      if (field.name === 'labels') {
        return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', id: nodeId('Label', l.id), name: l.name, color: l.color, description: l.description })) };
      }
      if (field.name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: nodeId('IssueComment', c.id), body: c.body, createdAt: c.created_at, updatedAt: c.updated_at })),
        };
      }
      const direct = (parent as AnyRecord)[field.name];
      if (direct !== undefined) return direct;
      void repo;
      return null;
    }
    // PullRequest fields.
    if (parentType === 'PullRequest') {
      const pr = parent.__pr as PullRequest;
      const repo = parent.__repo as Repo;
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headTip = branchTip(repo, pr.head.ref) ?? pr.head.sha;
        const baseTip = branchTip(repo, pr.base.ref) ?? pr.base.sha;
        const base = mergeBase(repo, baseTip, headTip);
        const baseTree = base === null ? null : commitTree(repo, base);
        const headTree = commitTree(repo, headTip);
        const diff = diffTrees(repo, baseTree, headTree).slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: diff.map((d) => ({ __typename: 'PullRequestChangedFile', path: d.path, additions: 1, deletions: 0, changeType: d.status })),
          totalCount: diff.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      if (field.name === 'mergeCommit') {
        return pr.merge_commit_sha === null ? null : { __typename: 'Commit', oid: pr.merge_commit_sha };
      }
      const direct = (parent as AnyRecord)[field.name];
      if (direct !== undefined) return direct;
      return null;
    }
    // Connection nodes pass through.
    if (parentType.endsWith('Connection')) {
      const direct = (parent as AnyRecord)[field.name];
      if (direct !== undefined) return direct;
      return null;
    }
    const direct = (parent as AnyRecord)[field.name];
    return direct === undefined ? null : direct;
  }

  private issuesConnection(repo: Repo, args: AnyRecord): ResolverValue {
    const first = typeof args.first === 'number' ? args.first : 100;
    const after = cursorNumber(args.after);
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
    let list = [...repo.issues];
    if (states !== null) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    if (orderBy.field === 'CREATED_AT') {
      list.sort((a, b) => {
        const cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
        return orderBy.direction === 'ASC' ? cmp : -cmp;
      });
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    if (after !== null) list = list.filter((i) => i.number > after);
    const page = list.slice(0, first);
    const hasNext = list.length > first;
    const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((i) => issueValue(repo, i)),
      totalCount: list.length,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: hasNext,
        hasPreviousPage: after !== null,
        startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
        endCursor,
      },
    };
  }

  private resolveMutation(field: GqlField, args: AnyRecord): unknown {
    const store = this.ctx.store;
    const input = (args.input ?? {}) as AnyRecord;
    if (field.name === 'createIssue') {
      const repo = repoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === undefined) return { __typename: 'CreateIssuePayload', issue: null };
      const now = nowIso(store);
      const issue: Issue = {
        id: store.nextNodeId++,
        number: repo.nextIssue++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: VIEWER.login,
        comments: [],
        created_at: now,
        updated_at: now,
        closed_at: null,
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (found === undefined) return { __typename: 'CloseIssuePayload', issue: null };
      found.issue.state = 'closed';
      found.issue.closed_at = nowIso(store);
      found.issue.updated_at = nowIso(store);
      return { __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) };
    }
    if (field.name === 'createPullRequest') {
      const repo = repoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined || baseSha === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const now = nowIso(store);
      const pr: PullRequest = {
        id: store.nextNodeId++,
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: prValue(repo, pr) };
    }
    if (field.name === 'mergePullRequest') {
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (found === undefined) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const result = squashMerge(store, found.repo, found.pr);
      void result;
      return { __typename: 'MergePullRequestPayload', pullRequest: prValue(found.repo, found.pr) };
    }
    if (field.name === 'addComment') {
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (found === undefined) return { __typename: 'AddCommentPayload', commentEdge: null };
      const now = nowIso(store);
      const comment = { id: store.nextNodeId++, body: String(input.body ?? ''), user: VIEWER.login, created_at: now, updated_at: now };
      found.issue.comments.push(comment);
      found.issue.updated_at = nowIso(store);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: nodeId('IssueComment', comment.id), body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at },
          cursor: cursorFor(comment.id),
        },
      };
    }
    return null;
  }
}

/** Execute one GraphQL request body (object or array of operations). */
export function executeGraphQL(ctx: GqlContext, body: unknown): unknown {
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request must be a JSON object with a query string.' }] };
    }
    const record = entry as AnyRecord;
    const query = record.query;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request must carry a query string.' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: GqlOperation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'GraphQL document is empty.' }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let op = operations[0];
    if (operationName !== null) {
      const named = operations.find((o) => o.name === operationName);
      if (named !== undefined) op = named;
    }
    // Fill variable defaults.
    const vars: Record<string, unknown> = { ...variables };
    for (const v of op.variables) {
      if (vars[v.name] === undefined && v.defaultValue !== undefined) vars[v.name] = resolveValue(v.defaultValue, vars);
    }
    const executor = new Executor(ctx, vars);
    const result = executor.execute(op);
    const out: AnyRecord = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}

export type { Store };
