import * as path from "node:path";
import {
  folderLinks,
  folderOf,
  folderStability,
  linkKey,
  uphillKind,
  type FolderLink,
  type FolderStability,
} from "./stability.js";
import type {
  Clue,
  CommitRef,
  DecisionRecord,
  FileEdge,
  FileUsers,
  ImportLine,
  Ladder,
  LadderFolder,
  Piece,
  ReviewLink,
  Snapshot,
} from "./types.js";

/**
 * The review itself, without git or the disk: given the graph before and
 * after a change, find the uphill folder links the change created or grew,
 * and gather what the author needs to judge each one. Pure, so it can be
 * tested on hand-made graphs.
 */

/** Gaps below this are left alone; 0.2 is the "big gap" used in the study. */
export const DEFAULT_MIN_GAP = 0.2;

/** Neighbours shown on the ladder; the rest are counted, not drawn. */
const MAX_RELIES_ON_FROM = 8;
const MAX_TO_RELIES_ON = 6;
/** Folders listed in the piece's map besides the two ends of the link. */
const MAX_MAP_FOLDERS = 30;
/** File text in the piece beyond the new imports' files: about 8,000 tokens. */
const MAX_OLD_FILE_CHARS = 32_000;

export interface CoreInput {
  base: Snapshot;
  head: Snapshot;
  /** Contents of a file at the head, or null when it cannot be read. */
  headText: (file: string) => string | null;
  /** The commit that added an import, when known. */
  commitOf?: (edge: FileEdge) => CommitRef | null;
  decisions: DecisionRecord[];
  minGap?: number;
}

export interface CoreOutput {
  links: ReviewLink[];
  /** File imports added by the change. */
  newImports: number;
  /** Links marked meant earlier that the change touched without growing them. */
  quiet: number;
}

export function findUphillLinks(input: CoreInput): CoreOutput {
  const minGap = input.minGap ?? DEFAULT_MIN_GAP;
  const { base, head } = input;
  const commitOf = input.commitOf ?? (() => null);

  const stability = folderStability(head.files, head.edges);
  const links = folderLinks(head.edges);
  const baseEdges = new Set(base.edges.map(edgeKey));
  const baseLinks = folderLinks(base.edges);
  const importers = importersByFile(head.edges);
  const entryFiles = entryFilesOf(head.edges);
  const decisions = new Map(input.decisions.map((d) => [linkKey(d.from, d.to), d]));

  const incoming = new Map<string, FolderLink[]>();
  const outgoing = new Map<string, FolderLink[]>();
  for (const link of links.values()) {
    push(incoming, link.to, link);
    push(outgoing, link.from, link);
  }

  const newImports = head.edges.filter((e) => !baseEdges.has(edgeKey(e))).length;

  const found: ReviewLink[] = [];
  let quiet = 0;
  for (const link of links.values()) {
    const from = stability.get(link.from);
    const to = stability.get(link.to);
    if (from === undefined || to === undefined) continue;
    const gap = to.instability - from.instability;
    if (gap < minGap - 1e-9) continue;
    // Only links this change touched: at least one import is new. Links
    // that were already uphill before stay out of the author's way.
    if (!link.imports.some((e) => !baseEdges.has(edgeKey(e)))) continue;
    // A link marked meant stays quiet until it grows.
    const decision = decisions.get(linkKey(link.from, link.to)) ?? null;
    const grew = decision !== null && decision.decision === "meant" && link.imports.length > decision.imports;
    if (decision !== null && decision.decision === "meant" && !grew) {
      quiet++;
      continue;
    }

    const kind = uphillKind(link.from, link.to);
    const imports = link.imports
      .map((e) => {
        const isNew = !baseEdges.has(edgeKey(e));
        return describeImport(e, isNew, isNew ? commitOf(e) : null, input.headText);
      })
      .sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const targets = [...new Set(link.imports.map((e) => e.to))].sort();
    const lens = targets.map((t) => fileUsers(t, link.from, link.to, importers, entryFiles.get(t) ?? 0));
    const clue = makeClue(kind, link.from, link.to, lens, imports);
    const ladder = makeLadder(link, stability, incoming, outgoing);
    const dependents = incoming.get(link.from) ?? [];

    found.push({
      id: `${link.from} -> ${link.to}`,
      from: link.from,
      to: link.to,
      fromInstability: round2(from.instability),
      toInstability: round2(to.instability),
      gap: round2(gap),
      kind,
      isNewLink: !baseLinks.has(linkKey(link.from, link.to)),
      loop: links.has(linkKey(link.to, link.from)),
      imports,
      reliedOnBy: { files: from.afferent, folders: dependents.length },
      lens,
      clue,
      ladder,
      piece: makePiece(link, from, to, dependents.length, imports, lens, decision, stability, links, input.headText),
      decision,
      grew,
    });
  }

  // Undecided first, then by gap times exposure (the doc's list order):
  // the links that expose the most code to the most change come first.
  found.sort(
    (a, b) =>
      Number(a.decision !== null && !a.grew) - Number(b.decision !== null && !b.grew) ||
      b.gap * (b.reliedOnBy.files + 1) - a.gap * (a.reliedOnBy.files + 1) ||
      a.id.localeCompare(b.id),
  );

  return { links: found, newImports, quiet };
}

// ---------------------------------------------------------------------------
// Import statements

function describeImport(
  edge: FileEdge,
  isNew: boolean,
  commit: CommitRef | null,
  headText: (file: string) => string | null,
): ImportLine {
  const text = headText(edge.from);
  // The replay knows the statement's line; the text search is the fallback.
  const found =
    text === null ? null : edge.line !== undefined ? statementAt(text, edge.line) : findImportStatement(text, edge.from, edge.to);
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    line: found?.line ?? null,
    text: found?.text ?? null,
    isNew,
    commit,
  };
}

const EXTENSION = /\.(d\.ts|tsx?|mts|cts|jsx?|mjs|cjs)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s+)(['"])([^'"\n]+)\1/g;
const STATEMENT_START = /^\s*(import|export)\b/;

/**
 * Find the statement in `fromFile` that imports `toFile`. The parser only
 * reports file pairs, so this re-reads the source text: relative specifiers
 * are resolved exactly, alias specifiers ("~/stores/x", "app/features/x")
 * are matched on their path tail. Good enough to point at the line; when it
 * finds nothing the view shows the file pair only.
 */
export function findImportStatement(
  text: string,
  fromFile: string,
  toFile: string,
): { line: number; text: string; typeOnly: boolean } | null {
  const target = toFile.replace(EXTENSION, "");
  const targetFolder = target.endsWith("/index") ? target.slice(0, -"/index".length) : null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(SPECIFIER)) {
      if (!specifierPointsAt(match[2], fromFile, target, targetFolder)) continue;
      const start = statementStart(lines, i);
      const statement = lines
        .slice(start, i + 1)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        line: start + 1,
        text: statement.length > 180 ? statement.slice(0, 177) + "..." : statement,
        typeOnly: /^(import|export)\s+type\b/.test(statement),
      };
    }
  }
  return null;
}

function specifierPointsAt(
  specifier: string,
  fromFile: string,
  target: string,
  targetFolder: string | null,
): boolean {
  const spec = specifier.replace(EXTENSION, "").replace(/\/$/, "");
  const same = (candidate: string) => candidate === target || candidate === targetFolder;
  if (spec.startsWith(".")) {
    return same(path.posix.normalize(path.posix.join(folderOf(fromFile), spec)));
  }
  const parts = spec.split("/").filter((p) => p.length > 0);
  const endsWith = (whole: string | null, tail: string) =>
    whole !== null && (whole === tail || whole.endsWith("/" + tail));
  // Drop leading alias segments one at a time, but keep at least two
  // segments so a bare "utils" does not match every utils file.
  for (let drop = 0; drop < parts.length; drop++) {
    const tail = parts.slice(drop).join("/");
    if (parts.length - drop < 2 && drop > 0) break;
    if (endsWith(target, tail) || endsWith(targetFolder, tail)) return true;
  }
  return false;
}

/** The statement starting at a 1-based line, up to its module specifier. */
function statementAt(text: string, line: number): { line: number; text: string; typeOnly: boolean } | null {
  const lines = text.split(/\r?\n/);
  if (line < 1 || line > lines.length) return null;
  const parts: string[] = [];
  for (let i = line - 1; i < Math.min(lines.length, line + 39); i++) {
    parts.push(lines[i]);
    if (/['"][^'"\n]+['"]\s*\)?\s*;?\s*$/.test(lines[i]) || /;\s*$/.test(lines[i])) break;
  }
  const statement = parts.join(" ").replace(/\s+/g, " ").trim();
  return {
    line,
    text: statement.length > 180 ? statement.slice(0, 177) + "..." : statement,
    typeOnly: /^(import|export)\s+type\b/.test(statement),
  };
}

/** Multi-line imports: walk back from the specifier line to `import`/`export`. */
function statementStart(lines: string[], i: number): number {
  if (STATEMENT_START.test(lines[i])) return i;
  for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
    // A semicolon ends an earlier statement: this one starts on line i.
    if (lines[j].includes(";")) break;
    if (STATEMENT_START.test(lines[j])) return j;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Cohesion lens and clue

function importersByFile(imports: FileEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of imports) push(result, edge.to, edge.from);
  return result;
}

/**
 * Entry files and how many files each re-exports: an index file with at
 * least one re-export, or any file that mostly re-exports. A package's
 * index.ts is the usual case: other packages import it, not the code behind it.
 */
function entryFilesOf(edges: FileEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  const reexports = new Map<string, number>();
  for (const e of edges) {
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
    if (e.kind === "re-export") reexports.set(e.from, (reexports.get(e.from) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const [file, n] of reexports) {
    const isIndex = /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(file));
    if (isIndex || n * 2 >= (out.get(file) ?? 0)) result.set(file, n);
  }
  return result;
}

function fileUsers(
  file: string,
  from: string,
  to: string,
  importers: Map<string, string[]>,
  reexports: number,
): FileUsers {
  let home = 0;
  let importingSide = 0;
  const elsewhere = new Map<string, number>();
  for (const user of new Set(importers.get(file) ?? [])) {
    const folder = folderOf(user);
    if (folder === to) home++;
    else if (folder === from) importingSide++;
    else elsewhere.set(folder, (elsewhere.get(folder) ?? 0) + 1);
  }
  return {
    file,
    home,
    importingSide,
    reexports,
    elsewhere: [...elsewhere.entries()]
      .map(([folder, files]) => ({ folder, files }))
      .sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder)),
  };
}

/**
 * The clue reads the lens: a file nobody in its own folder uses looks
 * misplaced (move it); a file its own folder uses most looks like it belongs
 * there (flip the dependency instead); in between, split it. It only counts
 * importers, so it cannot see what the code means; the author decides.
 */
function makeClue(
  kind: "sideways" | "into-subfolder",
  from: string,
  to: string,
  lens: FileUsers[],
  imports: ImportLine[],
): Clue {
  if (kind === "into-subfolder") {
    return {
      kind: "subfolder",
      headline: "Likely meant",
      reason: `${from} imports its own subfolder. That is often by design, for example an index file that re-exports it.`,
    };
  }
  // An entry file only says that the package is imported, not which code
  // is used, so its counts cannot tell where the code belongs. Read the
  // ordinary files; when there are none, moving is off the table.
  const entries = lens.filter((l) => l.reexports > 0);
  const plain = lens.filter((l) => l.reexports === 0);
  if (plain.length === 0 && entries.length > 0) {
    const files = plural(sum(entries.map((l) => l.reexports)), "file");
    const door =
      entries.length === 1
        ? `${path.posix.basename(entries[0].file)} is the entry file of ${to} (it re-exports ${files}), so moving it is not a fix.`
        : `These ${entries.length} files are entry files of ${to} (they re-export ${files}), so moving them is not a fix.`;
    return {
      kind: "flip",
      headline: "Flip it?",
      reason: `${door} ${from} could own what it needs (a type, an interface or an event) and let ${to} plug into it, or the few things it uses could move down to a stable folder.`,
    };
  }
  const home = sum(plain.map((l) => l.home));
  const side = sum(plain.map((l) => l.importingSide));
  const other = sum(plain.flatMap((l) => l.elsewhere.map((e) => e.files)));
  const otherFolders = new Set(plain.flatMap((l) => l.elsewhere.map((e) => e.folder))).size;
  const what = plain.length === 1 ? path.posix.basename(plain[0].file) : `these ${plain.length} files`;

  let clue: Clue;
  if (home === 0 && other === 0) {
    clue = {
      kind: "move",
      headline: "Move it?",
      reason: `Nothing in ${to} imports ${what}; only ${from} does. It looks misplaced, and moving it into ${from} removes the uphill import.`,
    };
  } else if (home === 0) {
    clue = {
      kind: "move-shared",
      headline: "Move it down?",
      reason: `Nothing in ${to} imports ${what}; ${plural(side, "file")} in ${from} and ${plural(other, "file")} in ${plural(otherFolders, "other folder")} do. It looks like shared code, and moving it to a stable shared folder removes the uphill import.`,
    };
  } else if (home >= side + other) {
    clue = {
      kind: "flip",
      headline: "Flip it?",
      reason: `${home} of the ${home + side + other} files importing ${what} are inside ${to}, so it belongs there. ${from} could own what it needs (a type, an interface or an event) and let ${to} plug into it.`,
    };
  } else {
    clue = {
      kind: "split",
      headline: "Split it?",
      reason: `${what} is imported both inside ${to} (${plural(home, "file")}) and from outside (${plural(side + other, "file")}). Splitting out the part ${from} uses and moving only that part down removes the uphill import.`,
    };
  }
  const added = imports.filter((i) => i.isNew);
  if (added.length > 0 && added.every((i) => i.kind === "type-only")) {
    clue.reason += " Only types cross this link, so moving the type is usually the cheapest fix.";
  }
  return clue;
}

// ---------------------------------------------------------------------------
// Ladder and piece

function makeLadder(
  link: FolderLink,
  stability: Map<string, FolderStability>,
  incoming: Map<string, FolderLink[]>,
  outgoing: Map<string, FolderLink[]>,
): Ladder {
  const entry = (folder: string, role: LadderFolder["role"], imports: number): LadderFolder => {
    const s = stability.get(folder);
    return {
      folder,
      role,
      instability: round2(s?.instability ?? 0),
      afferent: s?.afferent ?? 0,
      efferent: s?.efferent ?? 0,
      files: s?.files ?? 0,
      imports,
    };
  };
  const byWeight = (a: FolderLink, b: FolderLink) =>
    b.imports.length - a.imports.length || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

  const dependents = (incoming.get(link.from) ?? []).filter((l) => l.from !== link.to).sort(byWeight);
  const dependencies = (outgoing.get(link.to) ?? []).filter((l) => l.to !== link.from).sort(byWeight);

  return {
    folders: [
      ...dependents.slice(0, MAX_RELIES_ON_FROM).map((l) => entry(l.from, "relies-on-from", l.imports.length)),
      entry(link.from, "from", link.imports.length),
      entry(link.to, "to", link.imports.length),
      ...dependencies.slice(0, MAX_TO_RELIES_ON).map((l) => entry(l.to, "to-relies-on", l.imports.length)),
    ],
    hiddenReliesOnFrom: Math.max(0, dependents.length - MAX_RELIES_ON_FROM),
    hiddenToReliesOn: Math.max(0, dependencies.length - MAX_TO_RELIES_ON),
  };
}

/**
 * The piece answers the context-window worry: a model gets the files on
 * both sides of the link and a text map of the folders around it, not the
 * whole codebase. Same recipe as the token estimates in the study.
 */
function makePiece(
  link: FolderLink,
  from: FolderStability,
  to: FolderStability,
  dependentFolders: number,
  imports: ImportLine[],
  lens: FileUsers[],
  decision: DecisionRecord | null,
  stability: Map<string, FolderStability>,
  links: Map<string, FolderLink>,
  headText: (file: string) => string | null,
): Piece {
  // The neighbourhood: folders linked to either side, most imports first,
  // capped so a folder that half the codebase imports still gives a small
  // piece. The rest are counted, not listed.
  const weight = new Map<string, number>();
  for (const l of links.values()) {
    const other = l.from === link.from || l.from === link.to ? l.to : l.to === link.from || l.to === link.to ? l.from : null;
    if (other === null || other === link.from || other === link.to) continue;
    weight.set(other, (weight.get(other) ?? 0) + l.imports.length);
  }
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const neighbourhood = new Set<string>([link.from, link.to, ...ranked.slice(0, MAX_MAP_FOLDERS).map(([f]) => f)]);
  const unlisted = Math.max(0, ranked.length - MAX_MAP_FOLDERS);
  const map = [...neighbourhood].sort().map((folder) => {
    const deps = [...links.values()]
      .filter((l) => l.from === folder && neighbourhood.has(l.to))
      .map((l) => l.to)
      .sort();
    const i = stability.get(folder)?.instability ?? 0;
    return `${folder}  I=${i.toFixed(2)}${deps.length ? "  -> " + deps.join(", ") : ""}`;
  });

  // The files behind the imports this change added always go in full. Older
  // ones only while the piece stays small; their import lines are listed
  // above either way.
  const newFiles = new Set(imports.filter((i) => i.isNew).flatMap((i) => [i.from, i.to]));
  const allFiles = [...new Set([...link.imports.map((e) => e.from), ...link.imports.map((e) => e.to)])].sort();
  const files: string[] = allFiles.filter((f) => newFiles.has(f));
  let oldChars = 0;
  for (const f of allFiles) {
    if (newFiles.has(f)) continue;
    const size = headText(f)?.length ?? 0;
    if (oldChars + size > MAX_OLD_FILE_CHARS) continue;
    files.push(f);
    oldChars += size;
  }
  const leftOut = allFiles.length - files.length;
  const decisionLine =
    decision === null
      ? "No decision yet. Say whether to move the file, flip the dependency, or keep the link, and why."
      : decision.decision === "meant"
        ? `The author marked this link as meant when it had ${plural(decision.imports, "import")}; it has ${plural(link.imports.length, "import")} now. Check whether the new ones are meant too.`
        : `The author decided to fix it by ${decision.decision === "move" ? "moving the imported code down" : "flipping the dependency"}${decision.note ? ` (note: ${decision.note})` : ""}.`;

  const text = [
    "One unstable dependency to fix in a TypeScript codebase.",
    "",
    `The link: ${link.from} imports ${link.to}.`,
    `${link.from} has instability ${from.instability.toFixed(2)}; ${plural(from.afferent, "file")} in ${plural(dependentFolders, "other folder")} import it.`,
    `${link.to} has instability ${to.instability.toFixed(2)}: it depends on more and is easier and more likely to change.`,
    "",
    "Imports behind the link:",
    ...imports.map(
      (i) => `- ${i.from}${i.line !== null ? ` line ${i.line}` : ""}: ${i.text ?? `imports ${i.to}`}${i.isNew ? "  (new in this change)" : ""}`,
    ),
    "",
    "Who imports the imported files:",
    ...lens.map(
      (l) =>
        `- ${l.file}: ${l.home} in ${link.to}, ${l.importingSide} in ${link.from}, ${sum(l.elsewhere.map((e) => e.files))} elsewhere` +
        (l.reexports > 0 ? ` (an entry file: it re-exports ${plural(l.reexports, "file")})` : ""),
    ),
    "",
    `Decision: ${decisionLine}`,
    "",
    "Folder map (instability, then the folders it imports):",
    ...map,
    ...(unlisted > 0 ? [`(${plural(unlisted, "more folder")} linked to these two, with fewer imports, not listed)`] : []),
    "",
    "Files:",
    ...files.flatMap((f) => [`=== ${f} ===`, headText(f) ?? "(could not read this file)", ""]),
    ...(leftOut > 0 ? [`(${plural(leftOut, "more file")} behind the link left out to keep this short; their import lines are listed above.)`, ""] : []),
    decision?.decision === "meant"
      ? `Task: say whether keeping this import is safe, and name anything in ${link.to} that ${link.from} should not depend on.`
      : "Task: propose the smallest change that removes this import while keeping behaviour the same. Show every changed file in full, and list any other files whose import paths must change.",
  ].join("\n");

  return { files, mapFolders: neighbourhood.size, tokens: Math.round(text.length / 4), text };
}

// ---------------------------------------------------------------------------

function edgeKey(edge: FileEdge): string {
  return edge.from + "\0" + edge.to;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
