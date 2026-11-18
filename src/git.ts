// Pure-TypeScript git: object store, pkt-line framing, packfiles, smart HTTP
// (upload-pack protocol v2 + v0 fallback, receive-pack v0). No git binary,
// no child process: node:zlib and node:crypto only. Packs are written without
// deltas (valid for every client); incoming packs may carry deltas and are
// resolved on read.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }
export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// -------------------------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole pkt-line stream. Throws on a bad length prefix. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    const len = parseInt(lenHex, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// -------------------------------------------------------------------------------- objects

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(c: CommitView): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(s, 'utf8');
}

export interface TreeEntry { mode: string; name: string; oid: string; }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree object');
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = 'commit' as ObjType;
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------- deltas

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const chunks: Buffer[] = [];
  let dstLen = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      dstLen += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
      dstLen += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (dstLen !== dstSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------------------------- packs

export interface PackRead { objects: Map<string, GitObject>; deltaCount: number; }

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i += 1) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `start` and return its data plus the offset just past
 * the stream. inflateSync ignores trailing bytes, so the stream end is found by its Adler-32
 * trailer (the last 4 bytes of a zlib stream), verified by re-inflating the exact slice.
 */
function inflateExact(pack: Buffer, start: number): { data: Buffer; next: number } {
  const data = inflateSync(pack.subarray(start));
  const adler = adler32(data);
  for (let e = start + 2; e + 4 <= pack.length; e += 1) {
    if (pack.readUInt32BE(e) !== adler) continue;
    const end = e + 4;
    try {
      const check = inflateSync(pack.subarray(start, end));
      if (check.length === data.length && check.equals(data)) return { data, next: end };
    } catch {
      // A coincidental Adler match inside the stream: keep scanning.
    }
  }
  throw new Error('zlib stream end not found');
}

/** Read a PACK v2 file. Deltas resolve in-pack or through `resolveBase` (thin packs). */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  if (pack.readUInt32BE(4) !== 2) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const objOffset = off;
    const first = pack[off++];
    const typeCode = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    while (pack[off - 1] & 0x80) {
      const byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeCode === 6) {
      // OFS_DELTA: base offset encoded as a negative-offset varint.
      let byte = pack[off++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = objOffset - base;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, next } = inflateExact(pack, off);
    off = next;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (baseOffset >= 0) {
        const baseOidAt = byOffset.get(baseOffset);
        base = baseOidAt === undefined ? undefined : objects.get(baseOidAt);
      } else if (baseOid !== null) {
        base = objects.get(baseOid) ?? options.resolveBase?.(baseOid);
      }
      if (base === undefined) throw new Error('delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolved);
      objects.set(oid, { type: base.type, data: resolved });
      byOffset.set(objOffset, oid);
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(objOffset, oid);
    }
  }
  return { objects, deltaCount };
}

/** Build a PACK v2 file from plain objects (no deltas). The trailer is SHA-1 over the body. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const typeCode = TYPE_CODE[object.type];
    let size = object.data.length;
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return actual === sha1Hex(pack.subarray(0, pack.length - 20));
}

// -------------------------------------------------------------------------------- reachability

export interface GitStore {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
}

/** True when `ancestor` is reachable from `tip` (or equal), walking commit parents. */
export function isAncestor(store: GitStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    const obj = store.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  return false;
}

export interface ClosureOptions {
  /** Maximum commit generations from a want (0 = the want itself). Undefined = unlimited. */
  depth?: number;
  /** Commits the client already holds: traversal stops at them (their parents excluded). */
  haves?: ReadonlySet<string>;
  /** Shallow boundaries the client holds: traversal stops at them too. */
  shallow?: ReadonlySet<string>;
}

export interface Closure {
  /** Commits to send, with their generation (0 = want). */
  commits: Map<string, number>;
  /** All objects to send (commits + trees + blobs), in a stable order. */
  objects: GitObject[];
  /** New shallow boundary commits (at the depth cutoff). */
  boundary: string[];
}

/**
 * The closure of `wants`: commits within `depth` generations, minus anything reachable
 * from `haves` (stopping at shallow boundaries), plus every tree/blob those commits need.
 */
export function collectClosure(store: GitStore, wants: readonly string[], opts: ClosureOptions = {}): Closure {
  const { depth, haves = new Set(), shallow = new Set() } = opts;
  // Exclusion set: everything reachable from a have, stopping at shallow boundaries
  // (a boundary commit itself is excluded, its parents are not traversed).
  const excluded = new Set<string>();
  const exQueue: string[] = [...haves];
  while (exQueue.length) {
    const oid = exQueue.pop()!;
    if (excluded.has(oid)) continue;
    excluded.add(oid);
    const obj = store.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (!shallow.has(oid)) for (const p of c.parents) exQueue.push(p);
      exQueue.push(c.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) exQueue.push(e.oid);
    }
  }
  // Walk wants up to depth, skipping excluded commits.
  const commits = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wants.filter((w) => store.objects.has(w) && !excluded.has(w)).map((oid) => ({ oid, gen: 0 }));
  const boundary = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (commits.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    commits.set(oid, gen);
    if (depth !== undefined && gen >= depth - 1) { boundary.add(oid); continue; }
    for (const p of parseCommit(obj.data).parents) {
      if (!excluded.has(p) && !commits.has(p)) queue.push({ oid: p, gen: gen + 1 });
    }
  }
  // Gather trees + blobs reachable from the included commits, minus excluded objects.
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid) || excluded.has(oid)) return;
    const obj = store.objects.get(oid);
    if (obj === undefined) return;
    seen.add(oid);
    objects.push(obj);
    if (obj.type === 'commit') {
      addObject(parseCommit(obj.data).tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) addObject(e.oid);
    }
  };
  for (const oid of commits.keys()) addObject(oid);
  return { commits, objects, boundary: [...boundary] };
}

/** Peel an annotated tag to its commit, following tag chains. Returns the tag oid itself otherwise. */
export function peelToCommit(store: GitStore, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = store.objects.get(current);
    if (obj === undefined || obj.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    current = parseTag(obj.data).object;
  }
}

// -------------------------------------------------------------------------------- ref listing

export interface ListedRef { oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean; }

export function listRefs(store: GitStore, defaultBranch: string): ListedRef[] {
  const out: ListedRef[] = [];
  const headRef = `refs/heads/${defaultBranch}`;
  const headOid = store.refs.get(headRef);
  if (headOid !== undefined) out.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  else out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headRef, unborn: true });
  const names = [...store.refs.keys()].sort();
  for (const name of names) {
    const oid = store.refs.get(name)!;
    const entry: ListedRef = { oid, name };
    const obj = store.objects.get(oid);
    if (obj?.type === 'tag') entry.peeled = peelToCommit(store, oid);
    out.push(entry);
  }
  return out;
}

// -------------------------------------------------------------------------------- smart HTTP

const V2_CAPS = ['agent=gitforge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
const V0_UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack agent=gitforge/1.0';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=gitforge/1.0';

function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = 65500;
  for (let off = 0; off < pack.length; off += max) {
    const slice = pack.subarray(off, Math.min(pack.length, off + max));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

/** GET /{owner}/{repo}.git/info/refs?service=<service> */
export function infoRefs(store: GitStore, defaultBranch: string, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | null): { status: number; contentType: string; body: Buffer } {
  const ct = `application/x-${service}-advertisement`;
  const refs = listRefs(store, defaultBranch);
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const lines = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
    for (const cap of V2_CAPS) lines.push(pktLine(`${cap}\n`));
    lines.push(pktFlush());
    return { status: 200, contentType: ct, body: Buffer.concat(lines) };
  }
  const lines = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const headLine = refs.find((r) => r.name === 'HEAD')!;
  if (headLine.unborn) {
    lines.push(pktLine(`${ZERO_OID} HEAD\0symref=HEAD:refs/heads/${defaultBranch} ${caps}\n`));
  } else {
    lines.push(pktLine(`${headLine.oid} HEAD\0symref=HEAD:refs/heads/${defaultBranch} ${caps}\n`));
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  lines.push(pktFlush());
  return { status: 200, contentType: ct, body: Buffer.concat(lines) };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  filter?: string;
}

/** Parse a v2 upload-pack request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') { seenDelim = true; continue; }
    const text = packet.payload.toString('utf8');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice(8).replace(/\n$/, '');
      continue;
    }
    lines.push(text.replace(/\n$/, ''));
  }
  if (command === '') throw new Error('missing command');
  return { command, args: lines };
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('filter ')) out.filter = arg.slice(7).trim();
    // thin-pack, no-progress, ofs-delta, done: acknowledged, no action needed.
  }
  return out;
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(store: GitStore, body: Buffer, gitProtocol: string | null): { status: number; contentType: string; body: Buffer } {
  const ct = 'application/x-git-upload-pack-result';
  if (gitProtocol === 'version=2') {
    let command: string;
    let args: string[];
    try {
      ({ command, args } = parseV2Request(body));
    } catch {
      return { status: 400, contentType: ct, body: Buffer.alloc(0) };
    }
    if (command === 'ls-refs') return { status: 200, contentType: ct, body: lsRefsResponse(store, args) };
    if (command !== 'fetch') return { status: 400, contentType: ct, body: Buffer.alloc(0) };
    return { status: 200, contentType: ct, body: fetchV2Response(store, parseFetchArgs(args)) };
  }
  // v0 fallback.
  try {
    return { status: 200, contentType: ct, body: fetchV0Response(store, parseV0Fetch(body)) };
  } catch {
    return { status: 400, contentType: ct, body: Buffer.alloc(0) };
  }
}

function lsRefsResponse(store: GitStore, args: string[]): Buffer {
  const defaultBranch = store.defaultBranch;
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
  }
  const refs = listRefs(store, defaultBranch);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  for (const ref of refs) {
    if (ref.name === 'HEAD') {
      if (prefixes.length > 0 && !prefixes.some((p) => 'HEAD'.startsWith(p))) continue;
      if (ref.unborn) {
        lines.push(pktLine(`unborn HEAD${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      } else {
        lines.push(pktLine(`${ref.oid} HEAD${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      }
      continue;
    }
    if (!keep(ref.name)) continue;
    lines.push(pktLine(`${ref.oid} ${ref.name}${peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : ''}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

export function lsRefsDefaultBranch(store: GitStore): string {
  return store.defaultBranch;
}

function fetchV2Response(store: GitStore, args: FetchArgs): Buffer {
  const out: Buffer[] = [];
  const haveSet = new Set(args.haves.filter((h) => isOid(h) && store.objects.has(h)));
  const shallowSet = new Set(args.shallow.filter((s) => isOid(s)));
  const wants = args.wants.filter((w) => isOid(w) && store.objects.has(w));
  const closure = collectClosure(store, wants, { depth: args.depth, haves: haveSet, shallow: shallowSet });
  // acknowledgments section: only when the client sent haves. Real git
  // omits it entirely for a have-less fetch (a clone), and its client dies
  // with "expected 'packfile', received 'acknowledgments'" if it is sent.
  if (args.haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    const common = args.haves.filter((h) => haveSet.has(h) && isAncestorOfAny(store, h, wants));
    if (common.length > 0) {
      for (const ack of common) out.push(pktLine(`ACK ${ack}\n`));
      out.push(pktLine('ready\n'));
    } else {
      out.push(pktLine('NAK\n'));
    }
    out.push(pktDelim());
  }
  // shallow-info section
  if (args.depth !== undefined || args.shallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const b of closure.boundary) out.push(pktLine(`shallow ${b}\n`));
    for (const old of args.shallow) {
      if (closure.commits.has(old)) out.push(pktLine(`unshallow ${old}\n`));
    }
    out.push(pktDelim());
  }
  // packfile section
  if (closure.objects.length > 0) {
    out.push(pktLine('packfile\n'));
    out.push(sideband(writePack(closure.objects)));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

/** True when `have` is an ancestor of (or equal to) any want. */
function isAncestorOfAny(store: GitStore, have: string, wants: readonly string[]): boolean {
  for (const want of wants) {
    if (store.objects.has(want) && isAncestor(store, have, want)) return true;
  }
  return false;
}

function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) out.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = parseInt(line.slice(7), 10);
  }
  return out;
}

function fetchV0Response(store: GitStore, args: FetchArgs): Buffer {
  const out: Buffer[] = [];
  const haveSet = new Set(args.haves.filter((h) => isOid(h) && store.objects.has(h)));
  const shallowSet = new Set(args.shallow.filter((s) => isOid(s)));
  const wants = args.wants.filter((w) => isOid(w) && store.objects.has(w));
  const closure = collectClosure(store, wants, { depth: args.depth, haves: haveSet, shallow: shallowSet });
  const common = args.haves.filter((h) => haveSet.has(h) && isAncestorOfAny(store, h, wants));
  if (common.length > 0) {
    for (const ack of common) out.push(pktLine(`ACK ${ack}\n`));
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const b of closure.boundary) out.push(pktLine(`shallow ${b}\n`));
  for (const old of args.shallow) {
    if (closure.commits.has(old)) out.push(pktLine(`unshallow ${old}\n`));
  }
  if (closure.objects.length > 0) out.push(sideband(writePack(closure.objects)));
  out.push(pktFlush());
  return Buffer.concat(out);
}

export interface PushCommand { oldOid: string; newOid: string; ref: string; }
export interface PushReportLine { ref: string; ok: boolean; reason: string; }

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(store: GitStore, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const ct = 'application/x-git-receive-pack-result';
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    commands = [];
    let off = 0;
    while (off < body.length) {
      const lenHex = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error('bad pkt-line');
      const len = parseInt(lenHex, 16);
      if (len === 0) { off += 4; break; }
      if (len === 1) { off += 4; continue; }
      if (len < 4 || off + len > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(off + 4, off + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      off += len;
    }
    packBytes = body.subarray(off);
  } catch {
    return { status: 400, contentType: ct, body: Buffer.alloc(0) };
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdate = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdate && packBytes.length > 0) {
    try {
      if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
      const read = readPack(packBytes);
      for (const [oid, obj] of read.objects) store.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (hasUpdate && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'missing pack';
  }
  const results: PushReportLine[] = [];
  if (unpackOk) {
    for (const cmd of commands) results.push(applyPushCommand(store, cmd));
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
  }
  report.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const r of results) {
    report.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), pktFlush()]);
  const bodyOut = Buffer.concat([sideband(inner), pktFlush()]);
  return { status: 200, contentType: ct, body: bodyOut };
}

function applyPushCommand(store: GitStore, cmd: PushCommand): PushReportLine {
  const current = store.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref: cmd.ref, ok: false, reason: 'remote ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    store.refs.delete(cmd.ref);
    return { ref: cmd.ref, ok: true, reason: '' };
  }
  if (!store.objects.has(cmd.newOid)) return { ref: cmd.ref, ok: false, reason: 'object not found' };
  if (current === undefined) {
    if (cmd.oldOid !== ZERO_OID) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    store.refs.set(cmd.ref, cmd.newOid);
    return { ref: cmd.ref, ok: true, reason: '' };
  }
  if (cmd.oldOid !== current) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  if (cmd.newOid === current) return { ref: cmd.ref, ok: true, reason: '' };
  if (!isAncestor(store, current, cmd.newOid)) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  store.refs.set(cmd.ref, cmd.newOid);
  return { ref: cmd.ref, ok: true, reason: '' };
}
