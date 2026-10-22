import type { AnalysisResult, ModuleEdge } from "./types.js";

/**
 * Mermaid text export of an analysis, for thesis figures and READMEs.
 * Deterministic like every other output: no timestamps, modules and edges
 * in the order the result already sorted them.
 */

const COLOUR = {
  convergent: "#8a8f98",
  divergent: "#e5484d",
  absent: "#8a8f98",
  module: "#4e79a7",
  diagonal: "#2e2e2e",
  empty: "#1a1a1a",
} as const;

/**
 * The graph view as a flowchart: nodes are modules, edge shape and colour
 * carry the reflexion status (solid grey convergent, thick red divergent,
 * dashed absent), offender nodes — sources of divergent edges — are red.
 */
export function toMermaidFlowchart(result: AnalysisResult): string {
  const id = idMapper(result.modules);
  const offenders = new Set(
    result.edges.filter((e) => e.status === "divergent").map((e) => e.from),
  );

  // Comments go after the diagram keyword so older Mermaid versions, which
  // detect the diagram type from the first non-blank line, still parse it.
  const lines: string[] = [
    "flowchart LR",
    ...header(result, "flowchart"),
    ...result.modules.map((m) =>
      offenders.has(m)
        ? `  ${id(m)}["${label(m)}"]:::offender`
        : `  ${id(m)}["${label(m)}"]`,
    ),
  ];

  // linkStyle addresses edges by order of appearance, so indices are
  // assigned while the edge lines are emitted.
  const divergentIndices: number[] = [];
  result.edges.forEach((e, i) => {
    lines.push(`  ${id(e.from)} ${arrow(e)} ${id(e.to)}`);
    if (e.status === "divergent") divergentIndices.push(i);
  });

  lines.push(
    `  classDef default fill:${COLOUR.module},stroke:#202020,color:#ffffff`,
    `  classDef offender fill:${COLOUR.divergent},stroke:#202020,color:#ffffff`,
    `  linkStyle default stroke:${COLOUR.convergent},stroke-width:1.5px`,
  );
  if (divergentIndices.length > 0) {
    lines.push(
      `  linkStyle ${divergentIndices.join(",")} stroke:${COLOUR.divergent},stroke-width:3px`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * The matrix view as a block-beta grid (Mermaid ≥ 10.6): a header row and
 * column of module names around an n×n grid of cells, each coloured by
 * status and labelled with its weight. `order` is the row/column order the
 * UI used, so the export matches the screen cell for cell.
 */
export function toMermaidMatrix(result: AnalysisResult, order: string[]): string {
  const edgeAt = new Map(result.edges.map((e) => [e.from + "\0" + e.to, e]));
  const n = order.length;

  const lines: string[] = [
    "block-beta",
    ...header(result, "matrix"),
    "  %% rows import columns; row/column order follows the intended layering",
    `  columns ${n + 1}`,
  ];
  const styles: string[] = [];

  // Header row: empty corner, then one block per column.
  lines.push(
    "  space " + order.map((m, c) => `col${c}["${label(m)}"]`).join(" "),
  );
  order.forEach((_, c) => styles.push(`  style col${c} ${headerStyle()}`));

  order.forEach((from, r) => {
    const cells = order.map((to, c) => {
      const cellId = `c${r}_${c}`;
      const edge = from === to ? null : (edgeAt.get(from + "\0" + to) ?? null);
      styles.push(`  style ${cellId} ${cellStyle(from === to, edge)}`);
      return `${cellId}["${cellLabel(from === to, edge)}"]`;
    });
    lines.push(`  row${r}["${label(from)}"] ` + cells.join(" "));
    styles.push(`  style row${r} ${headerStyle()}`);
  });

  return [...lines, ...styles].join("\n") + "\n";
}

function header(result: AnalysisResult, kind: string): string[] {
  const s = result.stats;
  return [
    `  %% Architectural drift (${kind}) — ${result.root}`,
    `  %% ${s.convergent} convergent, ${s.divergent} divergent, ${s.absent} absent; ` +
      `${s.fileCount} files, ${s.importCount} imports`,
    "  %% grey = convergent (in code, allowed), red = divergent (in code, forbidden), " +
      "dashed = absent (allowed, never built)",
  ];
}

function arrow(edge: ModuleEdge): string {
  switch (edge.status) {
    case "divergent":
      return `==>|${edge.weight}|`;
    case "absent":
      return "-.->";
    default:
      return `-->|${edge.weight}|`;
  }
}

function cellLabel(diagonal: boolean, edge: ModuleEdge | null): string {
  if (diagonal || edge === null) return " ";
  return edge.status === "absent" ? "·" : String(edge.weight);
}

function cellStyle(diagonal: boolean, edge: ModuleEdge | null): string {
  if (diagonal) return `fill:${COLOUR.diagonal},stroke:${COLOUR.diagonal}`;
  if (edge === null) return `fill:${COLOUR.empty},stroke:#262626`;
  if (edge.status === "absent") {
    return `fill:${COLOUR.empty},stroke:${COLOUR.absent},stroke-dasharray:3 2,color:${COLOUR.absent}`;
  }
  return `fill:${COLOUR[edge.status]},stroke:${COLOUR[edge.status]},color:#ffffff`;
}

function headerStyle(): string {
  return "fill:none,stroke:none,color:#c0c0c0";
}

/**
 * Mermaid node ids must be plain identifiers and must dodge its reserved
 * words (`end`, `graph`, `style`, ...), so every id gets a prefix and
 * non-identifier characters become underscores; collisions after that
 * get a numeric suffix. The human-readable name lives in the label.
 */
function idMapper(modules: string[]): (name: string) => string {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of modules) {
    let candidate = "m_" + name.replace(/[^A-Za-z0-9_]/g, "_");
    let suffix = 2;
    while (taken.has(candidate)) candidate = `${candidate}_${suffix++}`;
    taken.add(candidate);
    ids.set(name, candidate);
  }
  return (name) => ids.get(name) ?? "m_" + name.replace(/[^A-Za-z0-9_]/g, "_");
}

function label(name: string): string {
  return name.replaceAll('"', "#quot;");
}
