import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { Project } from "ts-morph";
import type { FileEdge, FileNode, RawGraph } from "./types.js";

/**
 * What this parser cannot see, by construction:
 * - dynamic import() expressions — only static import/export declarations
 *   are read, so lazily loaded coupling is invisible
 * - dependency injection and other runtime wiring — no static specifier
 *   exists to resolve
 * - path aliases when the repo has no tsconfig.json — there is nothing to
 *   resolve them against, so those imports land in unresolvedImports
 *
 * These are known gaps of the prototype, reported rather than hidden.
 */

/**
 * Extract the raw factual graph of a TypeScript repository: every source
 * file, and every static import or re-export between them. No modules, no
 * judgment — that happens later, against a human-written spec.
 */
export function parseRepository(root: string): RawGraph {
  const absoluteRoot = path.resolve(root);
  const project = createProject(absoluteRoot);

  const files: FileNode[] = [];
  const imports: FileEdge[] = [];
  const seenEdges = new Set<string>();
  let unresolvedImports = 0;

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (!isInsideRepo(absoluteRoot, filePath)) continue;
    // Declaration files carry no runtime coupling, as sources or targets.
    if (filePath.endsWith(".d.ts")) continue;

    const from = toRepoPath(absoluteRoot, filePath);
    files.push({ id: from, module: null });

    // Re-exports are read alongside imports because barrel files
    // (index.ts that re-export a folder) carry a lot of real coupling.
    const declarations = [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ];

    for (const declaration of declarations) {
      // A local export (`export { x }`) has no specifier and no coupling.
      if (declaration.getModuleSpecifier() === undefined) continue;

      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || !isInsideRepo(absoluteRoot, target.getFilePath())) {
        // Unresolvable or pointing outside the repo (npm packages, aliases
        // without tsconfig): counted, never thrown, never silently dropped.
        unresolvedImports++;
        continue;
      }

      const targetPath = target.getFilePath();
      if (targetPath === filePath) continue; // self-import
      if (targetPath.endsWith(".d.ts")) continue;

      const to = toRepoPath(absoluteRoot, targetPath);
      // One edge per file pair: repeated import statements of the same
      // target are one coupling fact, not several.
      const key = from + "\0" + to;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      imports.push({ from, to });
    }
  }

  // Deterministic output: two runs against the same commit must produce
  // byte-identical JSON.
  files.sort((a, b) => a.id.localeCompare(b.id));
  imports.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  return {
    root: toPosixPath(absoluteRoot),
    files,
    imports,
    unresolvedImports,
  };
}

function createProject(absoluteRoot: string): Project {
  const tsconfigPath = path.join(absoluteRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    // The repo's own tsconfig is what makes its path aliases resolve.
    return new Project({ tsConfigFilePath: tsconfigPath });
  }
  const project = new Project({});
  for (const filePath of findSourceFiles(absoluteRoot)) {
    project.addSourceFileAtPath(filePath);
  }
  return project;
}

/**
 * ts-morph's globbing (tinyglobby) silently matches nothing when handed an
 * absolute Windows path, so the no-tsconfig fallback walks the tree itself
 * and matches repo-relative paths with minimatch. Sorted so the order files
 * enter the project does not depend on filesystem enumeration order.
 */
function findSourceFiles(absoluteRoot: string): string[] {
  const pattern = "**/*.{ts,tsx,mts,cts}";
  // .git is skipped alongside the required three: it never contains source.
  const skippedDirs = new Set(["node_modules", "dist", "build", ".git"]);
  const matches: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirs.has(entry.name)) walk(fullPath);
      } else if (
        entry.isFile() &&
        minimatch(toRepoPath(absoluteRoot, fullPath), pattern)
      ) {
        matches.push(fullPath);
      }
    }
  }

  walk(absoluteRoot);
  return matches.sort();
}

function isInsideRepo(absoluteRoot: string, filePath: string): boolean {
  const relative = path.relative(absoluteRoot, filePath);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function toRepoPath(absoluteRoot: string, filePath: string): string {
  return toPosixPath(path.relative(absoluteRoot, filePath));
}

/** Forward slashes on every platform, so output is comparable across OSes. */
function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}
