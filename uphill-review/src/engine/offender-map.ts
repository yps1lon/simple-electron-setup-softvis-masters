import { isArchitectureFile } from "./imports.js";
import { folderLinks, folderOf, folderStability, linkKey, mergeFolder } from "./stability.js";
import type {
  CommitRef,
  LayoutFolder,
  MeasuredFolder,
  MeasuredLevel,
  MeasuredUphillLink,
  OffenderMap,
  PullRequestStep,
  Snapshot,
} from "./types.js";

/**
 * The offender map: the numbers behind the cascaded treemap.
 *
 * For every step of a pull request (the codebase before it, then after each
 * of its commits) and for every folder depth, this measures each folder's
 * instability and lists every link that points uphill. The view does the
 * rest: it lets the user pick how steep a link must be to count (the
 * slider), adds up each folder's steepness into an offence score, and
 * colours white to red.
 *
 * Nothing here judges or filters by a threshold. That keeps the slider in
 * the view, where moving it does not need a new analysis.
 */

/** A pull request with more commits than this shows an even spread of them, always including the last. */
export const MOST_COMMITS_SHOWN = 40;

/** Steepness this close to zero counts as flat, not uphill (rounding noise). */
const FLAT_ENOUGH = 1e-9;

export interface CommitInPullRequest {
  commit: CommitRef;
  /** The import graph right after this commit. */
  snapshot: Snapshot;
  /** Files changed since the step before (the previous commit shown, or the start). */
  filesChangedSinceStepBefore: string[];
}

export interface OffenderMapInput {
  /** The import graph where the branch left the base: the codebase before the pull request. */
  snapshotBeforePullRequest: Snapshot;
  /** The commits to show, oldest first. */
  commitsInPullRequest: CommitInPullRequest[];
  someCommitsSkipped: boolean;
}

export function buildOffenderMap(input: OffenderMapInput): OffenderMap {
  const before = input.snapshotBeforePullRequest;
  const everySnapshot = [before, ...input.commitsInPullRequest.map((step) => step.snapshot)];
  const deepestFolderDepth = deepestDepthIn(everySnapshot);

  const startingPoint = rememberStartingPoint(before, deepestFolderDepth);

  const steps: PullRequestStep[] = [
    {
      commit: null,
      foldersChangedInThisStep: [],
      foldersChangedSinceStart: [],
      levels: measureEveryLevel(before, deepestFolderDepth, startingPoint),
    },
  ];

  const foldersChangedSoFar = new Set<string>();
  for (const step of input.commitsInPullRequest) {
    const foldersChangedNow = foldersHoldingArchitectureFiles(step.filesChangedSinceStepBefore);
    for (const folder of foldersChangedNow) foldersChangedSoFar.add(folder);
    steps.push({
      commit: step.commit,
      foldersChangedInThisStep: foldersChangedNow,
      foldersChangedSinceStart: [...foldersChangedSoFar].sort(),
      levels: measureEveryLevel(step.snapshot, deepestFolderDepth, startingPoint),
    });
  }

  return {
    layoutFolders: layoutFoldersFrom(everySnapshot),
    deepestFolderDepth,
    steps,
    someCommitsSkipped: input.someCommitsSkipped,
  };
}

/**
 * Which commits become steps. All of them when there are few; otherwise an
 * even spread that always keeps the newest commit, since that is the state
 * the pull request would merge.
 */
export function chooseCommitsToShow(commitsOldestFirst: string[]): { commits: string[]; someCommitsSkipped: boolean } {
  const total = commitsOldestFirst.length;
  if (total <= MOST_COMMITS_SHOWN) return { commits: commitsOldestFirst, someCommitsSkipped: false };
  const chosen: string[] = [];
  for (let slot = 1; slot <= MOST_COMMITS_SHOWN; slot++) {
    const position = Math.round((slot * total) / MOST_COMMITS_SHOWN) - 1;
    const commit = commitsOldestFirst[position];
    if (chosen.at(-1) !== commit) chosen.push(commit);
  }
  return { commits: chosen, someCommitsSkipped: true };
}

// ---------------------------------------------------------------------------
// Measuring

/** What the codebase looked like before the pull request, kept so every later step can be compared with it. */
interface StartingPoint {
  /** Level -> linkKey(from, to) -> steepness, for every link, uphill or not. */
  steepnessOfEveryLinkByLevel: Map<number, Map<string, number>>;
  /** Every file import that existed before the pull request, as fileImportKey(from, to). */
  fileImportsThatExisted: Set<string>;
}

function rememberStartingPoint(before: Snapshot, deepestFolderDepth: number): StartingPoint {
  const steepnessOfEveryLinkByLevel = new Map<number, Map<string, number>>();
  for (let depth = 1; depth <= deepestFolderDepth; depth++) {
    const mergeToThisDepth = (folder: string) => mergeFolder(folder, depth);
    const stabilityOfFolder = folderStability(before.files, before.edges, mergeToThisDepth);
    const steepnessOfLink = new Map<string, number>();
    for (const link of folderLinks(before.edges, mergeToThisDepth).values()) {
      const importerInstability = stabilityOfFolder.get(link.from)?.instability ?? 0;
      const importedInstability = stabilityOfFolder.get(link.to)?.instability ?? 0;
      steepnessOfLink.set(linkKey(link.from, link.to), importedInstability - importerInstability);
    }
    steepnessOfEveryLinkByLevel.set(depth, steepnessOfLink);
  }
  const fileImportsThatExisted = new Set(before.edges.map((edge) => fileImportKey(edge.from, edge.to)));
  return { steepnessOfEveryLinkByLevel, fileImportsThatExisted };
}

function measureEveryLevel(snapshot: Snapshot, deepestFolderDepth: number, startingPoint: StartingPoint): MeasuredLevel[] {
  const levels: MeasuredLevel[] = [];
  for (let depth = 1; depth <= deepestFolderDepth; depth++) {
    levels.push(measureOneLevel(snapshot, depth, startingPoint));
  }
  return levels;
}

/**
 * One level: merge every folder to `mergedToDepth` path segments, count
 * instability again for the merged folders, and keep the links that point
 * uphill. Imports between two folders that merge into one stop being links,
 * which is why a parent can look clean while a child inside it offends.
 */
function measureOneLevel(snapshot: Snapshot, mergedToDepth: number, startingPoint: StartingPoint): MeasuredLevel {
  const mergeToThisDepth = (folder: string) => mergeFolder(folder, mergedToDepth);
  const stabilityOfFolder = folderStability(snapshot.files, snapshot.edges, mergeToThisDepth);

  const folders: Record<string, MeasuredFolder> = {};
  const folderPathsInOrder = [...stabilityOfFolder.keys()].sort((a, b) => a.localeCompare(b));
  for (const folderPath of folderPathsInOrder) {
    const measured = stabilityOfFolder.get(folderPath)!;
    folders[folderPath] = {
      instability: roundToThreeDecimals(measured.instability),
      filesInside: measured.files,
      importedByFiles: measured.afferent,
      importsFilesOutside: measured.efferent,
    };
  }

  const steepnessBeforeOfLink = startingPoint.steepnessOfEveryLinkByLevel.get(mergedToDepth) ?? new Map<string, number>();
  const uphillLinks: MeasuredUphillLink[] = [];
  for (const link of folderLinks(snapshot.edges, mergeToThisDepth).values()) {
    const importerInstability = stabilityOfFolder.get(link.from)?.instability ?? 0;
    const importedInstability = stabilityOfFolder.get(link.to)?.instability ?? 0;
    const steepness = importedInstability - importerInstability;
    if (steepness <= FLAT_ENOUGH) continue;

    const steepnessBefore = steepnessBeforeOfLink.get(linkKey(link.from, link.to));
    const importsAddedByPullRequest = link.imports.filter(
      (fileImport) => !startingPoint.fileImportsThatExisted.has(fileImportKey(fileImport.from, fileImport.to)),
    ).length;

    uphillLinks.push({
      fromFolder: link.from,
      toFolder: link.to,
      steepness: roundToThreeDecimals(steepness),
      importCount: link.imports.length,
      steepnessBeforePullRequest: steepnessBefore === undefined ? null : roundToThreeDecimals(steepnessBefore),
      importsAddedByPullRequest,
    });
  }
  uphillLinks.sort(
    (a, b) => b.steepness - a.steepness || a.fromFolder.localeCompare(b.fromFolder) || a.toFolder.localeCompare(b.toFolder),
  );

  return { mergedToDepth, folders, uphillLinks };
}

// ---------------------------------------------------------------------------
// Small helpers

/**
 * Every folder that holds files at any step, sized by how many different
 * files it held across all of them. Using every step at once is what keeps
 * the layout still while stepping through commits.
 */
function layoutFoldersFrom(snapshots: Snapshot[]): LayoutFolder[] {
  const filesEverInFolder = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const folder = folderOf(file);
      let files = filesEverInFolder.get(folder);
      if (files === undefined) {
        files = new Set<string>();
        filesEverInFolder.set(folder, files);
      }
      files.add(file);
    }
  }
  return [...filesEverInFolder.entries()]
    .map(([folderPath, files]) => ({ folderPath, fileCountForLayout: files.size }))
    .sort((a, b) => a.folderPath.localeCompare(b.folderPath));
}

/** How many path segments the deepest folder has ("." and "src" both count as 1). */
function deepestDepthIn(snapshots: Snapshot[]): number {
  let deepest = 1;
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const folder = folderOf(file);
      const depth = folder === "." ? 1 : folder.split("/").length;
      if (depth > deepest) deepest = depth;
    }
  }
  return deepest;
}

/** The folders of the changed files that the analysis looks at (tests and generated code are left out). */
function foldersHoldingArchitectureFiles(changedFiles: string[]): string[] {
  const folders = new Set<string>();
  for (const file of changedFiles) {
    if (isArchitectureFile(file)) folders.add(folderOf(file));
  }
  return [...folders].sort();
}

function fileImportKey(importingFile: string, importedFile: string): string {
  return importingFile + "\0" + importedFile;
}

function roundToThreeDecimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}
