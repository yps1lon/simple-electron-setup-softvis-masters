import { hierarchy, treemap } from "d3-hierarchy";
import { el, hover, plural, svgEl } from "./ui.js";

/**
 * The same folders as the treemap, drawn nested instead of flat. A normal
 * squarified treemap places every level, then each level that touches its
 * parent's right or bottom edge steps inward. The parent stays visible as
 * a card behind its children, which is the cascade in Lü and Fogarty (2008).
 * Colour is still instability. A folder's own files, when it also has
 * subfolders, are the cell named "files".
 */

const STABLE = [110, 110, 114];
const UNSTABLE = [229, 72, 77];
const FRAME = "#2e2e2e";
const OFFSET = 3;

/**
 * @param view { focus: node key | null }
 * @param on   { pick(key) }
 */
export function drawCascade(container, review, view, on) {
  container.replaceChildren();
  const level = review.matrix.levels[review.matrix.levels.length - 1];
  if (level.folders.length === 0) {
    container.append(el("p", "empty", "This repository has no architecture files to map."));
    return;
  }

  const tree = codebaseTree(level.folders);
  const width = Math.max(280, Math.floor(container.clientWidth || 640));
  const height = Math.max(420, Math.min(720, Math.round(width * 0.92)));
  const root = treemap()
    .size([width, height])
    .paddingOuter(OFFSET)
    .paddingInner(1)
    .paddingTop((d) => (d.children ? 16 : 0))
    .round(true)(
      hierarchy(tree).sum((d) => d.value || 0).sort((a, b) => b.value - a.value),
    );
  cascade(root, OFFSET);

  const nodes = root.descendants().filter((d) => d.x1 - d.x0 >= 1 && d.y1 - d.y0 >= 1);
  const byKey = new Map(nodes.map((d) => [nodeKey(d.data), d]));
  const focus = view.focus && byKey.has(view.focus) ? byKey.get(view.focus) : null;
  const files = level.folders.reduce((n, f) => n + f.files, 0);

  container.append(el("p", "view-summary", focus
    ? focusLine(focus) + " Click it again to clear."
    : `${plural(files, "architecture file")} nested in ${plural(level.folders.length, "folder")}. ` +
      "Each level steps in from the bottom-right, so the folder around it stays visible. " +
      "Colour is instability: grey is stable (0), red is unstable (1)."));
  container.append(instabilityScale());

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "treemap cascade",
    role: "img",
  });
  svg.setAttribute("aria-label",
    `Cascaded treemap of ${plural(level.folders.length, "folder")}, nested, coloured by instability`);
  container.append(svg);
  svg.append(shadowFilter("cascade-shadow"));

  const layers = new Map();
  for (const node of nodes) {
    const group = layers.get(node.height);
    if (group) group.push(node);
    else layers.set(node.height, [node]);
  }
  const heights = [...layers.keys()].sort((a, b) => b - a);
  heights.forEach((heightKey) => {
    for (const node of layers.get(heightKey)) drawNode(svg, node, on);
  });

  nodes.forEach((node, i) => {
    const w = node.x1 - node.x0;
    const h = node.y1 - node.y0;
    if (w < 28 || h < 12) return;
    const g = svgEl("g", { class: "leaf-label" });
    const clipId = `cascade-clip-${i}`;
    const clip = svgEl("clipPath", { id: clipId });
    clip.append(svgEl("rect", { x: node.x0, y: node.y0, width: w, height: h }));
    g.append(clip);
    const text = svgEl("text", { "clip-path": `url(#${clipId})` });
    const name = svgEl("tspan", { x: node.x0 + 4, y: node.y0 + 12 });
    name.textContent = node.data.ownFiles ? "files" : labelOf(node.data.name);
    text.append(name);
    if (!node.children && h >= 28) {
      const count = svgEl("tspan", { x: node.x0 + 4, y: node.y0 + 24, class: "count" });
      count.textContent = node.data.folder ? `I ${node.data.folder.instability.toFixed(2)}` : "";
      text.append(count);
    }
    g.append(text);
    svg.append(g);
  });

  if (focus) {
    svg.append(svgEl("rect", {
      class: "picked",
      x: focus.x0 + 1.5,
      y: focus.y0 + 1.5,
      width: Math.max(0, focus.x1 - focus.x0 - 3),
      height: Math.max(0, focus.y1 - focus.y0 - 3),
      fill: "none",
    }));
  }
}

function drawNode(svg, node, on) {
  const w = Math.max(0, node.x1 - node.x0);
  const h = Math.max(0, node.y1 - node.y0);
  const internal = Boolean(node.children);
  const g = svgEl("g", internal ? { filter: "url(#cascade-shadow)" } : {});
  const rect = svgEl("rect", {
    class: internal ? "frame" : "cell",
    x: node.x0,
    y: node.y0,
    width: w,
    height: h,
    fill: fillOf(node.data),
    role: "button",
    tabindex: "0",
    "aria-label": ariaOf(node),
  });
  hover(rect, () => tipOf(node));
  const activate = () => on.pick(nodeKey(node.data));
  rect.addEventListener("click", activate);
  rect.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  g.append(rect);
  svg.append(g);
}

function focusLine(node) {
  const folder = node.data.folder;
  const where = node.data.ownFiles
    ? `${folder.name} files`
    : (node.data.path || "codebase");
  if (!folder) {
    return `${where} · ${plural(node.value, "architecture file")} inside.`;
  }
  return `${where} · instability ${folder.instability.toFixed(2)} · ${plural(folder.files, "architecture file")}. ` +
    `Imported by ${plural(folder.afferent, "file")}, and it imports ${plural(folder.efferent, "file")} outside.`;
}

function ariaOf(node) {
  const folder = node.data.folder;
  const name = node.data.ownFiles ? `${folder.name} files` : (node.data.path || "codebase");
  if (!folder) return `${name}, ${plural(node.value, "file")} inside`;
  return `${name}, instability ${folder.instability.toFixed(2)}, ${plural(folder.files, "file")}`;
}

function tipOf(node) {
  const folder = node.data.folder;
  if (!folder) {
    return [node.data.path || "codebase", `${plural(node.value, "architecture file")} inside`].join("\n");
  }
  const name = node.data.ownFiles ? `${folder.name} files` : folder.name;
  return [
    name === "." ? "repository root" : name,
    `${plural(folder.files, "architecture file")} · instability ${folder.instability.toFixed(2)}`,
    `imported by ${plural(folder.afferent, "file")} · imports ${plural(folder.efferent, "file")} outside`,
  ].join("\n");
}

function fillOf(data) {
  if (!data.folder) return FRAME;
  return instabilityColour(data.folder.instability);
}

function instabilityColour(value) {
  const t = Math.min(1, Math.max(0, value));
  const mix = STABLE.map((channel, i) => Math.round(channel + (UNSTABLE[i] - channel) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function instabilityScale() {
  const row = el("div", "legend instability-scale");
  row.append(el("span", "", "0"));
  row.append(el("i", "scale-bar"));
  row.append(el("span", "", "1 instability"));
  return row;
}

function shadowFilter(id) {
  const filter = svgEl("filter", { id, x: "-20%", y: "-20%", width: "140%", height: "140%" });
  filter.append(svgEl("feDropShadow", {
    "flood-color": "#000",
    "flood-opacity": "0.45",
    dx: "0",
    dy: "1",
    stdDeviation: "1.4",
  }));
  return filter;
}

/** Pull in the right and bottom edges that sit on a parent edge, once per nested level. */
function cascade(root, offset) {
  const right = new Map();
  const bottom = new Map();
  root.eachAfter((node) => {
    if (!node.children) {
      right.set(node, 0);
      bottom.set(node, 0);
      return;
    }
    right.set(node, edgeDepth(node.children, (child) => child.x1 === node.x1 - offset, right));
    bottom.set(node, edgeDepth(node.children, (child) => child.y1 === node.y1 - offset, bottom));
  });
  root.eachBefore((node) => {
    node.x1 -= 2 * offset * right.get(node);
    node.y1 -= 2 * offset * bottom.get(node);
  });
  return root;
}

function edgeDepth(children, touches, depthOf) {
  let found = false;
  let best = 0;
  for (const child of children) {
    if (!touches(child)) continue;
    found = true;
    const depth = depthOf.get(child) || 0;
    if (depth > best) best = depth;
  }
  return found ? 1 + best : 0;
}

function nodeKey(data) {
  if (data.ownFiles) return `${data.path}#files`;
  return data.path || data.name || "codebase";
}

function labelOf(name) {
  if (!name || name === "." || name === "codebase") return name === "." ? "root" : (name || "codebase");
  return name.split("/").pop();
}

function codebaseTree(folders) {
  const root = { name: "codebase", path: "", children: new Map(), folder: null };
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
      name: "files",
      path: node.folder.name,
      value: node.folder.files,
      folder: node.folder,
      ownFiles: true,
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
  return { name: node.name, path: node.path, folder: node.folder, children };
}
