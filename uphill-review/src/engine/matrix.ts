import { folderLinks, folderOf, folderStability, linkKey, mergeFolder } from "./stability.js";
import type { DecisionRecord, MatrixCell, MatrixData, MatrixLevel, ReviewLink, Snapshot } from "./types.js";

/**
 * The instability-sorted matrix: every folder link in the codebase at the
 * head, rows importing columns. Rows and columns are sorted by instability
 * (stable first, ties by name), so a link from a stable folder to a less
 * stable one always lands above the diagonal: every uphill link falls in
 * one triangle.
 *
 * One level per folder depth: at depth d every folder is merged into its
 * first d path segments, and instability is counted again at that depth.
 * Merging hides links (imports inside a merged folder are no longer
 * links), which is why the level with every folder itself is always there.
 */

export const CELL_NEW = 1;
export const CELL_FLAGGED = 2;
export const CELL_MEANT = 4;

export function buildMatrix(
  head: Snapshot,
  base: Snapshot,
  flagged: ReviewLink[],
  decisions: DecisionRecord[],
  minGap: number,
): MatrixData {
  const folders = new Set(head.files.map(folderOf));
  const maxDepth = Math.max(1, ...[...folders].map((f) => (f === "." ? 1 : f.split("/").length)));
  const baseEdges = new Set(base.edges.map((e) => e.from + "\0" + e.to));
  const levels: MatrixLevel[] = [];
  // Merged depths first; skip one that merges nothing more than the one
  // before, has a single folder, or already equals the full level.
  let lastSize = -1;
  for (let depth = 1; depth < maxDepth; depth++) {
    const group = (folder: string) => mergeFolder(folder, depth);
    const size = new Set([...folders].map(group)).size;
    if (size === lastSize || size < 2 || size === folders.size) continue;
    lastSize = size;
    levels.push(level(head, baseEdges, flagged, decisions, minGap, depth, group));
  }
  levels.push(level(head, baseEdges, flagged, decisions, minGap, null, (f) => f));
  return { levels };
}

function level(
  head: Snapshot,
  baseEdges: Set<string>,
  flagged: ReviewLink[],
  decisions: DecisionRecord[],
  minGap: number,
  depth: number | null,
  group: (folder: string) => string,
): MatrixLevel {
  const stability = folderStability(head.files, head.edges, group);
  const order = [...stability.values()].sort(
    (a, b) => a.instability - b.instability || a.folder.localeCompare(b.folder),
  );
  const index = new Map(order.map((f, i) => [f.folder, i]));
  const flaggedCells = new Set(flagged.map((l) => linkKey(group(l.from), group(l.to))));
  const meantCells = new Set(
    decisions.filter((d) => d.decision === "meant").map((d) => linkKey(group(d.from), group(d.to))),
  );

  const cells: MatrixCell[] = [];
  let uphill = 0;
  let uphillBig = 0;
  for (const link of folderLinks(head.edges, group).values()) {
    const row = index.get(link.from);
    const col = index.get(link.to);
    if (row === undefined || col === undefined) continue;
    const key = linkKey(link.from, link.to);
    let flags = 0;
    if (link.imports.some((e) => !baseEdges.has(e.from + "\0" + e.to))) flags |= CELL_NEW;
    if (flaggedCells.has(key)) flags |= CELL_FLAGGED;
    if (meantCells.has(key)) flags |= CELL_MEANT;
    cells.push([row, col, link.imports.length, flags]);
    const gap = order[col].instability - order[row].instability;
    if (gap > 1e-9) uphill++;
    if (gap >= minGap - 1e-9) uphillBig++;
  }
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  return {
    depth,
    folders: order.map((f) => ({
      name: f.folder,
      instability: Math.round(f.instability * 1000) / 1000,
      afferent: f.afferent,
      efferent: f.efferent,
      files: f.files,
    })),
    cells,
    uphill,
    uphillBig,
  };
}
