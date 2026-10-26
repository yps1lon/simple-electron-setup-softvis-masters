import { hierarchy, treemap } from "d3-hierarchy";
import { mergeFolder } from "./matrix.js";
import { el, hover, plural, segmented, svgEl } from "./ui.js";

/**
 * A treemap of the whole codebase, laid out the way the D3 treemap is
 * (squarify, one rectangle per folder, area = a quantity, colour = which
 * group the folder belongs to). Here the quantity is architecture files,
 * and the group is the part of the tree you can still tell apart: usually
 * src/core, src/features, src/ui, and so on, rather than one colour for
 * all of src.
 *
 * Red is not a group colour. It stays the outline of an uphill link, the
 * same alarm as the other views. The thicker outline is the link selected
 * in the list.
 */

// Light fills so the labels stay dark and the map reads as the bright
// object on the dark desk. Red is left out on purpose.
const AREA_COLOURS = [
  "#8fb4d9",
  "#9dcea0",
  "#f0c48a",
  "#d7c36a",
  "#a9d4d1",
  "#d4b4d0",
  "#d2b8a6",
  "#b7c3e3",
  "#c5d6a1",
  "#c8beb4",
];

/**
 * @param view { levelIndex, selected: {from, to} | null, focus: folder name | null }
 * @param on   { level(i), pick(folderName) }
 */
export function drawTreemap(container, review, view, on) {
  container.replaceChildren();
  const levels = review.matrix.levels;
  const level = levels[Math.min(view.levelIndex, levels.length - 1)];
  const depth = level.depth;

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
  const files = level.folders.reduce((n, f) => n + f.files, 0);
  head.append(el("p", "view-summary",
    `${plural(files, "architecture file")} in ${plural(level.folders.length, "folder")}. ` +
    "Area is how many files sit in a folder. Colour is which part of the codebase that folder belongs to. " +
    "A red outline marks a folder in an uphill link this change added, and a thicker one is the link you have selected."));
  container.append(head);

  if (level.folders.length === 0) {
    container.append(el("p", "empty", "This repository has no architecture files to map."));
    return;
  }

  const tree = codebaseTree(level.folders);
  const width = Math.max(280, Math.floor(container.clientWidth || 640));
  const height = Math.max(380, Math.min(620, Math.round(width * 0.8)));
  const root = treemap().size([width, height]).padding(1).round(true)(
    hierarchy(tree).sum((d) => d.value || 0).sort((a, b) => b.value - a.value),
  );
  const groupDepth = groupingDepth(root);
  const leaves = root.leaves().filter((d) => d.value > 0 && d.data.folder);

  const areaOf = (leaf) => {
    let node = leaf;
    while (node.parent && node.depth > groupDepth + 1) node = node.parent;
    return node.data.path || node.data.name;
  };
  const areaNames = [...new Set(leaves.map(areaOf))].sort((a, b) => a.localeCompare(b));
  const colourOf = new Map(areaNames.map((name, i) => [name, areaColour(i)]));
  const areaFiles = new Map();
  for (const leaf of leaves) {
    const area = areaOf(leaf);
    areaFiles.set(area, (areaFiles.get(area) ?? 0) + leaf.value);
  }

  const legend = el("div", "legend");
  for (const [name, count] of [...areaFiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    legend.append(swatch(colourOf.get(name), `${labelOf(name)} (${count})`));
  }
  container.append(legend);

  const flagged = new Set();
  for (const link of review.links) {
    flagged.add(mergeFolder(link.from, depth));
    flagged.add(mergeFolder(link.to, depth));
  }
  const selectedFrom = view.selected ? mergeFolder(view.selected.from, depth) : null;
  const selectedTo = view.selected ? mergeFolder(view.selected.to, depth) : null;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "treemap",
    role: "img",
  });
  svg.setAttribute("aria-label", `Treemap of ${plural(level.folders.length, "folder")}, sized by architecture files`);
  container.append(svg);

  leaves.forEach((d, i) => {
    const folder = d.data.folder;
    const w = Math.max(0, d.x1 - d.x0);
    const h = Math.max(0, d.y1 - d.y0);
    const g = svgEl("g", { transform: `translate(${d.x0},${d.y0})` });
    const rect = svgEl("rect", {
      class: "leaf",
      width: w,
      height: h,
      fill: colourOf.get(areaOf(d)),
      role: "button",
      tabindex: "0",
      "aria-label": `${folder.name === "." ? "repository root" : folder.name}, ${plural(folder.files, "file")}`,
    });
    const linksHere = review.links.filter((l) => mergeFolder(l.from, depth) === folder.name || mergeFolder(l.to, depth) === folder.name);
    hover(rect, () => tip(folder, linksHere));
    const activate = () => on.pick(folder.name);
    rect.addEventListener("click", activate);
    rect.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    g.append(rect);

    if (w >= 36 && h >= 18) {
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
        count.textContent = String(d.value);
        text.append(count);
      }
      g.append(text);
    }

    const selected = folder.name === selectedFrom || folder.name === selectedTo;
    if (flagged.has(folder.name) || (view.focus && view.focus === folder.name)) {
      g.append(svgEl("rect", {
        class: flagged.has(folder.name) ? (selected ? "mark on" : "mark") : "focus",
        x: 1.5,
        y: 1.5,
        width: Math.max(0, w - 3),
        height: Math.max(0, h - 3),
      }));
    }
    svg.append(g);
  });
}

function swatch(colour, text) {
  const item = el("span", "legend-item");
  const mark = el("i", "sw cell");
  mark.style.background = colour;
  item.append(mark, document.createTextNode(text));
  return item;
}

function tip(folder, linksHere) {
  const where = folder.name === "." ? "repository root" : folder.name;
  const lines = [
    where,
    `${plural(folder.files, "architecture file")} · instability ${folder.instability.toFixed(2)}`,
    `imported by ${plural(folder.afferent, "file")} · imports ${plural(folder.efferent, "file")} outside`,
  ];
  if (linksHere.length > 0) {
    const top = [...linksHere].sort((a, b) => b.gap - a.gap)[0];
    lines.push(`click: ${top.from} → ${top.to}, uphill by ${top.gap.toFixed(2)}`);
  }
  return lines.join("\n");
}

function labelOf(name) {
  if (name === "." || name === "") return "root";
  return name.split("/").pop();
}

/** Walk past a single trunk (a repo that is all under src/) so colour splits the parts you can name. */
function groupingDepth(root) {
  let node = root;
  while (node.children && node.children.length === 1) node = node.children[0];
  return node.depth;
}

function areaColour(index) {
  if (index < AREA_COLOURS.length) return AREA_COLOURS[index];
  const hue = (index * 137.508) % 360;
  const avoidRed = hue < 18 || hue > 345 ? (hue + 40) % 360 : hue;
  return `hsl(${avoidRed.toFixed(0)} 42% 74%)`;
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
