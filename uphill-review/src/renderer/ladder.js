import { COLOUR } from "./colours.js";
import { clip, commitLine, el, hover, legendItem, plural, shortName, svgEl, svgText } from "./ui.js";

/**
 * The stability ladder: the author's view of one uphill link.
 *
 * Height is instability. Position on a common scale is the most accurate
 * channel for a quantity (Munzner 2014, ch. 5), and with stable folders at
 * the bottom every healthy import points down, so the change's import is
 * the one arrow pointing up. Only the neighbourhood of the link is drawn:
 * who imports the stable folder (left), the two folders (middle), and what
 * the less stable folder imports (right). Dot size is exposure (files that
 * import the folder); line width is the number of file imports. The label
 * names the break, as the live feedback in Knodel et al. (2008) did.
 */
export function drawLadder(container, link) {
  container.replaceChildren();
  if (link === null) {
    container.append(el("p", "empty", "Pick an uphill link in the list to see it on the ladder."));
    return;
  }

  const legend = el("div", "legend");
  const style = link.decision?.decision === "meant" && !link.grew ? "meant" : link.kind === "into-subfolder" ? "subfolder" : "change";
  legend.append(
    legendItem(`line ${style}`, style === "meant" ? "import added by this change, marked meant" : style === "subfolder" ? "import added by this change, into its own subfolder" : "import added by this change"),
    legendItem("line other", "other imports (thicker = more files)"),
  );
  if (link.loop) legend.append(legendItem("line loop", "imports back: the two folders now depend on each other"));
  legend.append(legendItem("dot", "dot size = files that import the folder"));
  container.append(legend);

  const width = Math.max(560, Math.min(container.clientWidth || 760, 980));
  const height = 500;
  const m = { top: 66, right: 20, bottom: 58, left: 62 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const y = (i) => m.top + (1 - i) * plotH;
  const colX = {
    "relies-on-from": m.left + plotW * 0.28,
    from: m.left + plotW * 0.45,
    to: m.left + plotW * 0.58,
    "to-relies-on": m.left + plotW * 0.75,
  };

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "ladder", role: "img" });
  svg.setAttribute("aria-label", `${link.from} at instability ${link.fromInstability} imports ${link.to} at ${link.toInstability}, uphill by ${link.gap}`);
  container.append(svg);
  defineArrows(svg);

  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl("line", { x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick), class: "grid" }));
    svg.append(svgText(tick.toFixed(2), { x: m.left - 8, y: y(tick) + 4, class: "tick", "text-anchor": "end" }));
  }
  svg.append(svgText("instability I  (up = less stable)", {
    x: 16, y: m.top + plotH / 2, class: "axis-title", "text-anchor": "middle",
    transform: `rotate(-90 16 ${m.top + plotH / 2})`,
  }));

  const folders = link.ladder.folders;
  const fromF = folders.find((f) => f.role === "from");
  const toF = folders.find((f) => f.role === "to");
  const left = folders.filter((f) => f.role === "relies-on-from");
  const right = folders.filter((f) => f.role === "to-relies-on");
  const maxCa = Math.max(1, ...folders.map((f) => f.afferent));
  const names = folderNames(folders.map((f) => f.folder), [link.from, link.to]);
  const radius = (f, min) => Math.max(min, 3 + 9 * Math.sqrt(f.afferent / maxCa));

  // Where each dot goes. Height is fixed by instability; dots in one side
  // column that would cover each other move sideways, away from the middle,
  // the biggest staying in the column.
  const pos = new Map([
    [fromF, { x: colX.from, y: y(fromF.instability) }],
    [toF, { x: colX.to, y: y(toF.instability) }],
  ]);
  for (const [list, dir] of [[left, -1], [right, 1]]) {
    const placed = [];
    for (const f of [...list].sort((a, b) => b.afferent - a.afferent || a.folder.localeCompare(b.folder))) {
      const r = radius(f, 3.5);
      const py = y(f.instability);
      let px = colX[f.role];
      for (let step = 0; step < 8 && placed.some((q) => Math.hypot(q.x - px, q.y - py) < q.r + r + 3); step++) px += dir * (r + 5);
      placed.push({ x: px, y: py, r });
      pos.set(f, { x: px, y: py });
    }
  }
  const at = (f) => pos.get(f);

  svg.append(svgText(`import ${shortName(link.from)}`, { x: colX["relies-on-from"] + 6, y: 20, class: "col-head", "text-anchor": "end" }));
  svg.append(svgText("this change", { x: (colX.from + colX.to) / 2, y: 20, class: "col-head", "text-anchor": "middle" }));
  svg.append(svgText(`${shortName(link.to)} imports`, { x: colX["to-relies-on"] - 6, y: 20, class: "col-head", "text-anchor": "start" }));
  if (link.ladder.hiddenReliesOnFrom > 0) {
    svg.append(svgText(`+${link.ladder.hiddenReliesOnFrom} more not shown`, { x: colX["relies-on-from"] + 6, y: 36, class: "col-note", "text-anchor": "end" }));
  }
  if (link.ladder.hiddenToReliesOn > 0) {
    svg.append(svgText(`+${link.ladder.hiddenToReliesOn} more not shown`, { x: colX["to-relies-on"] - 6, y: 36, class: "col-note", "text-anchor": "start" }));
  }
  // Say so when a side is empty, rather than leave a blank column.
  if (left.length === 0) {
    svg.append(svgText("no other folder", { x: colX["relies-on-from"] + 6, y: 36, class: "col-note", "text-anchor": "end" }));
  }
  if (right.length === 0) {
    svg.append(svgText(link.loop ? `only ${shortName(link.from)} (the dashed line)` : "no other folder", { x: colX["to-relies-on"] - 6, y: 36, class: "col-note", "text-anchor": "start" }));
  }

  // Neighbour links first, so the change's arrow is drawn on top.
  for (const f of left) arrow(svg, at(f), at(fromF), "other", radius(f, 3.5) + 2, radius(fromF, 8) + 3, width1(f.imports));
  for (const f of right) arrow(svg, at(toF), at(f), "other", radius(toF, 8) + 2, radius(f, 3.5) + 3, width1(f.imports));
  if (link.loop) loopArrow(svg, at(toF), at(fromF));

  const main = arrow(svg, at(fromF), at(toF), style, radius(fromF, 8) + 2, radius(toF, 8) + 4, 1.5 + width1(link.imports.length));
  const a = at(fromF);
  const b = at(toF);
  // Name the break next to the arrow's upper half, where the neighbours'
  // lines are sparse; a halo keeps it readable where lines cross.
  const at75 = { x: a.x + (b.x - a.x) * 0.72, y: a.y + (b.y - a.y) * 0.72 };
  const label = svgText("", { x: at75.x - 14, y: at75.y - 6, class: "break-label", "text-anchor": "end" });
  const first = svgEl("tspan", { x: at75.x - 14 });
  first.textContent = link.kind === "into-subfolder" ? "into its subfolder" : "imports upward";
  const second = svgEl("tspan", { x: at75.x - 14, dy: 15 });
  second.textContent = `gap ${link.gap.toFixed(2)}`;
  label.append(first, second);
  svg.append(label);
  hover(main, () => {
    const lines = link.imports.filter((i) => i.isNew).map((i) => `${i.from}${i.line ? ":" + i.line : ""} (${i.kind})\n  ${commitLine(i.commit)}`);
    return `${link.from} imports ${link.to}\n${lines.join("\n")}`;
  });

  // Neighbour dots and labels. Labels point outward and are nudged apart;
  // each sits just outside the outermost dot near its height, and a thin
  // leader joins a label to its dot when they are not side by side.
  const labelled = [];
  for (const [list, dir] of [[left, -1], [right, 1]]) {
    for (const p of spread(list.map((f) => ({ f, ...at(f) })))) {
      const lo = Math.min(p.y, p.labelY - 4) - 16;
      const hi = Math.max(p.y, p.labelY - 4) + 16;
      const near = list.filter((f) => at(f).y >= lo && at(f).y <= hi);
      const edge = dir < 0
        ? Math.min(...near.map((f) => at(f).x - radius(f, 3.5)))
        : Math.max(...near.map((f) => at(f).x + radius(f, 3.5)));
      labelled.push({ ...p, dir, labelX: edge + dir * 8 });
    }
  }
  for (const p of labelled) {
    const r = radius(p.f, 3.5);
    const g = svgEl("g", { class: "node" });
    g.append(svgEl("circle", { cx: p.x, cy: p.y, r: Math.max(12, r + 3), class: "hit" }));
    g.append(svgEl("circle", { cx: p.x, cy: p.y, r, class: "dot" }));
    const x1 = p.x + p.dir * (r + 1);
    const x2 = p.labelX - p.dir * 2;
    if (Math.abs(p.labelY - 4 - p.y) > 2 || Math.abs(x2 - x1) > 3) {
      g.append(svgEl("line", { x1, y1: p.y, x2, y2: p.labelY - 4, class: "leader" }));
    }
    g.append(svgText(clip(names.get(p.f.folder), 30), { x: p.labelX, y: p.labelY, class: "label", "text-anchor": p.dir < 0 ? "end" : "start" }));
    svg.append(g);
    hover(g, () => folderTip(p.f));
  }
  for (const [f, above] of [[fromF, false], [toF, true]]) {
    const p = at(f);
    const r = radius(f, 8);
    const g = svgEl("g", { class: "node key" });
    g.append(svgEl("circle", { cx: p.x, cy: p.y, r: r + 4, class: "hit" }));
    g.append(svgEl("circle", { cx: p.x, cy: p.y, r, class: "dot key" }));
    const ly = above ? p.y - r - 22 : p.y + r + 18;
    g.append(svgText(clip(names.get(f.folder), 34), { x: p.x, y: ly, class: "label key", "text-anchor": "middle" }));
    g.append(svgText(`I ${f.instability.toFixed(2)} · ${plural(f.afferent, "importer")}`, { x: p.x, y: ly + 14, class: "sub", "text-anchor": "middle" }));
    svg.append(g);
    hover(g, () => folderTip(f));
  }

  container.append(el("p", "caption",
    "Height is instability, I = Ce / (Ca + Ce) counted in files: 0 means much imports the folder and it imports little. " +
    `Imports should point down, toward stable folders. The red arrow is this change's import; it points up by ${link.gap.toFixed(2)}.`));
}

function arrow(svg, a, b, style, startGap, endGap, width) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const line = svgEl("line", {
    x1: a.x + ux * startGap, y1: a.y + uy * startGap,
    x2: b.x - ux * endGap, y2: b.y - uy * endGap,
    class: `link ${style}`,
    "stroke-width": width,
    "marker-end": `url(#arrow-${style === "other" || style === "meant" ? "other" : "change"})`,
  });
  svg.append(line);
  return line;
}

function loopArrow(svg, a, b) {
  // A curve back from `to` to `from`, bowed to the right of the main arrow.
  const cx = Math.max(a.x, b.x) + 60;
  const cy = (a.y + b.y) / 2;
  svg.append(svgEl("path", {
    d: `M ${a.x + 9} ${a.y + 6} Q ${cx} ${cy} ${b.x + 10} ${b.y - 6}`,
    class: "link loop",
    "marker-end": "url(#arrow-other)",
  }));
}

function defineArrows(svg) {
  const defs = svgEl("defs");
  for (const [id, colour] of [["other", COLOUR.other], ["change", COLOUR.uphill]]) {
    const marker = svgEl("marker", {
      id: `arrow-${id}`, viewBox: "0 0 10 10", refX: 8, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse",
    });
    marker.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: colour }));
    defs.append(marker);
  }
  svg.append(defs);
}

/**
 * Short names for the folders drawn: the last two path segments, more when
 * the name would start with a generic segment such as "src" (unless the
 * folder sits inside one of the link's two folders, where the column head
 * gives the context), and more again until no two drawn folders share a name.
 */
function folderNames(folders, keys) {
  const generic = new Set(["src", "lib", "dist", "source"]);
  const unique = [...new Set(folders)];
  const parts = new Map(unique.map((f) => [f, f.split("/")]));
  const k = new Map();
  for (const f of unique) {
    const p = parts.get(f);
    const inside = keys.some((key) => f.startsWith(key + "/"));
    let n = Math.min(2, p.length);
    while (!inside && n < p.length && generic.has(p[p.length - n])) n++;
    k.set(f, n);
  }
  const tail = (f) => parts.get(f).slice(-k.get(f)).join("/");
  for (let round = 0; round < 8; round++) {
    const byName = new Map();
    for (const f of unique) byName.set(tail(f), [...(byName.get(tail(f)) ?? []), f]);
    let changed = false;
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      for (const f of same) {
        if (k.get(f) < parts.get(f).length) {
          k.set(f, k.get(f) + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return new Map(unique.map((f) => [f, tail(f)]));
}

/** Nudge labels in one column apart (at least 14px), keeping their order. */
function spread(points) {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const p of sorted) {
    p.labelY = Math.max(p.y + 4, last + 14);
    last = p.labelY;
  }
  return sorted;
}

function width1(imports) {
  return 1 + Math.min(2.5, Math.log2(Math.max(1, imports)) / 1.5);
}

function folderTip(f) {
  return (
    `${f.folder}\n` +
    `instability ${f.instability.toFixed(2)} · ${plural(f.files, "file")}\n` +
    `imported by ${plural(f.afferent, "file")} outside (Ca)\n` +
    `${plural(f.efferent, "file")} import outside (Ce)`
  );
}
