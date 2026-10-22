import * as d3 from "d3";
import { STATUS_COLOUR } from "./colours.js";
import { hideDetails, showDetails } from "./details.js";

/**
 * Draw an AnalysisResult as ONE force-directed graph: nodes are modules,
 * every edge carries its reflexion status as colour, width and dash (grey
 * solid = convergent, red thick = divergent, grey dashed = absent). Kept
 * as the secondary view for what node-link does better than a matrix:
 * reading topology and following paths (Munzner, ch. 9; Okoe et al.
 * 2019). A side-by-side intended-vs-actual pair was rejected because force
 * layouts are not stable between renders and diffing two node-link
 * diagrams by eye is a bad task for humans; overlaying status on one graph
 * makes the drift itself the salient thing.
 *
 * Returns a function that clears the current selection, so the shell can
 * wire it to the details panel's close button.
 */
export function drawGraph(result) {
  const container = document.getElementById("vis");
  container.replaceChildren();
  hideDetails();
  const width = Math.max(container.clientWidth || 0, 400);
  const height = 600;

  // A module is an offender when it is the SOURCE of at least one divergent
  // edge — it does the forbidden importing. Colouring the node itself makes
  // offenders findable without tracing lines back from red arrows.
  const offenders = new Set(
    result.edges
      .filter((edge) => edge.status === "divergent")
      .map((edge) => edge.from)
  );

  const nodes = result.modules.map((name) => ({
    id: name,
    offender: offenders.has(name)
  }));
  // Copied into fresh objects because the force simulation mutates its
  // links (swapping source/target for node references, adding x/y), and
  // the same result may be rendered again.
  const links = result.edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    status: edge.status,
    weight: edge.weight,
    examples: edge.examples
  }));

  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  buildMarkers(svg);

  const simulation = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(150))
    .force("charge", d3.forceManyBody().strength(-500))
    .force("center", d3.forceCenter(width / 2, height / 2))
    // Collision radius covers the label hanging below the circle, so two
    // nodes cannot sit close enough for their texts to overlap.
    .force("collide", d3.forceCollide(70));

  const link = svg
    .append("g")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke", (d) => STATUS_COLOUR[d.status])
    .attr("stroke-width", (d) => (d.status === "divergent" ? 2.5 : 1.5))
    .attr("stroke-dasharray", (d) => (d.status === "absent" ? "6 4" : null))
    .attr("marker-end", (d) => `url(#arrow-${d.status})`);

  // Hovering a divergent edge lists the concrete file imports behind it,
  // so a finding can be verified against real code, not trusted blindly.
  link
    .filter((d) => d.status === "divergent")
    .append("title")
    .text((d) => d.examples.map((e) => `${e.from} → ${e.to}`).join("\n"));

  // Selecting a module dims everything not touching it, so its
  // neighbourhood stands out, and opens the details panel. By the time a
  // click can happen the force layout has replaced each link's source and
  // target strings with node objects, so .id is always available here.
  function applySelection(selectedId) {
    if (selectedId === null) {
      node.attr("opacity", 1);
      link.attr("opacity", 1);
      hideDetails();
      return;
    }
    const touching = (d) =>
      d.source.id === selectedId || d.target.id === selectedId;
    const connected = new Set([selectedId]);
    for (const l of links) {
      if (touching(l)) {
        connected.add(l.source.id);
        connected.add(l.target.id);
      }
    }
    node.attr("opacity", (d) => (connected.has(d.id) ? 1 : 0.15));
    link.attr("opacity", (d) => (touching(d) ? 1 : 0.15));
    showDetails(result, selectedId);
  }

  // Only a click on the empty background clears; clicks on nodes have the
  // circle as their target and are handled by the drag/click logic instead.
  svg.on("click", (event) => {
    if (event.target === svg.node()) applySelection(null);
  });

  const node = svg
    .append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .style("cursor", "pointer")
    .call(drag(simulation, (d) => applySelection(d.id)));

  node
    .append("circle")
    .attr("r", 16)
    .attr("fill", (d) => (d.offender ? STATUS_COLOUR.divergent : "#4e79a7"))
    .attr("stroke", "#202020")
    .attr("stroke-width", 1.5);

  node
    .append("text")
    .attr("y", 46)
    .attr("text-anchor", "middle")
    .text((d) => d.id);

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  return () => applySelection(null);
}

// SVG markers cannot inherit the line's stroke colour, so each colour gets
// its own marker. refX differs per marker because marker units scale with
// the line's stroke width: the thicker divergent line needs less pushback
// for the arrowhead to land on the node edge instead of under it.
function buildMarkers(svg) {
  const markers = [
    { status: "convergent", refX: 29 },
    { status: "absent", refX: 29 },
    { status: "divergent", refX: 21 }
  ];
  svg
    .append("defs")
    .selectAll("marker")
    .data(markers)
    .join("marker")
    .attr("id", (d) => `arrow-${d.status}`)
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", (d) => d.refX)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", (d) => STATUS_COLOUR[d.status]);
}

function drag(simulation, onClick) {
  // Where the pointer went down, to tell a click from a drag on release.
  let downX = 0;
  let downY = 0;
  return d3
    .drag()
    .on("start", (event, d) => {
      downX = event.x;
      downY = event.y;
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
      // Under 5px of movement counts as a click, not a drag; without this
      // threshold every drag would also open the details panel.
      if (Math.hypot(event.x - downX, event.y - downY) < 5) {
        onClick(d);
      }
    });
}
