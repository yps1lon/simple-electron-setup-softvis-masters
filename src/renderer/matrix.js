import * as d3 from "d3";
import { STATUS_COLOUR } from "./colours.js";
import { hideDetails, showDetails, showEdgeDetails } from "./details.js";

/**
 * Draw an AnalysisResult as a dependency structure matrix (Sangal et al.
 * 2005): rows import columns, each cell is one module edge, hue encodes
 * the reflexion status and opacity encodes the weight.
 *
 * Why a matrix and not the force graph (Munzner, ch. 9): a matrix is
 * predictable and stable — the same module always lands in the same row
 * and column, so two commits can be compared cell by cell, which is what
 * the thesis's before/after method needs — and it stays readable at
 * densities where a node-link drawing becomes a hairball (Ghoniem et al.
 * 2005). Its known weakness, path following, is not a task here: every
 * finding is a single edge. Its other weakness, unfamiliarity, is met with
 * the caption, the legend and the margin counts.
 *
 * Rows are ordered by the layering the spec implies (see layerOrder), so
 * every allowed dependency falls above the diagonal and a red cell below
 * it is a layer inversion, readable by position alone.
 *
 * Returns a function that clears the current selection, so the shell can
 * wire it to the details panel's close button.
 */
export function drawMatrix(result) {
  const container = document.getElementById("vis");
  container.replaceChildren();
  hideDetails();

  const order = layerOrder(result);
  const n = order.length;
  const indexOf = new Map(order.map((name, i) => [name, i]));
  const edgeAt = new Map(result.edges.map((e) => [e.from + "\0" + e.to, e]));
  const offenders = new Set(
    result.edges.filter((e) => e.status === "divergent").map((e) => e.from)
  );
  const present = (e) => e !== null && e.status !== "absent";

  // Weight is ordered data, so it goes on an ordered channel (opacity),
  // floored so a weight-1 edge is still unmistakably there.
  const maxWeight = Math.max(1, ...result.edges.map((e) => e.weight));
  const weightOpacity = d3.scaleSqrt().domain([1, maxWeight]).range([0.45, 1]);

  // Geometry: cells shrink to fit the width but never below a clickable
  // size; the label gutter grows with the longest module name.
  const longest = Math.max(1, ...order.map((m) => m.length));
  const labelW = Math.min(180, longest * 7.5 + 16);
  const available = Math.max(container.clientWidth || 0, 400) - labelW - 60;
  const cell = Math.max(22, Math.min(44, Math.floor(available / Math.max(n, 1))));
  const top = Math.min(150, longest * 6.5 + 30);
  const marginW = 44;
  const marginH = 36;
  const width = labelW + n * cell + marginW;
  const height = top + n * cell + marginH;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("class", "matrix")
    .attr("width", width)
    .attr("height", height);

  svg
    .append("text")
    .attr("class", "caption")
    .attr("x", labelW - 8)
    .attr("y", top - 10)
    .attr("text-anchor", "end")
    .text("row → column");

  const cells = [];
  for (const from of order) {
    for (const to of order) {
      const diagonal = from === to;
      cells.push({
        from,
        to,
        diagonal,
        edge: diagonal ? null : (edgeAt.get(from + "\0" + to) ?? null)
      });
    }
  }

  const rect = svg
    .append("g")
    .selectAll("rect")
    .data(cells)
    .join("rect")
    .attr("x", (d) => labelW + indexOf.get(d.to) * cell + 1)
    .attr("y", (d) => top + indexOf.get(d.from) * cell + 1)
    .attr("width", cell - 2)
    .attr("height", cell - 2)
    .attr("rx", 2)
    .attr("fill", (d) => {
      if (d.diagonal) return "#2e2e2e";
      if (present(d.edge)) return STATUS_COLOUR[d.edge.status];
      return "#1a1a1a";
    })
    .attr("fill-opacity", (d) => (present(d.edge) ? weightOpacity(d.edge.weight) : 1))
    .attr("stroke", (d) => {
      if (d.edge !== null && d.edge.status === "absent") return STATUS_COLOUR.absent;
      return d.diagonal ? "none" : "#262626";
    })
    .attr("stroke-dasharray", (d) =>
      d.edge !== null && d.edge.status === "absent" ? "3 2" : null
    )
    .style("cursor", (d) => (d.edge !== null ? "pointer" : "default"));

  rect
    .filter((d) => d.edge !== null)
    .append("title")
    .text((d) => `${d.from} → ${d.to}: ${d.edge.status}, weight ${d.edge.weight}`);

  const rowLabel = svg
    .append("g")
    .selectAll("text")
    .data(order)
    .join("text")
    .attr("class", (m) => (offenders.has(m) ? "label offender" : "label"))
    .attr("x", labelW - 8)
    .attr("y", (m) => top + indexOf.get(m) * cell + cell / 2)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "middle")
    .text((m) => m);

  const colLabel = svg
    .append("g")
    .selectAll("text")
    .data(order)
    .join("text")
    .attr("class", (m) => (offenders.has(m) ? "label offender" : "label"))
    .attr(
      "transform",
      (m) => `translate(${labelW + indexOf.get(m) * cell + cell / 2 + 4},${top - 8}) rotate(-60)`
    )
    .attr("text-anchor", "start")
    .text((m) => m);

  // Margins: efferent coupling per row (modules it imports) and afferent
  // coupling per column (modules importing it) — Martin's Ce and Ca, read
  // straight off the matrix. Absent edges do not count; they are not code.
  const efferent = (m) => result.edges.filter((e) => e.from === m && e.status !== "absent").length;
  const afferent = (m) => result.edges.filter((e) => e.to === m && e.status !== "absent").length;

  svg
    .append("g")
    .selectAll("text")
    .data(order)
    .join("text")
    .attr("class", "count")
    .attr("x", labelW + n * cell + 10)
    .attr("y", (m) => top + indexOf.get(m) * cell + cell / 2)
    .attr("dominant-baseline", "middle")
    .text((m) => efferent(m));

  svg
    .append("g")
    .selectAll("text")
    .data(order)
    .join("text")
    .attr("class", "count")
    .attr("x", (m) => labelW + indexOf.get(m) * cell + cell / 2)
    .attr("y", top + n * cell + 16)
    .attr("text-anchor", "middle")
    .text((m) => afferent(m));

  svg.append("text").attr("class", "caption")
    .attr("x", labelW + n * cell + 10).attr("y", top - 10).text("Ce");
  svg.append("text").attr("class", "caption")
    .attr("x", labelW - 8).attr("y", top + n * cell + 16)
    .attr("text-anchor", "end").attr("dominant-baseline", "middle").text("Ca");

  // Selection: a module lights up its row and column, an edge lights up
  // its cell; everything else dims to 15% so the neighbourhood stands out.
  function applySelection(selection) {
    if (selection === null) {
      rect.attr("opacity", 1);
      rowLabel.attr("opacity", 1);
      colLabel.attr("opacity", 1);
      hideDetails();
      return;
    }
    if (selection.module !== undefined) {
      const m = selection.module;
      rect.attr("opacity", (d) => (d.from === m || d.to === m ? 1 : 0.15));
      rowLabel.attr("opacity", (x) => (x === m ? 1 : 0.4));
      colLabel.attr("opacity", (x) => (x === m ? 1 : 0.4));
      showDetails(result, m);
      return;
    }
    const e = selection.edge;
    rect.attr("opacity", (d) => (d.from === e.from && d.to === e.to ? 1 : 0.15));
    rowLabel.attr("opacity", (x) => (x === e.from ? 1 : 0.4));
    colLabel.attr("opacity", (x) => (x === e.to ? 1 : 0.4));
    showEdgeDetails(result, e);
  }

  rect.on("click", (event, d) => {
    if (d.edge !== null) {
      event.stopPropagation();
      applySelection({ edge: d.edge });
    }
  });
  rowLabel.on("click", (event, m) => {
    event.stopPropagation();
    applySelection({ module: m });
  });
  colLabel.on("click", (event, m) => {
    event.stopPropagation();
    applySelection({ module: m });
  });
  svg.on("click", () => applySelection(null));

  return () => applySelection(null);
}

/**
 * Derived data (Munzner, ch. 3): an order on the modules taken from the
 * INTENDED architecture only. Allowed edges are the convergent and absent
 * ones — both come from the spec's `allowed` — and divergent edges are
 * ignored on purpose, so the code's mistakes cannot rearrange the picture
 * of intent. Kahn's algorithm with alphabetical tie-breaks keeps the order
 * deterministic: modules nobody may depend on (top layers, e.g. ui) come
 * first, foundations last, so allowed edges point from earlier rows to
 * later columns, above the diagonal. If the spec itself allows a cycle,
 * the rest is appended alphabetically and that cycle straddles the
 * diagonal — which is worth seeing.
 *
 * Exported because the Mermaid export reuses it, so the file matches the
 * screen cell for cell.
 */
export function layerOrder(result) {
  const allowed = result.edges.filter((e) => e.status !== "divergent");
  const dependents = new Map(result.modules.map((m) => [m, 0]));
  for (const e of allowed) dependents.set(e.to, dependents.get(e.to) + 1);

  const order = [];
  const remaining = new Set(result.modules);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((m) => dependents.get(m) === 0).sort();
    if (ready.length === 0) {
      order.push(...[...remaining].sort());
      break;
    }
    for (const m of ready) {
      order.push(m);
      remaining.delete(m);
      for (const e of allowed) {
        if (e.from === m) dependents.set(e.to, dependents.get(e.to) - 1);
      }
    }
  }
  return order;
}
