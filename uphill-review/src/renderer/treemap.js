import { hierarchy, treemap } from "d3-hierarchy";
import { el, hover, plural, segmented, svgEl } from "./ui.js";

/**
 * A treemap of the folders at one depth. Area is how many architecture
 * files the folder holds. Colour is instability, grey at 0 and red at 1,
 * so a dependency that runs from a greyer cell into a redder one is uphill.
 *
 * Every dependency is an arrow, thicker when more files import across it,
 * with that count written on the line. Steepness hides arrows that do not
 * climb by at least the chosen gap: 0.2 to 0.8 is a steepness of 0.6.
 */

const STABLE = [110, 110, 114];
const UNSTABLE = [229, 72, 77];
const LINK = "#5aa2ff";
const LINK_ON = "#e7f1ff";

/**
 * @param view { levelIndex, steepness, selected: {from, to} | null, focus: folder name | null }
 * @param on   { level(i), steepness(value), pick(folderName), link({from, to}) }
 */
export function drawTreemap(container, review, view, on) {
  container.replaceChildren();
  const levels = review.matrix.levels;
  const level = levels[Math.min(view.levelIndex, levels.length - 1)];
  const depth = level.depth;
  const steepness = view.steepness ?? 0;

  const head = el("div", "view-head");
  head.append(segmented(
    levels.map((l, i) => ({
      value: i,
      label: l.depth === null ? `every folder (${l.folders.length})` : `depth ${l.depth} (${l.folders.length})`,
      title: l.depth === null ? "Each folder on its own" : `Folders merged to their first ${l.depth} path segments`,
    })),
    view.levelIndex,
    on.level,
    "Folder depth",
  ));
  head.append(
    el("span", "lbl", "steepness"),
    segmented(
      [
        { value: 0, label: "all", title: "Every dependency between these folders" },
        { value: 0.2, label: "0.2", title: "Only links that run uphill by 0.2 or more" },
        { value: 0.4, label: "0.4", title: "Only links that run uphill by 0.4 or more" },
        { value: 0.6, label: "0.6", title: "Only links that run uphill by 0.6 or more" },
        { value: 0.8, label: "0.8", title: "Only links that run uphill by 0.8 or more" },
      ],
      steepness,
      on.steepness,
      "Uphill steepness",
    ),
  );
  container.append(head);

  if (level.folders.length === 0) {
    container.append(el("p", "empty", "This repository has no architecture files to map."));
    return;
  }

  const tree = codebaseTree(level.folders);
  const width = Math.max(280, Math.floor(container.clientWidth || 640));
  const height = Math.max(380, Math.min(620, Math.round(width * 0.8)));
  const root = treemap().size([width, height]).padding(2).round(true)(
    hierarchy(tree).sum((d) => d.value || 0).sort((a, b) => b.value - a.value),
  );
  const leaves = root.leaves().filter((d) => d.value > 0 && d.data.folder);
  const byName = new Map(leaves.map((d) => [d.data.folder.name, d]));

  const edges = [];
  let maxCount = 1;
  for (const [row, col, count] of level.cells) {
    const from = level.folders[row];
    const to = level.folders[col];
    if (from.name === to.name) continue;
    const gap = to.instability - from.instability;
    if (steepness > 0 && gap < steepness - 1e-9) continue;
    const source = byName.get(from.name);
    const target = byName.get(to.name);
    if (source === undefined || target === undefined) continue;
    maxCount = Math.max(maxCount, count);
    edges.push({ from, to, count, gap, source, target });
  }
  edges.sort((a, b) => a.count - b.count);

  const files = level.folders.reduce((n, f) => n + f.files, 0);
  const summary = el("p", "view-summary",
    `${plural(files, "architecture file")} in ${plural(level.folders.length, "folder")}. ` +
    "Colour is instability: grey is stable (0), red is unstable (1). " +
    "An arrow runs from the folder that imports to the folder it imports. " +
    `Thickness is how many files import across it. ${edges.length} of ${level.cells.length} dependencies shown` +
    (steepness > 0 ? `, uphill by ${steepness.toFixed(1)} or more.` : "."));
  container.append(summary);
  container.append(instabilityScale());

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "treemap",
    role: "img",
  });
  svg.setAttribute("aria-label",
    `Treemap of ${plural(level.folders.length, "folder")} coloured by instability, with ${edges.length} dependency arrows`);
  container.append(svg);
  svg.append(arrowMarker("treemap-arrow", LINK), arrowMarker("treemap-arrow-on", LINK_ON));

  const selectedFrom = view.selected ? view.selected.from : null;
  const selectedTo = view.selected ? view.selected.to : null;
  const sameEnds = (edge) => edge.from.name === selectedFrom && edge.to.name === selectedTo
    || (selectedFrom !== null && mergeAt(selectedFrom, depth) === edge.from.name && mergeAt(selectedTo, depth) === edge.to.name);

  leaves.forEach((d, i) => {
    const folder = d.data.folder;
    const w = Math.max(0, d.x1 - d.x0);
    const h = Math.max(0, d.y1 - d.y0);
    const g = svgEl("g", { transform: `translate(${d.x0},${d.y0})` });
    const rect = svgEl("rect", {
      class: "leaf",
      width: w,
      height: h,
      fill: instabilityColour(folder.instability),
      role: "button",
      tabindex: "0",
      "aria-label": `${where(folder)}, instability ${folder.instability.toFixed(2)}, ${plural(folder.files, "file")}`,
    });
    hover(rect, () => tip(folder));
    const activate = () => on.pick(folder.name);
    rect.addEventListener("click", activate);
    rect.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    g.append(rect);
    svg.append(g);
    d._box = { w, h, i };
  });

  const links = svgEl("g", { class: "deps" });
  svg.append(links);
  for (const edge of edges) {
    const on = sameEnds(edge);
    drawEdge(links, edge, maxCount, on, () => on.link({ from: edge.from.name, to: edge.to.name }));
  }

  leaves.forEach((d) => {
    const { w, h, i } = d._box;
    if (w < 36 || h < 18) return;
    const g = svgEl("g", { transform: `translate(${d.x0},${d.y0})`, class: "leaf-label" });
    const clipId = `treemap-clip-${i}`;
    const clip = svgEl("clipPath", { id: clipId });
    clip.append(svgEl("rect", { x: 1, y: 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2) }));
    g.append(clip);
    const text = svgEl("text", { "clip-path": `url(#${clipId})` });
    const name = svgEl("tspan", { x: 4, y: 14 });
    name.textContent = labelOf(d.data.name);
    text.append(name);
    if (h >= 30) {
      const count = svgEl("tspan", { x: 4, y: 26, class: "count" });
      count.textContent = `I ${d.data.folder.instability.toFixed(2)}`;
      text.append(count);
    }
    g.append(text);
    svg.append(g);
  });

  const selected = edges.find(sameEnds);
  if (view.focus) {
    const leaf = byName.get(view.focus);
    if (leaf) ring(svg, leaf, "focus");
  }
  if (selected) {
    ring(svg, selected.source, "end");
    ring(svg, selected.target, "end");
  }
}

function drawEdge(parent, edge, maxCount, selected, onClick) {
  const a = center(edge.source);
  const b = center(edge.target);
  const line = shorten(a.x, a.y, b.x, b.y, 16);
  const width = (1.25 + (edge.count / maxCount) * 4).toFixed(2);
  const path = svgEl("line", {
    class: selected ? "dep on" : "dep",
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
    "stroke-width": width,
    "marker-end": selected ? "url(#treemap-arrow-on)" : "url(#treemap-arrow)",
  });
  const hit = svgEl("line", {
    class: "dep-hit",
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
    role: "button",
    tabindex: "0",
    "aria-label": `${edge.from.name} imports ${edge.to.name}, ${plural(edge.count, "file")}, steepness ${edge.gap.toFixed(2)}`,
  });
  const text = () => edgeTip(edge);
  hover(hit, text);
  const activate = () => onClick();
  hit.addEventListener("click", (event) => {
    event.stopPropagation();
    activate();
  });
  hit.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  parent.append(path, hit);

  const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  if (len < 46) return;
  const weight = svgEl("text", {
    class: "weight",
    x: line.x1 + (line.x2 - line.x1) * 0.55,
    y: line.y1 + (line.y2 - line.y1) * 0.55,
    "text-anchor": "middle",
  });
  weight.textContent = String(edge.count);
  parent.append(weight);
}

function instabilityScale() {
  const row = el("div", "legend instability-scale");
  row.append(el("span", "", "0"));
  row.append(el("i", "scale-bar"));
  row.append(el("span", "", "1 instability"));
  return row;
}

function arrowMarker(id, fill) {
  const marker = svgEl("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto",
  });
  marker.append(svgEl("path", { d: "M 0 1.2 L 10 5 L 0 8.8 z", fill }));
  return marker;
}

function ring(svg, leaf, kind) {
  const w = Math.max(0, leaf.x1 - leaf.x0);
  const h = Math.max(0, leaf.y1 - leaf.y0);
  svg.append(svgEl("rect", {
    class: kind,
    x: leaf.x0 + 1.5,
    y: leaf.y0 + 1.5,
    width: Math.max(0, w - 3),
    height: Math.max(0, h - 3),
  }));
}

function center(leaf) {
  return { x: (leaf.x0 + leaf.x1) / 2, y: (leaf.y0 + leaf.y1) / 2 };
}

function shorten(x1, y1, x2, y2, pad) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const cut = Math.min(pad, len * 0.42);
  return { x1: x1 + ux * 6, y1: y1 + uy * 6, x2: x2 - ux * cut, y2: y2 - uy * cut };
}

function instabilityColour(value) {
  const t = Math.min(1, Math.max(0, value));
  const mix = STABLE.map((channel, i) => Math.round(channel + (UNSTABLE[i] - channel) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function tip(folder) {
  return [
    where(folder),
    `${plural(folder.files, "architecture file")} · instability ${folder.instability.toFixed(2)}`,
    `imported by ${plural(folder.afferent, "file")} · imports ${plural(folder.efferent, "file")} outside`,
  ].join("\n");
}

function edgeTip(edge) {
  const direction = edge.gap > 1e-9
    ? `uphill by ${edge.gap.toFixed(2)}`
    : edge.gap < -1e-9
      ? `downhill by ${Math.abs(edge.gap).toFixed(2)}`
      : "level";
  return [
    `${edge.from.name} → ${edge.to.name}`,
    `${plural(edge.count, "file import")} · ${direction}`,
    `I ${edge.from.instability.toFixed(2)} → I ${edge.to.instability.toFixed(2)}`,
  ].join("\n");
}

function where(folder) {
  return folder.name === "." ? "repository root" : folder.name;
}

function labelOf(name) {
  if (name === "." || name === "") return "root";
  return name.split("/").pop();
}

/** Folder name at this matrix depth. `null` depth leaves the name unchanged. */
function mergeAt(folder, depth) {
  if (depth === null || folder === ".") return folder;
  const parts = folder.split("/");
  return parts.length <= depth ? folder : parts.slice(0, depth).join("/");
}

/** Nested folders from the flat matrix list. A folder that has both files and subfolders keeps its own files as a cell inside the group. */
function codebaseTree(folders) {
  const root = { name: "", path: "", children: new Map(), folder: null };
  for (const folder of folders) {
    if (!folder.files) continue;
    const parts = folder.name === "." ? ["."] : folder.name.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let child = node.children.get(part);
      if (child === undefined) {
        const path = folder.name === "." ? "." : parts.slice(0, i + 1).join("/");
        child = { name: part, path, children: new Map(), folder: null };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.folder = folder;
      node = child;
    }
  }
  return toNode(root);
}

function toNode(node) {
  const children = [...node.children.values()].map(toNode);
  if (node.folder && children.length > 0) {
    children.push({
      name: node.name,
      path: node.folder.name,
      value: node.folder.files,
      folder: node.folder,
    });
  }
  if (children.length === 0) {
    return {
      name: node.name,
      path: node.folder ? node.folder.name : node.path,
      value: node.folder ? node.folder.files : 0,
      folder: node.folder,
    };
  }
  return { name: node.name || "codebase", path: node.path, children };
}
