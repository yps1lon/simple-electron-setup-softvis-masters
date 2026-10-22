import { clip, el, hover, legendItem, plural, segmented, svgEl, svgText, tailName } from "./ui.js";

/**
 * The instability-sorted matrix: every folder link in the codebase, rows
 * importing columns, both sorted by instability with the most stable first.
 * Sorting on the one quantity the smell is about puts every uphill link
 * above the diagonal, so the triangle itself is the overview (a matrix for
 * the dense whole, node-link for the small piece: Ghoniem et al. 2005,
 * Okoe et al. 2019).
 *
 * Merging folders to fewer path segments makes big codebases fit, but it
 * hides links, and the counts above the matrix say how many.
 */

const FLAG_NEW = 1;
const FLAG_FLAGGED = 2;
const FLAG_MEANT = 4;

/** The default level: the most detailed one with at most 60 folders. */
export function defaultLevel(matrix) {
  let pick = 0;
  matrix.levels.forEach((level, i) => {
    if (level.folders.length <= 60) pick = i;
  });
  return pick;
}

export function mergeFolder(folder, depth) {
  if (depth === null || folder === ".") return folder;
  const parts = folder.split("/");
  return parts.length <= depth ? folder : parts.slice(0, depth).join("/");
}

/**
 * @param view { levelIndex, selected: {from, to} | null, meant: Set of "from -> to" }
 * @param on   { level(i), pick({from, to, depth}), folder(name) }
 */
export function drawMatrix(container, review, view, on) {
  container.replaceChildren();
  const levels = review.matrix.levels;
  const level = levels[view.levelIndex];
  const full = levels[levels.length - 1];
  const n = level.folders.length;

  // The selection at this depth: its row and column, if it has them.
  const index = new Map(level.folders.map((f, i) => [f.name, i]));
  const sel = view.selected ? { from: mergeFolder(view.selected.from, level.depth), to: mergeFolder(view.selected.to, level.depth) } : null;
  const selRow = sel ? index.get(sel.from) : undefined;
  const selCol = sel ? index.get(sel.to) : undefined;

  const head = el("div", "view-head");
  head.append(
    segmented(
      levels.map((l, i) => ({
        value: i,
        label: l.depth === null ? `every folder (${l.folders.length})` : `depth ${l.depth} (${l.folders.length})`,
        title: l.depth === null ? "Each folder on its own" : `Folders merged to their first ${l.depth} path segments`,
      })),
      view.levelIndex,
      on.level,
      "Folder depth",
    ),
  );
  const summary = el("p", "view-summary");
  summary.textContent =
    `${plural(level.uphill, "folder link")} point uphill here, ${level.uphillBig} of them by ${review.minGap} or more.` +
    (level.depth === null ? "" : ` With every folder on its own: ${full.uphill} and ${full.uphillBig}. Merging hides the rest.`);
  head.append(summary);
  const note = selectionNote(view.selected, sel, selRow, selCol, level, full);
  if (note !== null) head.append(el("p", "view-summary sel-note", note));
  container.append(head);

  const legend = el("div", "legend");
  legend.append(
    legendItem("cell down", "points down or level (darker = more imports)"),
    legendItem("cell up", "points uphill, already there"),
    legendItem("cell change", "uphill link this change added"),
    legendItem("cell new", "holds an import this change added"),
    legendItem("cell meant", "marked meant"),
  );
  container.append(legend);

  // Size: fit the width, but never smaller than 4px a cell (then scroll).
  // Names only where a cell is tall enough to carry one.
  const avail0 = Math.max(240, Math.min((container.clientWidth || 800) - 214, 820));
  const cell = Math.max(4, Math.min(26, Math.floor(avail0 / Math.max(1, n))));
  const labels = cell >= 7;
  const fontSize = Math.min(11, cell - 1);
  const leftW = labels ? 190 : 12;
  const topH = labels ? (cell < 14 ? 150 : 120) : 12;
  const size = cell * n;
  const width = leftW + size + 16;
  const height = topH + size + 16;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "matrix", role: "img" });
  svg.setAttribute("aria-label", `Folder links sorted by instability; ${level.uphill} uphill links above the diagonal`);
  const scroller = el("div", "matrix-scroll");
  scroller.append(svg);
  container.append(scroller);

  const x = (c) => leftW + c * cell;
  const y = (r) => topH + r * cell;
  const inst = level.folders.map((f) => f.instability);
  const maxCount = Math.max(1, ...level.cells.map((c) => c[2]));

  // The selection's row and column, as a faint cross.
  if (selRow !== undefined) svg.append(svgEl("rect", { x: leftW, y: y(selRow), width: size, height: cell, class: "cross" }));
  if (selCol !== undefined) svg.append(svgEl("rect", { x: x(selCol), y: topH, width: cell, height: size, class: "cross" }));

  // Frame and diagonal: below it imports point down, above it uphill.
  svg.append(svgEl("rect", { x: leftW, y: topH, width: size, height: size, class: "frame" }));
  svg.append(svgEl("line", { x1: leftW, y1: topH, x2: leftW + size, y2: topH + size, class: "diagonal" }));
  if (size >= 160) {
    svg.append(svgText("uphill", { x: leftW + size - 6, y: topH + 14, class: "zone", "text-anchor": "end" }));
    svg.append(svgText("down", { x: leftW + 6, y: topH + size - 6, class: "zone" }));
  }

  const meantKey = (from, to) => `${from} -> ${to}`;
  for (const [r, c, count, flags] of level.cells) {
    const gap = inst[c] - inst[r];
    const from = level.folders[r].name;
    const to = level.folders[c].name;
    const meant = (flags & FLAG_MEANT) !== 0 || view.meant.has(meantKey(from, to));
    let cls = "cell down";
    let opacity = 0.25 + 0.65 * (Math.log(1 + count) / Math.log(1 + maxCount));
    if (gap > 1e-9) {
      cls = flags & FLAG_FLAGGED ? "cell change" : "cell up";
      opacity = flags & FLAG_FLAGGED ? 1 : 0.55;
    }
    const pad = cell >= 8 ? 1 : 0.5;
    const rect = svgEl("rect", { x: x(c) + pad, y: y(r) + pad, width: cell - 2 * pad, height: cell - 2 * pad, class: cls, "fill-opacity": opacity.toFixed(2) });
    if (meant) rect.classList.add("meant");
    svg.append(rect);
    if (flags & FLAG_NEW && cell >= 6) {
      svg.append(svgEl("circle", { cx: x(c) + cell / 2, cy: y(r) + cell / 2, r: Math.max(1.2, cell / 7), class: "new-dot" }));
    }
    // A hit area on top, so small cells are easy to hover and click.
    const hit = svgEl("rect", { x: x(c), y: y(r), width: cell, height: cell, class: "hit" });
    hover(hit, () =>
      `${from} → ${to}\n${plural(count, "file import")}\n` +
      `I ${inst[r].toFixed(2)} → ${inst[c].toFixed(2)}: ${gap > 1e-9 ? `uphill by ${gap.toFixed(2)}` : "points down or level"}` +
      (flags & FLAG_FLAGGED ? "\nflagged in this change" : flags & FLAG_NEW ? "\nthis change added an import here" : "") +
      (meant ? "\nmarked meant" : ""),
    );
    hit.addEventListener("click", () => on.pick({ from, to, depth: level.depth }));
    svg.append(hit);
  }

  if (selRow !== undefined && selCol !== undefined) {
    svg.append(svgEl("rect", { x: x(selCol) - 1, y: y(selRow) - 1, width: cell + 2, height: cell + 2, class: "selected-cell" }));
  }

  if (labels) {
    level.folders.forEach((f, i) => {
      const rowLabel = svgText(clip(tailName(f.name, 3), 28), {
        x: leftW - 6, y: y(i) + cell / 2 + fontSize / 2.8, class: `row-label${i === selRow ? " on" : ""}`, "text-anchor": "end",
        style: `font-size:${fontSize}px`,
      });
      rowLabel.addEventListener("click", () => on.folder(f.name, level.depth));
      hover(rowLabel, () => `${f.name}\nI ${f.instability.toFixed(2)} · ${plural(f.files, "file")} · imported by ${plural(f.afferent, "file")}\nclick: its history`);
      svg.append(rowLabel);
      const cx = x(i) + cell / 2 + fontSize / 2.8;
      svg.append(svgText(clip(tailName(f.name, 2), cell < 14 ? 26 : 20), {
        x: cx, y: topH - 6, class: `col-label${i === selCol ? " on" : ""}`, style: `font-size:${fontSize}px`,
        transform: `rotate(${cell < 14 ? -90 : -55} ${cx} ${topH - 6})`,
      }));
    });
  }

  container.append(el("p", "caption",
    "Rows import columns. Both are sorted by instability, most stable first, so a link from a stable folder to a less stable one lands above the diagonal. " +
    "Click a cell to select that link in every view."));
}

/**
 * Merging folders can hide the selected link or turn it around: say so,
 * rather than leave the selection sitting below the diagonal unexplained.
 */
function selectionNote(selected, sel, row, col, level, full) {
  if (selected === null || level.depth === null || row === undefined || col === undefined) return null;
  const fullIndex = new Map(full.folders.map((f, i) => [f.name, i]));
  const a0 = full.folders[fullIndex.get(selected.from)]?.instability;
  const b0 = full.folders[fullIndex.get(selected.to)]?.instability;
  const upOnItsOwn = a0 !== undefined && b0 !== undefined && b0 - a0 > 1e-9;
  if (row === col) {
    return `At this depth both folders of the selected link fall into ${sel.from}, so the link is hidden.` +
      (upOnItsOwn ? " With every folder on its own it points uphill." : "");
  }
  const a = level.folders[row].instability;
  const b = level.folders[col].instability;
  if (b - a > 1e-9) return null;
  return `At this depth the selected link is not uphill: merged, ${sel.to} (I ${b.toFixed(2)}) is at least as stable as ${sel.from} (I ${a.toFixed(2)}).` +
    (upOnItsOwn ? " With every folder on its own it points uphill." : "");
}
