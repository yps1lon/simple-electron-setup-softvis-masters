import { drawGraph } from "./graph.js";
import { drawMatrix, layerOrder } from "./matrix.js";
import { guard, setStatus } from "./status.js";

// The app shell: holds the state, wires the buttons, talks to main through
// the preload bridge and hands the result to whichever view is selected.
// The drawing itself lives in matrix.js and graph.js, the side panel in
// details.js.

// Renderer state is just the two paths the user picked; everything else is
// derived from the latest AnalysisResult handed over the preload bridge.
let repoPath = null;
let specPath = null;

// The last AnalysisResult, kept so switching views re-renders without a
// re-analysis; and which idiom is showing. Matrix is the primary view.
let lastResult = null;
let view = "matrix";

// Returned by whichever draw function ran last, so the panel's close button
// (wired once at startup) clears the selection of the view on screen.
let clearSelection = null;

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pick-repo").addEventListener("click", onPickRepo);
  document.getElementById("propose-spec").addEventListener("click", onProposeSpec);
  document.getElementById("load-spec").addEventListener("click", onLoadSpec);
  document.getElementById("analyze").addEventListener("click", onAnalyze);
  document.getElementById("export-mermaid").addEventListener("click", onExportMermaid);
  document.getElementById("details-close").addEventListener("click", () => {
    if (clearSelection !== null) clearSelection();
  });
  document.getElementById("view-matrix").addEventListener("click", () => {
    view = "matrix";
    render();
  });
  document.getElementById("view-graph").addEventListener("click", () => {
    view = "graph";
    render();
  });
});

async function onPickRepo() {
  const picked = await window.drift.pickFolder();
  if (picked !== null) {
    repoPath = picked;
    setStatus(`repo: ${repoPath}`);
  }
}

async function onProposeSpec() {
  if (repoPath === null) {
    setStatus("pick a repository first");
    return;
  }
  await guard(async () => {
    const yaml = await window.drift.propose(repoPath);
    const pre = document.getElementById("spec-output");
    pre.hidden = false;
    pre.textContent = yaml;
    setStatus("proposed spec below — save it as .yaml, fill in `allowed`, then load it");
  });
}

async function onLoadSpec() {
  const picked = await window.drift.pickSpec();
  if (picked !== null) {
    specPath = picked;
    setStatus(`spec: ${specPath}`);
  }
}

async function onAnalyze() {
  if (repoPath === null || specPath === null) {
    setStatus("pick a repository and load a spec first");
    return;
  }
  await guard(async () => {
    lastResult = await window.drift.analyze(repoPath, specPath);
    renderStats(lastResult.stats);
    render();
    setStatus(`analyzed ${lastResult.root}`);
  });
}

// Exports whichever view is on screen. The matrix export gets the same
// row order the drawing used (layerOrder is deterministic), so the file
// and the screen agree cell for cell.
async function onExportMermaid() {
  if (lastResult === null) {
    setStatus("analyze a repository first");
    return;
  }
  await guard(async () => {
    const order = view === "matrix" ? layerOrder(lastResult) : null;
    const saved = await window.drift.exportMermaid(lastResult, view, order);
    setStatus(saved === null ? "export cancelled" : `exported ${view} to ${saved}`);
  });
}

function render() {
  if (lastResult === null) return;
  document.getElementById("view-matrix").classList.toggle("active", view === "matrix");
  document.getElementById("view-graph").classList.toggle("active", view === "graph");
  document.getElementById("legend").hidden = false;
  document.getElementById("legend-note").textContent =
    view === "matrix"
      ? "row imports column · stronger colour = more file imports · red below the diagonal = layer inversion"
      : "arrow points at the imported module · thicker = divergent · red node = imports something forbidden";
  clearSelection = view === "matrix" ? drawMatrix(lastResult) : drawGraph(lastResult);
}

function renderStats(stats) {
  const bar = document.getElementById("stats");
  bar.replaceChildren();
  const items = [
    ["files", stats.fileCount],
    ["imports", stats.importCount],
    ["divergent", stats.divergent],
    ["absent", stats.absent],
    ["convergent", stats.convergent],
    ["unmapped files", stats.unmappedFiles],
    ["unresolved imports", stats.unresolvedImports]
  ];
  for (const [label, value] of items) {
    const chip = document.createElement("span");
    chip.textContent = `${label}: ${value}`;
    if (label === "divergent" && value > 0) {
      chip.className = "divergent";
    }
    bar.appendChild(chip);
  }
}
