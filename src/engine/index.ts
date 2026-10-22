/**
 * Library entry point of the engine. The Electron main process imports the
 * compiled version of this file (src/engine/dist/index.js) directly —
 * there is no command-line interface by deliberate decision. The hard
 * rule stands: nothing under src/engine/ may import electron, d3, or
 * anything browser-only.
 */
export { compare } from "./compare.js";
export { toMermaidFlowchart, toMermaidMatrix } from "./mermaid.js";
export { parseRepository } from "./parse.js";
export { assignModules, loadSpec, proposeSpec } from "./spec.js";
export type {
  AnalysisResult,
  ArchitectureSpec,
  EdgeStatus,
  FileEdge,
  FileNode,
  ModuleEdge,
  RawGraph,
} from "./types.js";
