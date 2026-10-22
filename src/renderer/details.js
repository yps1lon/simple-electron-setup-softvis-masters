import { guard } from "./status.js";

// The side panel both views open on click. Everything shown here is
// filtered straight out of the AnalysisResult; nothing is computed that the
// engine did not already report.

// Divergent first: the drift is what the panel exists to explain.
const STATUS_ORDER = { divergent: 0, convergent: 1, absent: 2 };

export function hideDetails() {
  document.getElementById("details").hidden = true;
}

// One module: how many files map to it, its coupling, and every edge
// touching it grouped by direction.
export function showDetails(result, moduleId) {
  const content = document.getElementById("details-content");
  content.replaceChildren();

  const title = document.createElement("h2");
  title.textContent = moduleId;
  content.appendChild(title);

  const fileCount = document.createElement("p");
  fileCount.className = "file-count";
  const n = result.fileCounts[moduleId] ?? 0;
  fileCount.textContent = `${n} file${n === 1 ? "" : "s"} mapped`;
  content.appendChild(fileCount);

  const outgoing = result.edges.filter((e) => e.from === moduleId);
  const incoming = result.edges.filter((e) => e.to === moduleId);

  // Afferent/efferent coupling. Absent edges are excluded: they exist only
  // in the spec, not in the code, so they are not real coupling.
  const afferent = incoming.filter((e) => e.status !== "absent").length;
  const efferent = outgoing.filter((e) => e.status !== "absent").length;
  const coupling = document.createElement("p");
  coupling.className = "file-count";
  coupling.textContent =
    `afferent ${afferent} (modules depending on it) · ` +
    `efferent ${efferent} (modules it depends on)`;
  content.appendChild(coupling);

  appendEdgeSection(content, "Outgoing", outgoing, (e) => `→ ${e.to}`, result.root);
  appendEdgeSection(content, "Incoming", incoming, (e) => `← ${e.from}`, result.root);

  document.getElementById("details").hidden = false;
}

// One module edge, from a matrix cell: the edge's status and weight, and
// the file imports behind it. An absent edge has no examples by definition.
export function showEdgeDetails(result, edge) {
  const content = document.getElementById("details-content");
  content.replaceChildren();

  const title = document.createElement("h2");
  title.textContent = `${edge.from} → ${edge.to}`;
  content.appendChild(title);

  const summary = document.createElement("p");
  summary.className = `file-count ${edge.status}`;
  summary.textContent =
    edge.status === "absent"
      ? "absent — allowed by the spec, never built"
      : `${edge.status}, weight ${edge.weight}`;
  content.appendChild(summary);

  const h = document.createElement("h3");
  h.textContent = "Example imports";
  content.appendChild(h);

  if (edge.examples.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = "none";
    content.appendChild(none);
  }
  for (const example of edge.examples) {
    const line = document.createElement("div");
    line.className = "edge-examples";
    line.appendChild(fileLink(result.root, example.from));
    line.appendChild(document.createTextNode(" → "));
    line.appendChild(fileLink(result.root, example.to));
    content.appendChild(line);
  }

  document.getElementById("details").hidden = false;
}

function appendEdgeSection(container, heading, edges, describe, root) {
  const h = document.createElement("h3");
  h.textContent = heading;
  container.appendChild(h);

  if (edges.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = "none";
    container.appendChild(none);
    return;
  }

  const sorted = [...edges].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  );
  for (const edge of sorted) {
    const item = document.createElement("div");
    item.className = `edge-item ${edge.status}`;

    const label = document.createElement("div");
    label.textContent = `${describe(edge)} — ${edge.status}, weight ${edge.weight}`;
    item.appendChild(label);

    for (const example of edge.examples) {
      const line = document.createElement("div");
      line.className = "edge-examples";
      line.appendChild(fileLink(root, example.from));
      line.appendChild(document.createTextNode(" → "));
      line.appendChild(fileLink(root, example.to));
      item.appendChild(line);
    }
    container.appendChild(item);
  }
}

// A finding you can act on: clicking a path opens the file in the editor,
// via main's open-file handler (the renderer itself never touches the fs).
function fileLink(root, relPath) {
  const span = document.createElement("span");
  span.className = "file-link";
  span.title = "Open in editor";
  span.textContent = relPath;
  span.addEventListener("click", () => {
    guard(() => window.drift.openFile(`${root}/${relPath}`));
  });
  return span;
}
