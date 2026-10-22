/**
 * The data contract between the analysis engine and the Electron UI.
 *
 * This file imports nothing on purpose: both halves of the thesis depend on
 * these shapes, so it must stay free of engine and UI concerns. Changing a
 * shape here affects both sides — flag it, don't edit it silently.
 */

/**
 * A single TypeScript source file found in the analyzed repository.
 */
export interface FileNode {
  /** Repo-relative path, forward slashes on every platform. */
  id: string;
  /**
   * Name of the architecture module this file was assigned to, or null when
   * no module glob matched. Null is a finding (reported as unmapped), never
   * an error.
   */
  module: string | null;
}

/**
 * A file-level import: `from` imports `to`. Both are repo-relative paths.
 */
export interface FileEdge {
  from: string;
  to: string;
}

/**
 * The raw factual graph extracted from the repository as it exists on disk.
 * Everything here is observed, not interpreted: no modules, no judgment.
 */
export interface RawGraph {
  /** Absolute path of the analyzed repository root. */
  root: string;
  files: FileNode[];
  imports: FileEdge[];
  /**
   * Imports whose specifier could not be resolved to a file inside the repo
   * (npm packages, unresolved aliases, dynamic requires). Counted, never
   * silently dropped — it measures how much of the picture is missing.
   */
  unresolvedImports: number;
}

/**
 * The intended architecture as declared by a human being.
 *
 * This represents human-declared intent and must NEVER be derived from
 * parsed imports. An intended architecture generated from the actual code
 * can never disagree with it, which would make drift undetectable and
 * invalidate the method the thesis rests on. The tool may propose module
 * names from the folder layout, but `allowed` edges are left empty for a
 * human to fill in.
 */
export interface ArchitectureSpec {
  /** Module name -> glob patterns (matched against repo-relative paths). */
  modules: Record<string, string[]>;
  /** Module name -> names of modules it is allowed to depend on. */
  allowed: Record<string, string[]>;
}

/**
 * Reflexion-model status of a module-level edge.
 * - convergent: exists in code and is allowed by the spec
 * - divergent:  exists in code but is not allowed — this is the drift
 * - absent:     declared in the spec but never built in the code
 */
export type EdgeStatus = "convergent" | "divergent" | "absent";

/**
 * A module-level edge: file imports rolled up to the modules that contain
 * them. This is what the UI draws.
 */
export interface ModuleEdge {
  from: string;
  to: string;
  status: EdgeStatus;
  /** Number of file-level imports behind this edge. Zero for absent edges. */
  weight: number;
  /**
   * Up to five concrete file imports backing this edge, so a finding can be
   * verified by opening real files instead of trusting a number.
   */
  examples: FileEdge[];
}

/**
 * The full result of comparing a repository against an architecture spec.
 * This is the top-level object handed to the UI as JSON.
 */
export interface AnalysisResult {
  root: string;
  /** All module names from the spec, sorted. */
  modules: string[];
  /** Module name -> number of files mapped to it. Keys sorted. */
  fileCounts: Record<string, number>;
  edges: ModuleEdge[];
  /** Repo-relative paths of files that matched no module glob, sorted. */
  unmappedFiles: string[];
  stats: {
    fileCount: number;
    importCount: number;
    unresolvedImports: number;
    unmappedFiles: number;
    convergent: number;
    divergent: number;
    absent: number;
  };
}
