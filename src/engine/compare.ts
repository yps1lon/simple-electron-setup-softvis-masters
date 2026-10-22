import type {
  AnalysisResult,
  ArchitectureSpec,
  EdgeStatus,
  ModuleEdge,
  RawGraph,
} from "./types.js";

/**
 * Examples exist so a finding can be verified by opening real files instead
 * of trusting a number. Five keeps the JSON small enough to stay readable.
 */
const MAX_EXAMPLES = 5;

/**
 * Roll the raw file-level graph up to module level and judge every
 * module-to-module edge against the declared intent (reflexion model):
 * convergent (built and allowed), divergent (built but forbidden — the
 * drift), absent (allowed but never built).
 */
export function compare(
  graph: RawGraph,
  spec: ArchitectureSpec,
): AnalysisResult {
  const moduleOfFile = new Map<string, string | null>();
  for (const file of graph.files) {
    moduleOfFile.set(file.id, file.module);
  }

  const rolled = new Map<string, ModuleEdge>();
  for (const edge of graph.imports) {
    const from = moduleOfFile.get(edge.from) ?? null;
    const to = moduleOfFile.get(edge.to) ?? null;
    // A boundary crossing cannot be judged when a side's module is unknown.
    if (from === null || to === null) continue;
    // Edges inside a single module cross no boundary.
    if (from === to) continue;

    const key = from + "\0" + to;
    let aggregate = rolled.get(key);
    if (aggregate === undefined) {
      aggregate = { from, to, status: "divergent", weight: 0, examples: [] };
      rolled.set(key, aggregate);
    }
    aggregate.weight += 1;
    if (aggregate.examples.length < MAX_EXAMPLES) {
      aggregate.examples.push({ from: edge.from, to: edge.to });
    }
  }

  for (const aggregate of rolled.values()) {
    const allowedTargets = spec.allowed[aggregate.from] ?? [];
    aggregate.status = allowedTargets.includes(aggregate.to)
      ? "convergent"
      : "divergent";
  }

  const edges = [...rolled.values()];

  // Allowed edges that never appeared in the code: declared, never built.
  for (const [from, targets] of Object.entries(spec.allowed)) {
    for (const to of targets) {
      if (!rolled.has(from + "\0" + to)) {
        edges.push({ from, to, status: "absent", weight: 0, examples: [] });
      }
    }
  }

  const unmappedFiles = graph.files
    .filter((file) => file.module === null)
    .map((file) => file.id)
    .sort();

  // Keys inserted in sorted order so the JSON serialization stays
  // deterministic (object key order follows insertion order).
  const fileCounts: Record<string, number> = {};
  for (const name of Object.keys(spec.modules).sort()) {
    fileCounts[name] = 0;
  }
  for (const file of graph.files) {
    if (file.module !== null) {
      fileCounts[file.module] += 1;
    }
  }

  const countByStatus = (status: EdgeStatus): number =>
    edges.filter((edge) => edge.status === status).length;

  // Deterministic output: same commit in, byte-identical JSON out.
  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.status.localeCompare(b.status),
  );

  return {
    root: graph.root,
    modules: Object.keys(spec.modules).sort(),
    fileCounts,
    edges,
    unmappedFiles,
    stats: {
      fileCount: graph.files.length,
      importCount: graph.imports.length,
      unresolvedImports: graph.unresolvedImports,
      unmappedFiles: unmappedFiles.length,
      convergent: countByStatus("convergent"),
      divergent: countByStatus("divergent"),
      absent: countByStatus("absent"),
    },
  };
}
