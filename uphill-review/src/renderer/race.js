import { clip, commitLine, el, hover, legendItem, plural, segmented, svgEl, svgText, tailName } from "./ui.js";

/**
 * The stability race: one folder and every folder it imports, over time.
 * Each is a line of instability per month; a dependency should stay below
 * the chosen folder. Months where a dependency sits above it (by more than
 * the chosen tolerance) turn red, thicker when more imports hold the link.
 * Where an uphill run starts, a dot marks a birth by a new import (violet
 * when the commit was agent-assisted) and a ring a birth by drift: the
 * import was already there and the numbers moved. This is task T5: is the
 * link new, growing or drifting?
 *
 * @param view { folder, dep, tol }
 * @param on   { folder(name), pick({from, to, depth}), tol(value) }
 */
export function drawRace(container, review, view, on) {
  container.replaceChildren();
  const h = review.history;
  const months = h.months;
  const n = months.length;
  const folders = Object.keys(h.instability).sort();
  const p = view.folder;

  const head = el("div", "view-head");
  const pickFolder = el("select", "folder-select");
  pickFolder.setAttribute("aria-label", "Folder");
  for (const f of folders) {
    const option = el("option", "", f);
    option.value = f;
    if (f === p) option.selected = true;
    pickFolder.append(option);
  }
  pickFolder.addEventListener("change", () => on.folder(pickFolder.value));
  const tolLabel = el("span", "lbl", "count as uphill above a gap of");
  head.append(
    el("span", "lbl", "Folder"),
    pickFolder,
    tolLabel,
    segmented(
      [
        { value: 0, label: "0" },
        { value: 0.1, label: "0.1" },
        { value: 0.2, label: "0.2" },
      ],
      view.tol,
      on.tol,
      "Tolerance",
    ),
  );
  container.append(head);

  const series = h.instability[p];
  if (p === null || series === undefined) {
    container.append(el("p", "empty", "Pick a folder to see how it and its dependencies moved."));
    return;
  }

  // Every folder p imported at some point in the window.
  const deps = [];
  for (const [key, counts] of Object.entries(h.links)) {
    const [from, to] = key.split(" -> ");
    if (from !== p || h.instability[to] === undefined) continue;
    deps.push({ q: to, counts, runs: runs(series, h.instability[to], counts, view.tol) });
  }
  const last = n - 1;
  const upNow = deps
    .filter((d) => d.runs.length > 0 && d.runs[d.runs.length - 1].end === last)
    .sort((a, b) => gapAt(b.q, last) * b.counts[last] - gapAt(a.q, last) * a.counts[last]);

  function gapAt(q, i) {
    const a = h.instability[q][i];
    const b = series[i];
    return a === null || b === null ? 0 : a - b;
  }

  // A folder importing its own subfolder is often by design (the review
  // calls it likely meant), so those runs are dashed.
  const isSub = (q) => q.startsWith(p + "/");
  const upSub = upNow.filter((d) => isSub(d.q)).length;
  const summary = el("p", "view-summary");
  summary.textContent =
    `${p} (I ${fmt(series[last])} now) imports ${plural(deps.filter((d) => d.counts[last] > 0).length, "folder")}; ` +
    `${upNow.length} of them sit above it now, holding ${plural(upNow.reduce((s, d) => s + d.counts[last], 0), "import")}` +
    `${upSub > 0 ? `; ${upSub === upNow.length ? (upSub === 1 ? "it is" : "all are") : `${upSub} of those ${upSub === 1 ? "is" : "are"}`} its own ${upSub === 1 ? "subfolder" : "subfolders"}` : ""}. ` +
    `${plural(h.commits, "commit")} replayed, ${h.agentCommits} agent-assisted.`;
  container.append(summary);

  const legend = el("div", "legend");
  legend.append(
    legendItem("line ink", "the chosen folder"),
    legendItem("line other", "folders it imports"),
    legendItem("line change", "months it imports a less stable folder (thicker = more imports)"),
    legendItem("line subfolder", "the same, into its own subfolder (often meant)"),
    legendItem("mark agent", "born by a new import, agent-assisted"),
    legendItem("mark human", "born by a new import, human"),
    legendItem("mark drift", "born by drift, or when files moved"),
  );
  container.append(legend);

  const width = Math.max(560, Math.min(container.clientWidth || 800, 980));
  const height = 430;
  const m = { top: 24, right: 200, bottom: 40, left: 52 };
  const X = (i) => (n === 1 ? m.left + (width - m.left - m.right) / 2 : m.left + (i * (width - m.left - m.right)) / (n - 1));
  const Y = (v) => m.top + (1 - v) * (height - m.top - m.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "race", role: "img" });
  svg.setAttribute("aria-label", `Instability of ${p} and the folders it imports, per month`);
  container.append(svg);

  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl("line", { x1: m.left, x2: width - m.right, y1: Y(v), y2: Y(v), class: "grid" }));
    svg.append(svgText(v.toFixed(2), { x: m.left - 8, y: Y(v) + 4, class: "tick", "text-anchor": "end" }));
  }
  svg.append(svgText("less stable", { x: m.left + 4, y: Y(1) - 6, class: "zone" }));
  svg.append(svgText("stable: much imports it", { x: m.left + 4, y: Y(0) - 6, class: "zone" }));
  // Month labels far enough apart to read; the last one ends at its tick so
  // it stays clear of the folder names on the right.
  const spacing = n > 1 ? (width - m.left - m.right) / (n - 1) : Infinity;
  const every = Math.max(1, Math.ceil(58 / spacing));
  months.forEach((month, i) => {
    const isLast = i === last;
    if (!isLast && (i % every !== 0 || X(last) - X(i) < 76)) return;
    svg.append(svgEl("line", { x1: X(i), x2: X(i), y1: height - m.bottom, y2: height - m.bottom + 5, class: "grid" }));
    svg.append(svgText(month, { x: X(i), y: height - m.bottom + 18, class: "tick", "text-anchor": isLast && n > 1 ? "end" : "middle" }));
  });

  const path = (values) => {
    let d = "";
    values.forEach((v, i) => {
      if (v === null) return;
      d += `${d && values[i - 1] !== null && values[i - 1] !== undefined ? " L" : " M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
    });
    return d.trim();
  };

  // The selected dependency's uphill months as a band between the lines.
  const selected = deps.find((d) => d.q === view.dep);
  if (selected) {
    for (const r of selected.runs) {
      let top = "";
      let bottom = "";
      for (let i = r.start; i <= r.end; i++) top += `${top ? " L" : "M"}${X(i)} ${Y(h.instability[selected.q][i])}`;
      for (let i = r.end; i >= r.start; i--) bottom += ` L${X(i)} ${Y(series[i])}`;
      svg.append(svgEl("path", { d: `${top}${bottom} Z`, class: "band" }));
    }
  }

  for (const d of deps) {
    const isSel = d.q === view.dep;
    const line = svgEl("path", { d: path(h.instability[d.q]), class: `dep${isSel ? " on" : ""}` });
    svg.append(line);
    hover(line, () => `${d.q}\nI now ${fmt(h.instability[d.q][last])} · ${plural(d.counts[last], "import")} from ${p}`);
    line.addEventListener("click", () => on.pick({ from: p, to: d.q, depth: null }));
    for (const r of d.runs) {
      const vals = h.instability[d.q].map((v, i) => (i >= r.start && i <= r.end ? v : null));
      const w = 2 + 2 * Math.log2(1 + r.maxImports);
      const single = r.start === r.end;
      const run = svgEl("path", { d: single ? dot(X(r.start), Y(vals[r.start])) : path(vals), class: `run${view.dep && !isSel ? " dim" : ""}`, "stroke-width": w.toFixed(1) });
      // Dashes sized to the line's width, with square ends.
      if (isSub(d.q) && !single) {
        run.setAttribute("stroke-linecap", "butt");
        run.setAttribute("stroke-dasharray", `${(w * 1.4).toFixed(1)} ${(w * 0.9).toFixed(1)}`);
      }
      svg.append(run);
      hover(run, () => `${p} → ${d.q}\nuphill ${months[r.start]}${r.end > r.start ? ` to ${months[r.end]}` : ""}, up to ${plural(r.maxImports, "import")}`);
      run.addEventListener("click", () => on.pick({ from: p, to: d.q, depth: null }));
    }
  }

  const own = svgEl("path", { d: path(series), class: "own" });
  svg.append(own);
  hover(own, () => `${p}\nI now ${fmt(series[last])}`);

  // Births where an uphill run starts.
  for (const d of deps) {
    for (const r of d.runs) {
      const birth = birthFor(h.births, p, d.q, months, r.start);
      // Already uphill when the window starts: no birth to mark.
      if (birth === null && r.start === 0) continue;
      const cx = X(r.start);
      const cy = Y(h.instability[d.q][r.start]);
      const mark = birth && birth.cause === "new import"
        ? svgEl("circle", { cx, cy, r: 5.5, class: `mark ${birth.commit.cls === "agent" ? "agent" : "human"}` })
        : svgEl("circle", { cx, cy, r: 5, class: "mark drift" });
      svg.append(mark);
      hover(mark, () =>
        `${months[r.start]}: ${p} → ${d.q}\n` +
        (birth
          ? `${birth.cause === "new import" ? "born by a new import" : birth.cause === "moved" ? "born when files moved" : "born by drift"}, gap ${birth.gap.toFixed(2)}, ${plural(birth.imports, "import")}\n${commitLine(birth.commit)}`
          : r.start === 0 ? "already uphill when the window starts" : "born by drift"),
      );
      mark.addEventListener("click", () => on.pick({ from: p, to: d.q, depth: null }));
    }
  }

  // Labels at the right edge: the folders above p now first, then the rest
  // it still imports, and always the selection (at most 14), plus p itself.
  // They are nudged apart together, so none covers another.
  const still = deps.filter((d) => d.counts[last] > 0 && !upNow.includes(d)).sort((a, b) => b.counts[last] - a.counts[last]);
  const labelled = [...new Set([...upNow, ...still].slice(0, 14).concat(deps.filter((d) => d.q === view.dep)))]
    .filter((d) => h.instability[d.q][last] !== null)
    .map((d) => ({ d, y0: Y(h.instability[d.q][last]) }));
  if (series[last] !== null) labelled.push({ d: null, y0: Y(series[last]) });
  labelled.sort((a, b) => a.y0 - b.y0 || (a.d === null ? -1 : b.d === null ? 1 : 0));
  labelled.forEach((l, k) => {
    l.y = k === 0 ? l.y0 : Math.max(l.y0, labelled[k - 1].y + 14);
  });
  // Labels pushed below the chart make it taller rather than overlap the caption.
  const bottom = Math.max(height, ...labelled.map((l) => l.y + 8));
  if (bottom > height) svg.setAttribute("viewBox", `0 0 ${width} ${bottom}`);
  for (const l of labelled) {
    svg.append(svgEl("line", { x1: X(last) + 4, x2: width - m.right + 12, y1: l.y0, y2: l.y, class: "leader" }));
    if (l.d === null) {
      svg.append(svgText(`${clip(tailName(p, 2), 22)} (${fmt(series[last])})`, { x: width - m.right + 16, y: l.y + 4, class: "race-label self" }));
      continue;
    }
    const isUp = upNow.includes(l.d);
    const t = svgText(`${clip(tailName(l.d.q, 2), 24)} · ${l.d.counts[last]}`, { x: width - m.right + 16, y: l.y + 4, class: `race-label${l.d.q === view.dep ? " on" : ""}${isUp ? " up" : ""}` });
    t.addEventListener("click", () => on.pick({ from: p, to: l.d.q, depth: null }));
    svg.append(t);
  }

  container.append(el("p", "caption",
    "Each line is a folder's instability at the end of each month. Low is stable: much imports it. " +
    "A folder should import folders below its own line; red marks the months it imports one above it."));
}

/** Month ranges where p imports q and q sits above p by more than tol. */
function runs(pSeries, qSeries, counts, tol) {
  const out = [];
  let cur = null;
  for (let i = 0; i < pSeries.length; i++) {
    const a = pSeries[i];
    const b = qSeries[i];
    const up = counts[i] > 0 && a !== null && b !== null && b - a > tol + 1e-9;
    if (up) {
      if (cur === null) cur = { start: i, end: i, maxImports: 0 };
      cur.end = i;
      cur.maxImports = Math.max(cur.maxImports, counts[i]);
    } else if (cur !== null) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

function birthFor(births, p, q, months, start) {
  const mine = births.filter((b) => b.from === p && b.to === q);
  const exact = mine.filter((b) => b.month === months[start]);
  if (exact.length > 0) return exact[exact.length - 1];
  const before = mine.filter((b) => b.month <= months[start]);
  return start === 0 ? null : (before[before.length - 1] ?? null);
}

function dot(x, y) {
  return `M${x - 0.1} ${y} L${x + 0.1} ${y}`;
}

function fmt(v) {
  return v === null || v === undefined ? "n/a" : v.toFixed(2);
}
