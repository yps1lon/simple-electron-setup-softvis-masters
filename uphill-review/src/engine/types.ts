/**
 * The contract between the engine (src/engine) and the UI (src/renderer).
 *
 * It imports nothing, so both halves can rely on it. The UI is plain
 * JavaScript and reads these shapes from what main hands over the preload
 * bridge; change a shape here and check the renderer too.
 *
 * Words used throughout:
 * - folder: a file's own directory; folders are the modules (no rolling up)
 * - instability I = Ce / (Ca + Ce), counted in files (Martin): Ca = files
 *   outside the folder that import it, Ce = files inside that import outside
 * - uphill: a folder link from -> to where I(to) > I(from), i.e. code that
 *   much relies on starts to depend on code that is easier to change
 * - gap = I(to) - I(from)
 */

/**
 * How an import is used, as in the study's replay:
 * - type-only: erased at compile time (`import type`, or only used as a type)
 * - deferred: a value used only inside functions (or `import()`)
 * - load-time: a value used when the module loads, or a side-effect import
 * - re-export: `export ... from`
 */
export type ImportKind = "type-only" | "deferred" | "load-time" | "re-export";

/** A file-level import: `from` imports `to` (repo-relative paths). */
export interface FileEdge {
  from: string;
  to: string;
  kind: ImportKind;
  /** 1-based line of the first statement in `from` that imports `to`. */
  line?: number;
}

/**
 * The import graph at one commit. Architecture files only: tests, stories,
 * fixtures and generated code are left out, because tests import a lot of
 * folders and would make every folder they touch look more stable.
 */
export interface Snapshot {
  /** Full commit hash, or "" for the empty tree before the first commit. */
  commit: string;
  files: string[];
  edges: FileEdge[];
}

/** Who made a commit, read from its author and trailers. */
export type AuthorClass = "agent" | "human" | "bot";

/** A commit as the views show it. */
export interface CommitRef {
  /** First 10 characters of the hash. */
  sha: string;
  /** YYYY-MM-DD, committer date. */
  date: string;
  subject: string;
  author: string;
  /** "agent" = agent-assisted: a coding-agent trailer or author. */
  cls: AuthorClass;
  /** The agents named, e.g. ["claude"]. */
  tools: string[];
}

// ---------------------------------------------------------------------------
// Decisions: the intended architecture, written one decision at a time

/**
 * What the author of a change decided about one uphill folder link.
 * - meant: intended; later reviews stay quiet until the link grows
 * - move:  fix by moving the imported code down to where it belongs
 * - flip:  fix by inverting the dependency (the stable side owns an
 *          interface, a type or an event; the unstable side plugs in)
 */
export type Decision = "meant" | "move" | "flip";

/**
 * One decision as stored in the YAML file. Written only when a person clicks
 * a decision; the tool never adds one on its own.
 */
export interface DecisionRecord {
  from: string;
  to: string;
  decision: Decision;
  /** Free text from the author, may be empty. */
  note: string;
  /** git user.name in the reviewed repository. */
  by: string;
  /** YYYY-MM-DD, local time. */
  date: string;
  /** The change it was decided on, e.g. "main..ai/discount-banner". */
  change: string;
  /** File imports on the link when it was decided, so growth can be noticed. */
  imports: number;
}

// ---------------------------------------------------------------------------
// The review of one change

/** One file-level import behind a folder link. */
export interface ImportLine {
  from: string;
  to: string;
  kind: ImportKind;
  /** 1-based line of the import statement, when it could be found. */
  line: number | null;
  /** The statement, whitespace collapsed, when it could be found. */
  text: string | null;
  /** Added by the reviewed change (not there at the base). */
  isNew: boolean;
  /** The commit that added it, when it was added inside the history window. */
  commit: CommitRef | null;
}

/**
 * The cohesion lens: who imports one of the imported files. Files in its own
 * folder, files in the importing folder, and files elsewhere.
 */
export interface FileUsers {
  file: string;
  /** Importers inside the file's own folder (`to`). */
  home: number;
  /** Importers inside the importing folder (`from`). */
  importingSide: number;
  /** Importers in any other folder, largest first. */
  elsewhere: { folder: string; files: number }[];
  /**
   * Files this file re-exports. More than 0 means an entry file (such as a
   * package's index.ts): the counts are for the front door, not the code
   * behind it, so moving it is not a fix.
   */
  reexports: number;
}

export type ClueKind = "move" | "move-shared" | "flip" | "split" | "subfolder";

/** What the lens suggests. A hint for the author, not a verdict. */
export interface Clue {
  kind: ClueKind;
  /** Short question shown on the card, e.g. "Move it?". */
  headline: string;
  /** One or two plain sentences with the counts behind the headline. */
  reason: string;
}

export type LadderRole = "relies-on-from" | "from" | "to" | "to-relies-on";

export interface LadderFolder {
  folder: string;
  role: LadderRole;
  instability: number;
  /** Ca: files outside that import this folder (its exposure). */
  afferent: number;
  efferent: number;
  files: number;
  /** File imports between this folder and the link folder it is drawn next to. */
  imports: number;
}

/** The neighbourhood drawn on the stability ladder. */
export interface Ladder {
  folders: LadderFolder[];
  /** Folders that import `from` but were left out to keep the picture small. */
  hiddenReliesOnFrom: number;
  /** Folders `to` imports that were left out. */
  hiddenToReliesOn: number;
}

/**
 * The piece: everything a model needs to work on this one link, and nothing
 * else. Tokens are estimated as characters / 4.
 */
export interface Piece {
  files: string[];
  mapFolders: number;
  tokens: number;
  text: string;
}

/** One uphill folder link that the reviewed change created or grew. */
export interface ReviewLink {
  /** `${from} -> ${to}` */
  id: string;
  from: string;
  to: string;
  fromInstability: number;
  toInstability: number;
  /** toInstability - fromInstability, at least minGap here. */
  gap: number;
  /** A folder importing its own subfolder (often meant), or anything else. */
  kind: "sideways" | "into-subfolder";
  /** true when `from` did not import `to` at all before the change. */
  isNewLink: boolean;
  /** true when `to` also imports `from`: the two folders depend on each other. */
  loop: boolean;
  /** Every file import behind the link at the head, the new ones first. */
  imports: ImportLine[];
  /** How much relies on `from`: importing files and folders outside it. */
  reliedOnBy: { files: number; folders: number };
  lens: FileUsers[];
  clue: Clue;
  ladder: Ladder;
  piece: Piece;
  /** The recorded decision for this folder pair, if any. */
  decision: DecisionRecord | null;
  /** Marked meant earlier, but it has more imports now: asked again. */
  grew: boolean;
}

// ---------------------------------------------------------------------------
// The whole codebase: the instability-sorted matrix

export interface MatrixFolder {
  name: string;
  instability: number;
  afferent: number;
  efferent: number;
  files: number;
}

/**
 * One non-empty cell: [row, column, file imports, flags]. The row folder
 * imports the column folder. Flags: 1 = holds an import the change added,
 * 2 = holds a link flagged in this change, 4 = holds a link marked meant.
 */
export type MatrixCell = [number, number, number, number];

/**
 * The matrix at one folder depth. Folders are sorted by instability (stable
 * first, ties by name), so every uphill link lies above the diagonal.
 */
export interface MatrixLevel {
  /** Folders merged to this many path segments; null = every folder itself. */
  depth: number | null;
  folders: MatrixFolder[];
  cells: MatrixCell[];
  /** Folder links that point uphill at this depth, and those with gap >= minGap. */
  uphill: number;
  uphillBig: number;
}

export interface MatrixData {
  levels: MatrixLevel[];
}

// ---------------------------------------------------------------------------
// History: the stability race

export type BirthCause = "new import" | "drift" | "moved";

/**
 * A folder link turning uphill inside the history window. "new import": a
 * commit added the first import between the two folders while it pointed
 * uphill. "drift": the link was there and the instabilities moved. "moved":
 * files were renamed across folders in that commit.
 */
export interface Birth {
  from: string;
  to: string;
  /** YYYY-MM */
  month: string;
  cause: BirthCause;
  /** Gap and file imports right after the commit. */
  gap: number;
  imports: number;
  commit: CommitRef;
}

export interface HistoryData {
  /** YYYY-MM, oldest first; the last month ends at the reviewed commit. */
  months: string[];
  /** Folder -> instability at the end of each month; null when it had no files. */
  instability: Record<string, (number | null)[]>;
  /** "from -> to" -> file imports at the end of each month. */
  links: Record<string, number[]>;
  births: Birth[];
  /** Commits replayed in the window, and how many were agent-assisted. */
  commits: number;
  agentCommits: number;
}

export interface ReviewResult {
  /** Repository root on disk, forward slashes (for opening files). */
  root: string;
  base: { ref: string; commit: string };
  head: { ref: string; commit: string };
  /** The YAML file decisions are written to. */
  decisionsFile: string;
  /** Smallest instability gap that is flagged. */
  minGap: number;
  /** Links flagged in this change, undecided first. */
  links: ReviewLink[];
  matrix: MatrixData;
  history: HistoryData;
  stats: {
    /** Commits in the change (base..head). Zero means nothing to review. */
    commits: number;
    /** Of those, agent-assisted. */
    agentCommits: number;
    /** Architecture files at the head. */
    files: number;
    /** File imports the change added. */
    newImports: number;
    flagged: number;
    sideways: number;
    intoSubfolder: number;
    decided: number;
    /** Links marked meant earlier that the change touched without growing them. */
    quiet: number;
  };
}
