import { commitRef, listTree, logFirstParent, readBlobs, type FileChange } from "./git.js";
import { analyzeFile, isArchitectureFile, isPackageJson, isTsconfig, KIND_RANK, type RawImport } from "./imports.js";
import { keysFor, makeResolver, parseAliases, parsePackages, type Resolver } from "./resolve.js";
import { folderOf, linkKey } from "./stability.js";
import type { BirthCause, CommitRef, FileEdge, ImportKind, Snapshot } from "./types.js";

/**
 * The replay: the import graph commit by commit, the way the ten-codebase
 * study measured it (ported from its history2.js and smells2.js).
 *
 * It starts from a full parse of the commit before the history window, then
 * applies each first-parent commit: only changed files and the files that
 * import them are parsed and resolved again; everything is re-resolved only
 * when a tsconfig or a package.json changes the aliases. Folder instability
 * is kept up to date as edges come and go, so every commit can be checked
 * for folder links that turn uphill, and each month gets a checkpoint.
 */

export interface RawBirth {
  from: string;
  to: string;
  /** Index into ReplayResult.commits. */
  commit: number;
  cause: BirthCause;
  gap: number;
  imports: number;
}

export interface ReplayResult {
  /** Replayed commits, oldest first, and their full hashes. */
  commits: CommitRef[];
  shas: string[];
  /** The graph before the first replayed commit, and after the last. */
  start: Snapshot;
  end: Snapshot;
  /** Graphs at the commits asked for in `capture`, when they were replayed. */
  captured: Map<string, Snapshot>;
  /** For edges at the end: index of the commit that added them; -1 or missing = before the window. */
  edgeCommit: Map<string, number>;
  /** YYYY-MM from the window's first month to the head's month. */
  months: string[];
  /** Folder -> instability at the end of each month (null: no files then). */
  instability: Map<string, (number | null)[]>;
  /** linkKey(from, to) -> file imports at the end of each month. */
  linkCounts: Map<string, number[]>;
  births: RawBirth[];
}

export interface ReplayOptions {
  repo: string;
  /** Full hash of the last commit to replay. */
  head: string;
  /** First and last month of the window, YYYY-MM (the last is the head's). */
  sinceMonth: string;
  headMonth: string;
  /** Full hashes to keep a graph for (the pull request's merge base, say). */
  capture: string[];
}

export function replay(options: ReplayOptions): ReplayResult {
  const { repo, head } = options;
  const logged = logFirstParent(repo, head, `${options.sinceMonth}-01T00:00:00`);
  const commits = logged.map(commitRef);
  const shas = logged.map((c) => c.sha);
  // The window starts after the parent of its first commit. With no commit
  // in the window, the head itself is the whole picture.
  const startCommit = logged.length > 0 ? (logged[0].parent ?? "") : head;

  const graph = new ImportGraph(repo);
  graph.load(startCommit);
  const folders = new FolderIndex();
  for (const f of graph.files) folders.addFile(f, 1);
  for (const e of graph.edgeList()) folders.addEdge(e.from, e.to, 1);
  folders.touched.clear();

  const capture = new Set(options.capture);
  const captured = new Map<string, Snapshot>();
  const start = graph.snapshot(startCommit);
  if (capture.has(startCommit)) captured.set(startCommit, start);

  // A repository younger than the window starts at its first commit.
  const firstMonth = startCommit === "" && logged.length > 0 ? monthOf(logged[0].date) : options.sinceMonth;
  const months = monthRange(firstMonth > options.sinceMonth ? firstMonth : options.sinceMonth, options.headMonth);
  const instability = new Map<string, (number | null)[]>();
  const linkCounts = new Map<string, number[]>();
  const checkpoint = (i: number) => {
    for (const [folder, files] of folders.fileCount) {
      if (files <= 0) continue;
      let series = instability.get(folder);
      if (series === undefined) {
        series = new Array<number | null>(months.length).fill(null);
        instability.set(folder, series);
      }
      series[i] = round3(folders.instability(folder));
    }
    for (const [from, targets] of folders.out) {
      for (const [to, n] of targets) {
        const key = linkKey(from, to);
        let series = linkCounts.get(key);
        if (series === undefined) {
          series = new Array<number>(months.length).fill(0);
          linkCounts.set(key, series);
        }
        series[i] = n;
      }
    }
  };

  // Uphill episodes: folder pairs that point uphill right now, and when
  // each started. Pairs already uphill at the start were born before.
  const open = new Map<string, { born: number }>();
  for (const [from, targets] of folders.out) {
    for (const to of targets.keys()) {
      if (folders.instability(to) - folders.instability(from) > 1e-9) open.set(linkKey(from, to), { born: -1 });
    }
  }
  const births: RawBirth[] = [];
  const edgeCommit = new Map<string, number>();

  let monthIndex = 0;
  const CHUNK = 300;
  for (let s = 0; s < logged.length; s += CHUNK) {
    const chunk = logged.slice(s, s + CHUNK);
    const needed = new Set<string>();
    for (const c of chunk) {
      for (const ch of c.changes) {
        if (ch.status !== "D" && wanted(ch.to) && ch.oid && !/^0+$/.test(ch.oid)) needed.add(ch.oid);
      }
    }
    const blobs = readBlobs(repo, [...needed]);

    for (let k = 0; k < chunk.length; k++) {
      const ci = s + k;
      const c = chunk[k];
      const month = monthOf(c.date);
      while (monthIndex < months.length - 1 && months[monthIndex] < month) checkpoint(monthIndex++);

      const change = graph.apply(c.changes, blobs);
      // Which folder pairs gained their first import in this commit.
      const pairsBefore = new Set<string>();
      for (const e of change.removed) {
        const [pf, pt] = [folderOf(e.from), folderOf(e.to)];
        if (pf !== pt) pairsBefore.add(linkKey(pf, pt));
      }
      for (const e of change.added) {
        const [pf, pt] = [folderOf(e.from), folderOf(e.to)];
        if (pf !== pt && folders.count(pf, pt) > 0) pairsBefore.add(linkKey(pf, pt));
      }
      const pairsNew = new Set<string>();
      for (const e of change.added) {
        const key = linkKey(folderOf(e.from), folderOf(e.to));
        if (folderOf(e.from) !== folderOf(e.to) && !pairsBefore.has(key)) pairsNew.add(key);
      }

      // Keep an edge's birth commit across renames: removed and re-added
      // under the new names in the same commit is the same import.
      const renamed = new Map(change.renames);
      const r = (x: string) => renamed.get(x) ?? x;
      const gone = new Map<string, number>();
      for (const e of change.removed) {
        const key = edgeKey(e.from, e.to);
        gone.set(edgeKey(r(e.from), r(e.to)), edgeCommit.get(key) ?? -1);
        edgeCommit.delete(key);
        folders.addEdge(e.from, e.to, -1);
      }
      for (const f of change.filesRemoved) folders.addFile(f, -1);
      for (const f of change.filesAdded) folders.addFile(f, 1);
      for (const e of change.added) {
        const key = edgeKey(e.from, e.to);
        edgeCommit.set(key, gone.get(key) ?? ci);
        folders.addEdge(e.from, e.to, 1);
      }

      // Re-check every pair that touches a folder whose coupling changed.
      const moved = new Set<string>();
      for (const [a, b] of change.renames) {
        moved.add(folderOf(a));
        moved.add(folderOf(b));
      }
      const pairs = new Set<string>();
      for (const p of folders.touched) {
        for (const q of folders.out.get(p)?.keys() ?? []) pairs.add(linkKey(p, q));
        for (const q of folders.in.get(p)?.keys() ?? []) pairs.add(linkKey(q, p));
      }
      for (const key of open.keys()) {
        const [p, q] = key.split("\0");
        if (folders.touched.has(p) || folders.touched.has(q)) pairs.add(key);
      }
      for (const key of pairs) {
        const [p, q] = key.split("\0");
        const n = folders.count(p, q);
        const gap = folders.instability(q) - folders.instability(p);
        const up = n > 0 && gap > 1e-9;
        const episode = open.get(key);
        if (up && episode === undefined) {
          const cause: BirthCause = moved.has(p) || moved.has(q) ? "moved" : pairsNew.has(key) ? "new import" : "drift";
          open.set(key, { born: ci });
          births.push({ from: p, to: q, commit: ci, cause, gap: round3(gap), imports: n });
        } else if (!up && episode !== undefined) {
          open.delete(key);
        }
      }
      folders.touched.clear();

      if (capture.has(c.sha)) captured.set(c.sha, graph.snapshot(c.sha));
    }
  }
  while (monthIndex < months.length) checkpoint(monthIndex++);

  return {
    commits,
    shas,
    start,
    end: graph.snapshot(logged.at(-1)?.sha ?? startCommit),
    captured,
    edgeCommit,
    months,
    instability,
    linkCounts,
    births,
  };
}

/** The graph at one commit, parsed in full (for a commit off the replayed path). */
export function snapshotAt(repo: string, commit: string): Snapshot {
  const graph = new ImportGraph(repo);
  graph.load(commit);
  return graph.snapshot(commit);
}

export function edgeKey(from: string, to: string): string {
  return from + "\0" + to;
}

// ---------------------------------------------------------------------------
// The file-level import graph, kept up to date commit by commit

const wanted = (p: string) => isArchitectureFile(p) || isTsconfig(p) || isPackageJson(p);

interface Resolved {
  kind: ImportKind;
  line: number;
}

interface GraphChange {
  added: FileEdge[];
  removed: FileEdge[];
  renames: [string, string][];
  filesAdded: string[];
  filesRemoved: string[];
}

class ImportGraph {
  readonly files = new Set<string>();
  private readonly raw = new Map<string, RawImport[]>();
  /** file -> imported file -> strongest kind and first line. */
  private readonly resolved = new Map<string, Map<string, Resolved>>();
  private readonly importers = new Map<string, Set<string>>();
  private readonly tried = new Map<string, string[]>();
  private readonly byCandidate = new Map<string, Set<string>>();
  private readonly configs = new Map<string, string>();
  private readonly packageFiles = new Map<string, string>();
  private aliasSignature = "";
  private packageSignature = "";
  private resolver: Resolver = () => ({ target: null, bases: [] });

  constructor(private readonly repo: string) {}

  /** Parse every architecture file of a commit ("" = empty tree). */
  load(commit: string): void {
    if (commit === "") {
      this.configure(true);
      return;
    }
    const entries = listTree(this.repo, commit).filter((e) => wanted(e.path));
    const texts = readBlobs(this.repo, entries.map((e) => e.oid));
    for (const e of entries) {
      const text = texts.get(e.oid) ?? "";
      if (isTsconfig(e.path)) this.configs.set(e.path, text);
      else if (isPackageJson(e.path)) this.packageFiles.set(e.path, text);
      else {
        this.files.add(e.path);
        this.raw.set(e.path, analyzeFile(text, e.path) ?? []);
      }
    }
    this.configure(true);
    for (const f of this.files) this.resolveFile(f);
  }

  /** Apply one commit's file changes; returns the edges that came and went. */
  apply(changes: FileChange[], blobs: Map<string, string | null>): GraphChange {
    const result: GraphChange = { added: [], removed: [], renames: [], filesAdded: [], filesRemoved: [] };
    const redo = new Set<string>();
    let configTouched = false;

    for (const ch of changes) {
      const leaves = ch.status === "D" || ch.status === "R";
      if (leaves && this.files.has(ch.from)) {
        for (const [to, r] of this.resolved.get(ch.from) ?? []) {
          result.removed.push({ from: ch.from, to, kind: r.kind, line: r.line });
          this.unindex(this.importers, to, ch.from);
        }
        for (const b of this.tried.get(ch.from) ?? []) this.unindex(this.byCandidate, b, ch.from);
        for (const importer of this.importers.get(ch.from) ?? []) redo.add(importer);
        if (ch.status === "R") result.renames.push([ch.from, ch.to]);
        this.files.delete(ch.from);
        this.raw.delete(ch.from);
        this.resolved.delete(ch.from);
        this.tried.delete(ch.from);
        result.filesRemoved.push(ch.from);
      }
      if (leaves && isTsconfig(ch.from)) {
        this.configs.delete(ch.from);
        configTouched = true;
      }
      if (leaves && isPackageJson(ch.from)) {
        this.packageFiles.delete(ch.from);
        configTouched = true;
      }
      if (ch.status === "D") continue;

      const p = ch.to;
      const text = blobs.get(ch.oid) ?? "";
      if (isTsconfig(p)) {
        this.configs.set(p, text);
        configTouched = true;
        continue;
      }
      if (isPackageJson(p)) {
        this.packageFiles.set(p, text);
        configTouched = true;
        continue;
      }
      if (!isArchitectureFile(p)) continue;
      const isNew = !this.files.has(p);
      this.raw.set(p, analyzeFile(text, p) ?? []);
      redo.add(p);
      if (isNew) {
        this.files.add(p);
        result.filesAdded.push(p);
        // Imports that failed before may resolve to the new file now.
        for (const key of keysFor(p)) for (const f of this.byCandidate.get(key) ?? []) redo.add(f);
      }
    }

    if (configTouched && this.configure(false)) for (const f of this.files) redo.add(f);

    for (const f of redo) {
      if (!this.files.has(f)) continue;
      const { before, after } = this.resolveFile(f);
      for (const [to, r] of after) if (!before.has(to)) result.added.push({ from: f, to, kind: r.kind, line: r.line });
      for (const [to, r] of before) if (!after.has(to)) result.removed.push({ from: f, to, kind: r.kind, line: r.line });
      // A changed kind (type-only to load-time, say) is the same import.
    }
    return result;
  }

  edgeList(): FileEdge[] {
    const edges: FileEdge[] = [];
    for (const [from, targets] of this.resolved) for (const [to, r] of targets) edges.push({ from, to, kind: r.kind, line: r.line });
    return edges;
  }

  snapshot(commit: string): Snapshot {
    return { commit, files: [...this.files].sort(), edges: this.edgeList() };
  }

  /** Rebuild the resolver when aliases or packages changed; true if they did. */
  private configure(force: boolean): boolean {
    const aliases = parseAliases(this.configs);
    const packages = parsePackages(this.packageFiles);
    const a = JSON.stringify(aliases);
    const p = JSON.stringify(packages);
    const changed = a !== this.aliasSignature || p !== this.packageSignature;
    if (changed || force) {
      this.aliasSignature = a;
      this.packageSignature = p;
      this.resolver = makeResolver(this.files, aliases, packages);
    }
    return changed;
  }

  private resolveFile(f: string): { before: Map<string, Resolved>; after: Map<string, Resolved> } {
    for (const b of this.tried.get(f) ?? []) this.unindex(this.byCandidate, b, f);
    const before = this.resolved.get(f) ?? new Map<string, Resolved>();
    const after = new Map<string, Resolved>();
    const bases = new Set<string>();
    for (const im of this.raw.get(f) ?? []) {
      const { target, bases: tried } = this.resolver(im.spec, f);
      for (const b of tried) bases.add(b);
      if (target === null || target === f) continue;
      const seen = after.get(target);
      // The edge keeps its strongest kind, and the line of the first
      // statement of that kind, so the line shown matches the kind shown.
      if (seen === undefined) after.set(target, { kind: im.kind, line: im.line });
      else if (KIND_RANK[im.kind] > KIND_RANK[seen.kind]) {
        seen.kind = im.kind;
        seen.line = im.line;
      } else if (KIND_RANK[im.kind] === KIND_RANK[seen.kind] && im.line < seen.line) {
        seen.line = im.line;
      }
    }
    this.tried.set(f, [...bases]);
    for (const b of bases) this.index(this.byCandidate, b, f);
    for (const t of before.keys()) if (!after.has(t)) this.unindex(this.importers, t, f);
    for (const t of after.keys()) if (!before.has(t)) this.index(this.importers, t, f);
    this.resolved.set(f, after);
    return { before, after };
  }

  private index(map: Map<string, Set<string>>, key: string, value: string): void {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(value);
  }

  private unindex(map: Map<string, Set<string>>, key: string, value: string): void {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Folder coupling, kept up to date edge by edge

class FolderIndex {
  /** from -> to -> file imports between the two folders. */
  readonly out = new Map<string, Map<string, number>>();
  readonly in = new Map<string, Map<string, number>>();
  /** folder -> outside file importing it -> edges (Ca counts the files). */
  private readonly ca = new Map<string, Map<string, number>>();
  /** folder -> inside file importing out -> edges (Ce counts the files). */
  private readonly ce = new Map<string, Map<string, number>>();
  readonly fileCount = new Map<string, number>();
  readonly touched = new Set<string>();

  addFile(file: string, d: number): void {
    const folder = folderOf(file);
    this.fileCount.set(folder, (this.fileCount.get(folder) ?? 0) + d);
    this.touched.add(folder);
  }

  addEdge(from: string, to: string, d: number): void {
    const pf = folderOf(from);
    const pt = folderOf(to);
    if (pf === pt) return;
    bump(this.out, pf, pt, d);
    bump(this.in, pt, pf, d);
    bump(this.ca, pt, from, d);
    bump(this.ce, pf, from, d);
    this.touched.add(pf);
    this.touched.add(pt);
  }

  count(from: string, to: string): number {
    return this.out.get(from)?.get(to) ?? 0;
  }

  instability(folder: string): number {
    const ca = this.ca.get(folder)?.size ?? 0;
    const ce = this.ce.get(folder)?.size ?? 0;
    return ca + ce === 0 ? 0 : ce / (ca + ce);
  }
}

function bump(map: Map<string, Map<string, number>>, a: string, b: string, d: number): void {
  let inner = map.get(a);
  if (inner === undefined) {
    inner = new Map<string, number>();
    map.set(a, inner);
  }
  const v = (inner.get(b) ?? 0) + d;
  if (v > 0) inner.set(b, v);
  else {
    inner.delete(b);
    if (inner.size === 0) map.delete(a);
  }
}

// ---------------------------------------------------------------------------

export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Every month from `first` to `last`, inclusive (YYYY-MM). */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  if (y > ly || (y === ly && m > lm)) return [last];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** The month `n - 1` months before `month`, so the window holds n months. */
export function windowStart(month: string, n: number): string {
  let [y, m] = month.split("-").map(Number);
  m -= Math.max(1, n) - 1;
  while (m < 1) {
    m += 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
