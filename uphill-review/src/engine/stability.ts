import type { FileEdge } from "./types.js";

/**
 * Folder stability, measured the same way as the replay of the ten
 * codebases, so numbers from the tool and from the study mean the same:
 *
 * - a folder is a file's own directory (no rolling up to modules)
 * - Martin's instability I = Ce / (Ca + Ce), counted in FILES:
 *   Ca = files outside the folder that import something inside it,
 *   Ce = files inside the folder that import something outside it
 * - a folder link from -> to is uphill when I(to) > I(from): code that
 *   much relies on starts to depend on code that is easy and likely to
 *   change (the stable-dependencies principle, Martin 2003)
 *
 * `group` merges folders to fewer path segments for the overview; the
 * definitions stay the same at every depth.
 */

/** A file's folder: its directory, "." for files at the repository root. */
export function folderOf(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut === -1 ? "." : file.slice(0, cut);
}

/** A folder merged to its first `depth` path segments (null: unchanged). */
export function mergeFolder(folder: string, depth: number | null): string {
  if (depth === null || folder === ".") return folder;
  const parts = folder.split("/");
  return parts.length <= depth ? folder : parts.slice(0, depth).join("/");
}

export interface FolderStability {
  folder: string;
  files: number;
  /** Ca: files outside the folder that import something in it. */
  afferent: number;
  /** Ce: files inside the folder that import something outside it. */
  efferent: number;
  /** Ce / (Ca + Ce); 0 when the folder has no links across its border. */
  instability: number;
}

export function folderStability(
  files: string[],
  edges: FileEdge[],
  group: (folder: string) => string = (f) => f,
): Map<string, FolderStability> {
  const of = (file: string) => group(folderOf(file));
  const fileCount = new Map<string, number>();
  for (const file of files) fileCount.set(of(file), (fileCount.get(of(file)) ?? 0) + 1);
  const afferent = new Map<string, Set<string>>();
  const efferent = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = of(edge.from);
    const to = of(edge.to);
    if (from === to) continue;
    addTo(afferent, to, edge.from);
    addTo(efferent, from, edge.from);
  }
  const result = new Map<string, FolderStability>();
  for (const [folder, count] of fileCount) {
    const ca = afferent.get(folder)?.size ?? 0;
    const ce = efferent.get(folder)?.size ?? 0;
    result.set(folder, {
      folder,
      files: count,
      afferent: ca,
      efferent: ce,
      instability: ca + ce === 0 ? 0 : ce / (ca + ce),
    });
  }
  return result;
}

/** All file imports from one folder to another. */
export interface FolderLink {
  from: string;
  to: string;
  imports: FileEdge[];
}

/** Folder links keyed by linkKey(from, to); imports inside a folder are not links. */
export function folderLinks(
  edges: FileEdge[],
  group: (folder: string) => string = (f) => f,
): Map<string, FolderLink> {
  const links = new Map<string, FolderLink>();
  for (const edge of edges) {
    const from = group(folderOf(edge.from));
    const to = group(folderOf(edge.to));
    if (from === to) continue;
    const key = linkKey(from, to);
    let link = links.get(key);
    if (link === undefined) {
      link = { from, to, imports: [] };
      links.set(key, link);
    }
    link.imports.push(edge);
  }
  return links;
}

export function linkKey(from: string, to: string): string {
  return from + "\0" + to;
}

/**
 * A folder that imports its own subfolder (an index file re-exporting it,
 * say) is uphill almost by construction: the subfolder has one importer, its
 * parent. In the replay of ten codebases 45% of new uphill links were of
 * this kind, and 87% of those were still there after six months (62% for
 * sideways links), so the view keeps the two kinds apart.
 */
export function uphillKind(from: string, to: string): "sideways" | "into-subfolder" {
  return from === "." || to.startsWith(from + "/") ? "into-subfolder" : "sideways";
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
}
