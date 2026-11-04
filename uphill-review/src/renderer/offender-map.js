import { hierarchy, treemap } from "d3-hierarchy";
import { el, hover, plural, segmented, svgEl } from "./ui.js";

/**
 * The cascade: the whole codebase as a cascaded treemap, with every folder
 * coloured by how much it breaks the stable-dependencies principle, and every
 * dependency drawn as an arrow the same way the flat treemap draws them.
 *
 * How to read it:
 * - Each rectangle is a folder. Its area is how many files it holds.
 * - Folders inside folders step in from the bottom-right, so the folder
 *   around them stays visible behind them (cascaded treemaps, Lü and
 *   Fogarty 2008).
 * - A link points uphill when a folder imports a folder that is less stable
 *   than itself. Its steepness is how big that difference in instability is.
 * - A folder's offence score is the sum of the steepness of its uphill
 *   links. Only links at least as steep as the slider count.
 * - White means no counted uphill links. Red means offending, and the darkest
 *   red on each nesting level is the worst folder on that level.
 * - Every folder is measured at its own depth: a parent is measured with its
 *   subfolders merged into it, so imports between its own subfolders do not
 *   count against it.
 *
 * The arrows work like the flat treemap's:
 * - Every dependency is an arrow, thicker when more files import across it,
 *   with that count written on the line. Each import is drawn once, from the
 *   most detailed rectangle it starts in.
 * - The slider hides arrows that climb by less than its value (0 shows every
 *   arrow, also downhill ones).
 * - Click a folder to keep only the arrows that touch it: blue leaves it
 *   (what it imports), red arrives (what depends on it). Click it again to
 *   see every arrow.
 * - Choosing a case in the To Decide list shows only that case's arrow.
 *
 * The "colour by" switch changes what the fill means (Marius's notes):
 * - score: the offence score above (the default).
 * - split: every folder goes to the stable side or the unstable side of one
 *   instability cut, found automatically (Otsu's method), so the tool, not
 *   a person, decides which group should depend on which. Arrows show only
 *   the stable side importing the unstable side.
 * - indirect: the highest instability a folder reaches through any chain of
 *   imports, minus its own. Click a folder to see the chain.
 * - coupling: how many file imports go between each folder and the picked one.
 *
 * The pull request part: the stepper moves from the codebase before the pull
 * request through each of its commits. The layout never moves; only colours,
 * outlines and arrows change. Outlines mark folders the pull request changed.
 * Arrows that became uphill during the pull request get a white glow, solid
 * when a new import did it and dashed for drift (the import was there and the
 * folders' instability moved).
 */

const SPACE_FOR_FOLDER_NAME = 16;
const CASCADE_STEP = 3;
const WHITE = [255, 255, 255];
const DARKEST_RED = [178, 24, 43];
const BACKGROUND_OF_WHOLE_CODEBASE = "#2e2e2e";
const WHAT_IT_IMPORTS = "#5aa2ff";
const WHAT_DEPENDS_ON_IT = "#ff6b6e";
const ROUNDING_NOISE = 1e-9;

/**
 * @param container       the element to draw into
 * @param review          the ReviewResult from the engine
 * @param viewSettings    { minimumSteepness, stepIndex, deepestDepthShown (null: all), colourMode, splitAt (null: automatic),
 *                          selectedFolderKey, caseToCompare: {from, to} | null }
 * @param whenUserDoes    { changeMinimumSteepness(value), changeStep(index), changeDepth(depth), changeColourMode(mode),
 *                          changeSplitAt(value or null), selectFolder(key), selectLink({from, to, depth}) }
 */
export function drawOffenderMap(container, review, viewSettings, whenUserDoes) {
  container.replaceChildren();
  const offenderMap = review.offenderMap;
  if (offenderMap.layoutFolders.length === 0) {
    container.append(el("p", "empty", "This repository has no architecture files to map."));
    return;
  }

  const stepIndex = Math.min(viewSettings.stepIndex, offenderMap.steps.length - 1);
  const step = offenderMap.steps[stepIndex];
  const minimumSteepness = viewSettings.minimumSteepness;
  // Folders deeper than this are folded into their ancestor at this depth, like the flat treemap's depth buttons.
  const deepestDepthShown = Math.min(viewSettings.deepestDepthShown ?? offenderMap.deepestFolderDepth, offenderMap.deepestFolderDepth);

  const width = Math.max(280, Math.floor(container.clientWidth || 640));
  const height = Math.max(420, Math.min(720, Math.round(width * 0.8)));
  const folderTree = buildFolderTree(offenderMap.layoutFolders, deepestDepthShown);
  const laidOutRoot = layOutCascadedTreemap(folderTree, width, height);
  const everyRectangle = laidOutRoot.descendants().filter((node) => node.x1 - node.x0 >= 1 && node.y1 - node.y0 >= 1);

  for (const rectangle of everyRectangle) {
    rectangle.offence = offenceOfFolder(rectangle.data, step, minimumSteepness);
  }
  const darkestScoreOnLevel = darkestScoreForEachNestingLevel(everyRectangle);
  const colourMode = viewSettings.colourMode ?? "score";
  const rectangleFor = rectangleFinder(everyRectangle, deepestDepthShown);
  const changedFolders = {
    inThisStep: new Set(step.foldersChangedInThisStep),
    sinceStart: new Set(step.foldersChangedSinceStart),
  };

  // Clicking the whole-codebase background selects nothing: every arrow is inside it.
  const selectedRectangle = everyRectangle.find((rectangle) => rectangle.depth > 0 && keyOfFolder(rectangle.data) === viewSettings.selectedFolderKey) ?? null;
  const caseToCompare = selectedRectangle === null ? (viewSettings.caseToCompare ?? null) : null;
  const allArrows = everyDependencyArrow(everyRectangle, step, rectangleFor, minimumSteepness);

  const automaticSplitAt = automaticSplit(everyRectangle);
  const splitAt = viewSettings.splitAt ?? automaticSplitAt;
  const colouring = colourEveryFolder(everyRectangle, colourMode, { darkestScoreOnLevel, splitAt, step, selectedRectangle, rectangleFor });

  let arrowsShown;
  if (colourMode === "indirect" && selectedRectangle !== null) {
    arrowsShown = arrowsAlongChain(selectedRectangle, step, rectangleFor);
  } else {
    const onlyStableImportingUnstable = colourMode === "split" ? splitAt : null;
    // Coupling counts every import, so its arrows ignore the climb slider too.
    const smallestClimbDrawn = colourMode === "coupling" && selectedRectangle !== null ? 0 : minimumSteepness;
    arrowsShown = chooseArrowsToShow(allArrows, { minimumSteepness: smallestClimbDrawn, selectedRectangle, caseToCompare, onlyStableImportingUnstable });
  }
  const foldersNearTheChoice = foldersTouchedBy(arrowsShown, selectedRectangle, caseToCompare);

  container.append(
    drawControls(offenderMap, { stepIndex, minimumSteepness, deepestDepthShown, colourMode, splitAt, automaticSplitAt }, whenUserDoes),
    describeWhatIsShown({ allArrows, arrowsShown, stepIndex, selectedRectangle, caseToCompare, colourMode, colouring, splitAt }),
    drawLegend(selectedRectangle !== null, colourMode),
  );

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "treemap offender-map", role: "img" });
  svg.setAttribute("aria-label",
    `Cascaded treemap of the codebase, folders coloured white to red by how much they import less stable folders, with ${arrowsShown.length} dependency arrows`);
  svg.append(drawingDefinitions());
  container.append(svg);

  // Outer folders first, so the folders inside them are drawn on top.
  const outerFirst = [...everyRectangle].sort((a, b) => a.depth - b.depth);
  for (const rectangle of outerFirst) {
    const dimmed = foldersNearTheChoice !== null && !foldersNearTheChoice.has(rectangle);
    svg.append(drawFolderRectangle(rectangle, { changedFolders, selectedRectangle, dimmed, whenUserDoes }));
  }
  for (const rectangle of outerFirst) {
    const dimmed = foldersNearTheChoice !== null && !foldersNearTheChoice.has(rectangle);
    const label = drawFolderLabel(rectangle, dimmed);
    if (label !== null) svg.append(label);
  }

  const arrowLayer = svgEl("g", { class: "deps" });
  svg.append(arrowLayer);
  const mostImportsOnOneArrow = Math.max(1, ...arrowsShown.map((arrow) => arrow.link.importCount));
  // Thin arrows first, so the thick ones are drawn on top and stay readable.
  for (const arrow of [...arrowsShown].sort((a, b) => a.link.importCount - b.link.importCount)) {
    drawDependencyArrow(arrowLayer, arrow, mostImportsOnOneArrow, whenUserDoes);
  }

  if (selectedRectangle !== null) container.append(describeSelectedFolder(selectedRectangle, minimumSteepness, colourMode, splitAt));
}

// ---------------------------------------------------------------------------
// The folder tree and its layout

/**
 * Turn the flat list of folders into a tree, folding every folder deeper
 * than `deepestDepthShown` into its ancestor at that depth. A folder that
 * holds files and also has subfolders gets an extra child, "files", for its
 * own files. Every node remembers at which level it is measured: its own
 * depth, except for "files", which is measured at the deepest level shown.
 * At that level its subfolders are separate folders, so "files" is just the
 * files directly in it.
 */
function buildFolderTree(layoutFolders, deepestDepthShown) {
  const root = { name: "codebase", folderPath: "", subfolders: new Map(), ownFileCount: 0 };
  for (const folder of layoutFolders) {
    const foldedPath = mergeToDepth(folder.folderPath, deepestDepthShown);
    const pathSegments = foldedPath === "." ? ["."] : foldedPath.split("/");
    let current = root;
    pathSegments.forEach((segment, index) => {
      if (!current.subfolders.has(segment)) {
        const folderPath = foldedPath === "." ? "." : pathSegments.slice(0, index + 1).join("/");
        current.subfolders.set(segment, { name: segment, folderPath, subfolders: new Map(), ownFileCount: 0 });
      }
      current = current.subfolders.get(segment);
    });
    current.ownFileCount += folder.fileCountForLayout;
  }
  return toTreemapNode(root, deepestDepthShown);
}

function toTreemapNode(folder, deepestDepthShown) {
  const isWholeCodebase = folder.folderPath === "";
  const measuredAtDepth = isWholeCodebase ? null : depthOfPath(folder.folderPath);
  const children = [...folder.subfolders.values()].map((subfolder) => toTreemapNode(subfolder, deepestDepthShown));

  if (children.length === 0) {
    return { name: folder.name, folderPath: folder.folderPath, measuredAtDepth, isOwnFilesCell: false, fileCount: folder.ownFileCount };
  }
  if (folder.ownFileCount > 0) {
    children.push({
      name: "files",
      folderPath: folder.folderPath,
      measuredAtDepth: deepestDepthShown,
      isOwnFilesCell: true,
      fileCount: folder.ownFileCount,
    });
  }
  return { name: folder.name, folderPath: folder.folderPath, measuredAtDepth, isOwnFilesCell: false, children };
}

/**
 * A squarified treemap, then the cascade: every level whose right or bottom
 * edge touches its parent's edge is pulled in a little, so the parent shows
 * as a card behind it. Biggest folders first, ties by name, so the same
 * codebase always gets the same picture.
 */
function layOutCascadedTreemap(folderTree, width, height) {
  const root = hierarchy(folderTree)
    .sum((node) => node.fileCount || 0)
    .sort((a, b) => b.value - a.value || a.data.folderPath.localeCompare(b.data.folderPath));
  treemap()
    .size([width, height])
    .paddingOuter(CASCADE_STEP)
    .paddingInner(1)
    .paddingTop((node) => (node.children ? SPACE_FOR_FOLDER_NAME : 0))
    .round(true)(root);
  pullInEdgesThatTouchTheParent(root, CASCADE_STEP);
  return root;
}

function pullInEdgesThatTouchTheParent(root, step) {
  const stepsInFromRight = new Map();
  const stepsInFromBottom = new Map();
  root.eachAfter((node) => {
    if (!node.children) {
      stepsInFromRight.set(node, 0);
      stepsInFromBottom.set(node, 0);
      return;
    }
    stepsInFromRight.set(node, deepestTouchingChild(node.children, (child) => child.x1 === node.x1 - step, stepsInFromRight));
    stepsInFromBottom.set(node, deepestTouchingChild(node.children, (child) => child.y1 === node.y1 - step, stepsInFromBottom));
  });
  root.eachBefore((node) => {
    node.x1 -= 2 * step * stepsInFromRight.get(node);
    node.y1 -= 2 * step * stepsInFromBottom.get(node);
  });
}

function deepestTouchingChild(children, touchesParentEdge, stepsOfChild) {
  let anyChildTouches = false;
  let mostSteps = 0;
  for (const child of children) {
    if (!touchesParentEdge(child)) continue;
    anyChildTouches = true;
    mostSteps = Math.max(mostSteps, stepsOfChild.get(child) || 0);
  }
  return anyChildTouches ? 1 + mostSteps : 0;
}

// ---------------------------------------------------------------------------
// Scores

/**
 * How much one folder offends at this step: its uphill links at its own
 * level that are at least as steep as the slider, and their steepness added up.
 * `existsAtThisStep` is false for a folder that has no files at this step
 * (created later in the pull request, or deleted by it).
 */
function offenceOfFolder(folder, step, minimumSteepness) {
  if (folder.measuredAtDepth === null) {
    return { existsAtThisStep: true, measured: null, countedLinks: [], allUphillLinks: [], score: 0 };
  }
  const level = step.levels[folder.measuredAtDepth - 1];
  const measured = level.folders[folder.folderPath] ?? null;
  const allUphillLinks = level.links.filter((link) => link.fromFolder === folder.folderPath && isUphill(link));
  const countedLinks = allUphillLinks.filter((link) => isAtLeastAsSteepAs(link, minimumSteepness));
  const score = countedLinks.reduce((sum, link) => sum + link.steepness, 0);
  return { existsAtThisStep: measured !== null, measured, countedLinks, allUphillLinks, score };
}

/** Nesting level (1 = top folders) -> the highest score on it and the folder that has it. */
function darkestScoreForEachNestingLevel(everyRectangle) {
  const darkest = new Map();
  for (const rectangle of everyRectangle) {
    if (rectangle.depth === 0) continue;
    const current = darkest.get(rectangle.depth);
    if (current === undefined || rectangle.offence.score > current.score) {
      darkest.set(rectangle.depth, { score: rectangle.offence.score, folder: rectangle.data });
    }
  }
  return darkest;
}

/** White for no offence, darkest red for the worst folder on the same nesting level. */
function colourForScore(score, darkestScoreOnThisLevel) {
  if (score <= 0 || darkestScoreOnThisLevel <= 0) return rgb(WHITE);
  const shareOfWorst = Math.min(1, score / darkestScoreOnThisLevel);
  return rgb(WHITE.map((channel, index) => Math.round(channel + (DARKEST_RED[index] - channel) * shareOfWorst)));
}

function shareOfWorstOnLevel(rectangle, darkestScoreOnLevel) {
  const darkest = darkestScoreOnLevel.get(rectangle.depth)?.score ?? 0;
  return darkest > 0 ? rectangle.offence.score / darkest : 0;
}

function isUphill(link) {
  return link.steepness > ROUNDING_NOISE;
}

function isAtLeastAsSteepAs(link, minimumSteepness) {
  return isUphill(link) && link.steepness >= minimumSteepness - ROUNDING_NOISE;
}

// ---------------------------------------------------------------------------
// Colour modes

const STABLE_SIDE = "#d6e2f0";
const UNSTABLE_SIDE = "#f2a65a";
const MOST_INDIRECT = [106, 61, 154];
const MOST_COUPLED = [21, 128, 120];

/**
 * Sets `fill` and `fillDarkness` (0 light to 1 dark, for the label colour) on
 * every rectangle for the chosen mode, and returns numbers for the summary.
 */
function colourEveryFolder(everyRectangle, colourMode, { darkestScoreOnLevel, splitAt, step, selectedRectangle, rectangleFor }) {
  const coupling = colourMode === "coupling" && selectedRectangle !== null
    ? couplingWithFolder(selectedRectangle, step, rectangleFor)
    : new Map();
  const mostCoupled = Math.max(1, ...coupling.values());
  const summary = { stableSide: 0, unstableSide: 0, reachIndirectly: 0, coupledFolders: coupling.size };

  for (const rectangle of everyRectangle) {
    rectangle.fillDarkness = 0;
    if (rectangle.depth === 0) {
      rectangle.fill = BACKGROUND_OF_WHOLE_CODEBASE;
      continue;
    }
    if (!rectangle.offence.existsAtThisStep) {
      rectangle.fill = "url(#not-here-yet)";
      continue;
    }
    const instability = rectangle.offence.measured.instability;

    if (colourMode === "split") {
      const onStableSide = instability < splitAt;
      rectangle.fill = onStableSide ? STABLE_SIDE : UNSTABLE_SIDE;
      if (!rectangle.children) summary[onStableSide ? "stableSide" : "unstableSide"] += 1;
    } else if (colourMode === "indirect") {
      rectangle.indirect = furthestClimbFrom(rectangle.data.folderPath, step.levels[rectangle.data.measuredAtDepth - 1]);
      rectangle.fillDarkness = Math.min(1, rectangle.indirect.climb);
      rectangle.fill = mixFromWhite(MOST_INDIRECT, rectangle.fillDarkness);
      if (!rectangle.children && rectangle.indirect.onlyIndirectly) summary.reachIndirectly += 1;
    } else if (colourMode === "coupling") {
      rectangle.fillDarkness = (coupling.get(rectangle) ?? 0) / mostCoupled;
      rectangle.fill = mixFromWhite(MOST_COUPLED, rectangle.fillDarkness);
    } else {
      const darkest = darkestScoreOnLevel.get(rectangle.depth)?.score ?? 0;
      rectangle.fillDarkness = shareOfWorstOnLevel(rectangle, darkestScoreOnLevel);
      rectangle.fill = colourForScore(rectangle.offence.score, darkest);
    }
  }
  return summary;
}

/**
 * Otsu's method on instability: try every cut between two neighbouring
 * values and keep the one that makes the two groups most different (the
 * largest variance between the groups), each folder weighted by its files.
 * Only rectangles without subfolders take part, so no file counts twice.
 */
function automaticSplit(everyRectangle) {
  const folders = everyRectangle
    .filter((rectangle) => !rectangle.children && rectangle.depth > 0 && rectangle.offence.existsAtThisStep)
    .map((rectangle) => ({ instability: rectangle.offence.measured.instability, files: Math.max(1, rectangle.offence.measured.filesInside) }))
    .sort((a, b) => a.instability - b.instability);
  const totalFiles = folders.reduce((sum, folder) => sum + folder.files, 0);
  const totalWeighted = folders.reduce((sum, folder) => sum + folder.files * folder.instability, 0);

  let bestCut = 0.5;
  let bestDifference = -1;
  let filesBelow = 0;
  let weightedBelow = 0;
  for (let index = 0; index < folders.length - 1; index++) {
    filesBelow += folders[index].files;
    weightedBelow += folders[index].files * folders[index].instability;
    if (folders[index + 1].instability - folders[index].instability < ROUNDING_NOISE) continue;
    const filesAbove = totalFiles - filesBelow;
    const averageBelow = weightedBelow / filesBelow;
    const averageAbove = (totalWeighted - weightedBelow) / filesAbove;
    const differenceBetweenGroups = filesBelow * filesAbove * (averageBelow - averageAbove) ** 2;
    if (differenceBetweenGroups > bestDifference) {
      bestDifference = differenceBetweenGroups;
      bestCut = (folders[index].instability + folders[index + 1].instability) / 2;
    }
  }
  return Math.round(bestCut * 100) / 100;
}

/**
 * Follows every chain of imports from one folder (within one level) and
 * finds the least stable folder it reaches; ties go to the shorter chain.
 * `climb` is that folder's instability minus the start's (0 when nothing
 * reached is less stable). `onlyIndirectly` is true when no direct import
 * climbs that high, so the risk only shows through other folders.
 */
function furthestClimbFrom(startFolder, level) {
  const startInstability = level.folders[startFolder]?.instability ?? 0;
  const importsOf = new Map();
  for (const link of level.links) {
    if (!importsOf.has(link.fromFolder)) importsOf.set(link.fromFolder, []);
    importsOf.get(link.fromFolder).push(link.toFolder);
  }

  const cameFrom = new Map([[startFolder, null]]);
  const stepsAway = new Map([[startFolder, 0]]);
  const queue = [startFolder];
  let best = null;
  while (queue.length > 0) {
    const folder = queue.shift();
    for (const next of importsOf.get(folder) ?? []) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, folder);
      stepsAway.set(next, stepsAway.get(folder) + 1);
      queue.push(next);
      const instability = level.folders[next]?.instability ?? 0;
      if (best === null || instability > best.instability + ROUNDING_NOISE) best = { folder: next, instability };
    }
  }

  const highestDirect = Math.max(startInstability, ...(importsOf.get(startFolder) ?? []).map((next) => level.folders[next]?.instability ?? 0));
  if (best === null || best.instability <= startInstability + ROUNDING_NOISE) {
    return { climb: 0, chain: [startFolder], onlyIndirectly: false };
  }
  const chain = [];
  for (let folder = best.folder; folder !== null; folder = cameFrom.get(folder)) chain.unshift(folder);
  return {
    climb: best.instability - startInstability,
    reachedInstability: best.instability,
    chain,
    onlyIndirectly: best.instability > highestDirect + ROUNDING_NOISE,
  };
}

/** The chain from the picked folder to the least stable folder it reaches, one arrow per import. */
function arrowsAlongChain(selectedRectangle, step, rectangleFor) {
  const level = step.levels[selectedRectangle.data.measuredAtDepth - 1];
  const chain = selectedRectangle.indirect?.chain ?? [];
  const arrows = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const link = level.links.find((candidate) => candidate.fromFolder === chain[index] && candidate.toFolder === chain[index + 1]);
    const source = index === 0 ? selectedRectangle : rectangleFor(chain[index], level.mergedToDepth);
    const target = rectangleFor(chain[index + 1], level.mergedToDepth);
    if (link === undefined || source === undefined || target === undefined || source === target) continue;
    arrows.push({ link, source, target, direction: "out", pullRequestStory: null });
  }
  return arrows;
}

/** Rectangle -> file imports between it and the picked folder, both ways, at the picked folder's level. */
function couplingWithFolder(selectedRectangle, step, rectangleFor) {
  const level = step.levels[selectedRectangle.data.measuredAtDepth - 1];
  const picked = selectedRectangle.data.folderPath;
  const importsBetween = new Map();
  for (const link of level.links) {
    const otherFolder = link.fromFolder === picked ? link.toFolder : link.toFolder === picked ? link.fromFolder : null;
    if (otherFolder === null) continue;
    const other = rectangleFor(otherFolder, level.mergedToDepth);
    if (other === undefined || other === selectedRectangle) continue;
    importsBetween.set(other, (importsBetween.get(other) ?? 0) + link.importCount);
  }
  return importsBetween;
}

function mixFromWhite(colour, share) {
  return rgb(WHITE.map((channel, index) => Math.round(channel + (colour[index] - channel) * Math.min(1, Math.max(0, share)))));
}

// ---------------------------------------------------------------------------
// Arrows

/**
 * Every dependency as an arrow. Each import is drawn once, from the rectangle
 * without subfolders it starts in, at that rectangle's own level, so the
 * other end is the folder it imports as seen at that level.
 */
function everyDependencyArrow(everyRectangle, step, rectangleFor, minimumSteepness) {
  const arrows = [];
  for (const source of everyRectangle) {
    if (source.children || source.data.measuredAtDepth === null) continue;
    const level = step.levels[source.data.measuredAtDepth - 1];
    for (const link of level.links) {
      if (link.fromFolder !== source.data.folderPath) continue;
      const target = rectangleFor(link.toFolder, source.data.measuredAtDepth);
      if (target === undefined || target === source) continue;
      arrows.push({
        link,
        source,
        target,
        importerInstability: level.folders[link.fromFolder]?.instability ?? 0,
        importedInstability: level.folders[link.toFolder]?.instability ?? 0,
        pullRequestStory: whatThePullRequestDidToLink(link, minimumSteepness),
      });
    }
  }
  return arrows;
}

/**
 * "new import" or "drift" when the link counts as uphill now but did not
 * before the pull request; null when the pull request did not make it uphill.
 */
function whatThePullRequestDidToLink(link, minimumSteepness) {
  if (!isAtLeastAsSteepAs(link, minimumSteepness)) return null;
  const countedBefore = link.steepnessBeforePullRequest !== null &&
    link.steepnessBeforePullRequest > ROUNDING_NOISE &&
    link.steepnessBeforePullRequest >= minimumSteepness - ROUNDING_NOISE;
  if (countedBefore) return null;
  return link.importsAddedByPullRequest > 0 ? "new import" : "drift";
}

/**
 * Same rules as the flat treemap: a case from the To Decide list shows only
 * its arrow; otherwise the slider hides climbs below its value, and a picked
 * folder keeps only the arrows that touch it.
 */
function chooseArrowsToShow(allArrows, { minimumSteepness, selectedRectangle, caseToCompare, onlyStableImportingUnstable }) {
  if (caseToCompare !== null) {
    return allArrows
      .filter((arrow) => arrowMatchesCase(arrow, caseToCompare))
      .map((arrow) => ({ ...arrow, direction: "out" }));
  }
  const shown = [];
  for (const arrow of allArrows) {
    if (onlyStableImportingUnstable !== null) {
      // Split mode: only the stable side importing the unstable side, whatever the slider says.
      const crossesTheSplit = arrow.importerInstability < onlyStableImportingUnstable && arrow.importedInstability >= onlyStableImportingUnstable;
      if (!crossesTheSplit) continue;
    } else if (minimumSteepness > 0 && !isAtLeastAsSteepAs(arrow.link, minimumSteepness)) continue;
    if (selectedRectangle === null) {
      shown.push({ ...arrow, direction: "out" });
      continue;
    }
    const startsInSelection = isInside(arrow.source, selectedRectangle);
    const endsInSelection = isInside(arrow.target, selectedRectangle);
    if (startsInSelection === endsInSelection) continue; // touches it from neither side, or stays inside it
    shown.push({ ...arrow, direction: startsInSelection ? "out" : "in" });
  }
  return shown;
}

/**
 * A case names two folders exactly. Its arrow starts at the first folder's
 * rectangle and ends at the second folder as the arrow's own level sees it
 * (merged to that many path segments).
 */
function arrowMatchesCase(arrow, caseToCompare) {
  const startsAtCaseFolder = arrow.source.data.folderPath === caseToCompare.from;
  const caseTargetAtThisLevel = mergeToDepth(caseToCompare.to, arrow.source.data.measuredAtDepth);
  return startsAtCaseFolder && arrow.link.toFolder === caseTargetAtThisLevel;
}

/** The rectangles to keep bright while a folder or a case is picked; null when nothing is picked. */
function foldersTouchedBy(arrowsShown, selectedRectangle, caseToCompare) {
  if (selectedRectangle === null && caseToCompare === null) return null;
  const bright = new Set();
  for (const arrow of arrowsShown) {
    for (const end of [arrow.source, arrow.target]) {
      for (let rectangle = end; rectangle !== null; rectangle = rectangle.parent) bright.add(rectangle);
    }
  }
  if (selectedRectangle !== null) {
    selectedRectangle.each((inside) => bright.add(inside));
    for (let rectangle = selectedRectangle; rectangle !== null; rectangle = rectangle.parent) bright.add(rectangle);
  }
  return bright;
}

/**
 * Finds the rectangle a link points to. At the deepest level shown a folder
 * that also has subfolders means only its own files, so the "files" cell;
 * at any other level it means the folder with everything inside it.
 */
function rectangleFinder(everyRectangle, deepestDepthShown) {
  const folderRectangle = new Map();
  const ownFilesRectangle = new Map();
  for (const rectangle of everyRectangle) {
    if (rectangle.depth === 0) continue;
    if (rectangle.data.isOwnFilesCell) ownFilesRectangle.set(rectangle.data.folderPath, rectangle);
    else folderRectangle.set(rectangle.data.folderPath, rectangle);
  }
  return (folderPath, levelOfTheLink) => {
    if (levelOfTheLink === deepestDepthShown && ownFilesRectangle.has(folderPath)) return ownFilesRectangle.get(folderPath);
    return folderRectangle.get(folderPath);
  };
}

function isInside(rectangle, possibleAncestor) {
  for (let current = rectangle; current !== null; current = current.parent) {
    if (current === possibleAncestor) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drawing

function drawFolderRectangle(rectangle, { changedFolders, selectedRectangle, dimmed, whenUserDoes }) {
  const folder = rectangle.data;
  const group = svgEl("g", rectangle.children ? { filter: "url(#cascade-shadow)" } : {});
  const isWholeCodebase = rectangle.depth === 0;
  const fill = rectangle.fill;

  const shape = svgEl("rect", {
    class: `${rectangle.children ? "frame" : "cell"}${dimmed ? " dim" : ""}`,
    x: rectangle.x0,
    y: rectangle.y0,
    width: rectangle.x1 - rectangle.x0,
    height: rectangle.y1 - rectangle.y0,
    fill,
    role: "button",
    tabindex: "0",
    "aria-label": describeFolderInOneLine(rectangle),
  });
  hover(shape, () => describeFolderForTooltip(rectangle));
  const select = () => whenUserDoes.selectFolder(keyOfFolder(folder));
  shape.addEventListener("click", select);
  shape.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  group.append(shape);

  // Outlines: changed by the pull request, and the folder the user picked.
  const outlines = [];
  if (!rectangle.children && !isWholeCodebase) {
    if (changedFolders.inThisStep.has(folder.folderPath)) outlines.push("changed-in-this-step");
    else if (changedFolders.sinceStart.has(folder.folderPath)) outlines.push("changed-earlier-in-pull-request");
  }
  if (rectangle === selectedRectangle) outlines.push("selected");
  for (const outline of outlines) {
    group.append(svgEl("rect", {
      class: `outline ${outline}`,
      x: rectangle.x0 + 1.5,
      y: rectangle.y0 + 1.5,
      width: Math.max(0, rectangle.x1 - rectangle.x0 - 3),
      height: Math.max(0, rectangle.y1 - rectangle.y0 - 3),
    }));
  }
  return group;
}

function drawFolderLabel(rectangle, dimmed) {
  const width = rectangle.x1 - rectangle.x0;
  const height = rectangle.y1 - rectangle.y0;
  if (width < 28 || height < 12) return null;

  const isDarkFill = rectangle.depth === 0 || rectangle.fillDarkness > 0.55;
  const group = svgEl("g", { class: `label${isDarkFill ? " on-dark" : ""}${dimmed ? " dim" : ""}` });
  const clipId = `offender-map-clip-${rectangle.x0}-${rectangle.y0}-${rectangle.depth}`;
  const clip = svgEl("clipPath", { id: clipId });
  clip.append(svgEl("rect", { x: rectangle.x0, y: rectangle.y0, width, height }));
  group.append(clip);

  const text = svgEl("text", { "clip-path": `url(#${clipId})` });
  const name = svgEl("tspan", { x: rectangle.x0 + 4, y: rectangle.y0 + 13 });
  name.textContent = rectangle.data.folderPath === "." ? "root" : rectangle.data.name;
  text.append(name);
  if (!rectangle.children && height >= 30 && rectangle.offence.score > 0) {
    const numbers = svgEl("tspan", { x: rectangle.x0 + 4, y: rectangle.y0 + 26, class: "count" });
    numbers.textContent = rectangle.offence.score > 0 ? rectangle.offence.score.toFixed(2) : "";
    text.append(numbers);
  }
  group.append(text);
  return group;
}

/** A straight arrow between the middles of two folders, drawn like the flat treemap's. */
function drawDependencyArrow(layer, arrow, mostImportsOnOneArrow, whenUserDoes) {
  const { link, source, target, direction, pullRequestStory } = arrow;
  const line = shortenAtBothEnds(middleOf(source), middleOf(target), 16);
  const thickness = (1.25 + (link.importCount / mostImportsOnOneArrow) * 4).toFixed(2);
  const coordinates = { x1: line.start.x, y1: line.start.y, x2: line.end.x, y2: line.end.y };

  if (pullRequestStory !== null) {
    layer.append(svgEl("line", {
      class: `became-uphill-glow ${pullRequestStory === "new import" ? "by-new-import" : "by-drift"}`,
      ...coordinates,
      "stroke-width": (Number(thickness) + 5).toFixed(2),
    }));
  }
  layer.append(svgEl("line", {
    class: `dep ${direction}${pullRequestStory === "drift" ? " by-drift" : ""}`,
    ...coordinates,
    "stroke-width": thickness,
    "marker-end": direction === "in" ? "url(#cascade-arrow-in)" : "url(#cascade-arrow-out)",
  }));

  const clickArea = svgEl("line", {
    class: "dep-hit",
    ...coordinates,
    role: "button",
    tabindex: "0",
    "aria-label": `${link.fromFolder} imports ${link.toFolder}, ${plural(link.importCount, "file")}, steepness ${link.steepness.toFixed(2)}`,
  });
  hover(clickArea, () => describeArrowForTooltip(arrow));
  const selectThisLink = () => whenUserDoes.selectLink({ from: link.fromFolder, to: link.toFolder, depth: source.data.measuredAtDepth });
  clickArea.addEventListener("click", (event) => {
    event.stopPropagation();
    selectThisLink();
  });
  clickArea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectThisLink();
    }
  });
  layer.append(clickArea);

  const length = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
  if (length < 46) return;
  const importCountLabel = svgEl("text", {
    class: `weight ${direction}`,
    x: line.start.x + (line.end.x - line.start.x) * 0.55,
    y: line.start.y + (line.end.y - line.start.y) * 0.55,
    "text-anchor": "middle",
  });
  importCountLabel.textContent = String(link.importCount);
  layer.append(importCountLabel);
}

function drawingDefinitions() {
  const definitions = svgEl("defs");

  const shadow = svgEl("filter", { id: "cascade-shadow", x: "-20%", y: "-20%", width: "140%", height: "140%" });
  shadow.append(svgEl("feDropShadow", { "flood-color": "#000", "flood-opacity": "0.45", dx: "0", dy: "1", stdDeviation: "1.4" }));

  const notHereYet = svgEl("pattern", { id: "not-here-yet", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  notHereYet.append(svgEl("rect", { width: 6, height: 6, fill: "#3a3a3a" }), svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#5a5a5a", "stroke-width": 2 }));

  definitions.append(shadow, notHereYet, arrowHead("cascade-arrow-out", WHAT_IT_IMPORTS), arrowHead("cascade-arrow-in", WHAT_DEPENDS_ON_IT));
  return definitions;
}

function arrowHead(id, colour) {
  const marker = svgEl("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, markerUnits: "userSpaceOnUse", orient: "auto" });
  marker.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: colour }));
  return marker;
}

// ---------------------------------------------------------------------------
// Controls, legend and text

function drawControls(offenderMap, { stepIndex, minimumSteepness, deepestDepthShown, colourMode, splitAt, automaticSplitAt }, whenUserDoes) {
  const controls = el("div", "view-head offender-map-controls");

  const deepest = offenderMap.deepestFolderDepth;
  const depthChoices = [];
  for (let depth = 1; depth <= deepest; depth++) {
    depthChoices.push({
      value: depth,
      label: depth === deepest ? "all" : `depth ${depth}`,
      title: depth === deepest ? "Every folder on its own" : `Folders merged to their first ${plural(depth, "path segment")}`,
    });
  }
  controls.append(segmented(depthChoices, deepestDepthShown, (depth) => whenUserDoes.changeDepth(depth), "Folder depth"));

  const colourChoice = el("div", "control");
  colourChoice.append(el("span", "lbl", "colour"), segmented([
    { value: "score", label: "score", title: "Red: how much a folder imports less stable folders" },
    { value: "split", label: "split", title: "Stable side and unstable side, split automatically. Arrows: the stable side importing the unstable side" },
    { value: "indirect", label: "indirect", title: "Purple: the least stable folder it reaches through any chain of imports, minus its own instability" },
    { value: "coupling", label: "coupling", title: "Green: file imports to and from the folder you pick" },
  ], colourMode, (mode) => whenUserDoes.changeColourMode(mode), "Colour by"));
  controls.append(colourChoice);

  if (colourMode === "split") {
    const splitControl = el("label", "control");
    splitControl.append(el("span", "lbl", "split at I"));
    const splitSlider = el("input");
    Object.assign(splitSlider, { type: "range", min: "0.05", max: "0.95", step: "0.05", value: String(splitAt) });
    splitSlider.setAttribute("aria-label", "Instability that separates the stable side from the unstable side");
    const splitReadout = el("span", "readout", splitAt.toFixed(2));
    splitSlider.addEventListener("input", () => {
      splitReadout.textContent = Number(splitSlider.value).toFixed(2);
    });
    splitSlider.addEventListener("change", () => whenUserDoes.changeSplitAt(Number(splitSlider.value)));
    const automatic = el("button", splitAt === automaticSplitAt ? "on" : "", `auto ${automaticSplitAt.toFixed(2)}`);
    automatic.type = "button";
    automatic.title = "The cut that makes the two groups most different (Otsu's method)";
    automatic.addEventListener("click", () => whenUserDoes.changeSplitAt(null));
    splitControl.append(splitSlider, splitReadout, automatic);
    controls.append(splitControl);
  }

  const steepnessControl = el("label", "control");
  steepnessControl.hidden = colourMode === "split";
  steepnessControl.append(el("span", "lbl", "min climb"));
  const steepnessSlider = el("input");
  Object.assign(steepnessSlider, { type: "range", min: "0", max: "1", step: "0.1", value: String(minimumSteepness) });
  steepnessSlider.setAttribute("aria-label", "Smallest climb in instability that counts and is drawn");
  const steepnessReadout = el("span", "readout", describeSlider(minimumSteepness));
  steepnessSlider.addEventListener("input", () => {
    steepnessReadout.textContent = describeSlider(Number(steepnessSlider.value));
  });
  steepnessSlider.addEventListener("change", () => whenUserDoes.changeMinimumSteepness(Number(steepnessSlider.value)));
  steepnessControl.append(steepnessSlider, steepnessReadout);
  controls.append(steepnessControl);

  const lastStep = offenderMap.steps.length - 1;
  const stepControl = el("div", "control step-control");
  const earlier = el("button", "", "◀");
  earlier.type = "button";
  earlier.disabled = stepIndex === 0;
  earlier.addEventListener("click", () => whenUserDoes.changeStep(stepIndex - 1));
  const later = el("button", "", "▶");
  later.type = "button";
  later.disabled = stepIndex === lastStep;
  later.addEventListener("click", () => whenUserDoes.changeStep(stepIndex + 1));
  const stepSlider = el("input");
  Object.assign(stepSlider, { type: "range", min: "0", max: String(lastStep), step: "1", value: String(stepIndex) });
  stepSlider.disabled = lastStep === 0;
  stepSlider.setAttribute("aria-label", "Step through the pull request");
  stepSlider.addEventListener("change", () => whenUserDoes.changeStep(Number(stepSlider.value)));
  stepControl.append(el("span", "lbl", "PR"), earlier, stepSlider, later);
  controls.append(stepControl);

  controls.append(el("p", "step-caption", describeStep(offenderMap, stepIndex)));
  return controls;
}

function describeSlider(value) {
  return value > 0 ? value.toFixed(1) : "all";
}

function describeStep(offenderMap, stepIndex) {
  const step = offenderMap.steps[stepIndex];
  const commitsShown = offenderMap.steps.length - 1;
  if (step.commit === null) return commitsShown === 0 ? "No PR commits" : `Before PR (0/${commitsShown})`;
  const who = step.commit.cls === "agent" ? "agent" : step.commit.cls;
  return `${stepIndex}/${commitsShown} · ${step.commit.subject} · ${who}`;
}

function describeWhatIsShown({ allArrows, arrowsShown, stepIndex, selectedRectangle, caseToCompare, colourMode, colouring, splitAt }) {
  const parts = [];
  if (colourMode === "split") {
    parts.push(`split at I ${splitAt.toFixed(2)}: ${colouring.stableSide} stable · ${colouring.unstableSide} unstable · ${arrowsShown.length} stable → unstable`);
  } else if (colourMode === "indirect" && selectedRectangle !== null) {
    const found = selectedRectangle.indirect;
    parts.push(found.climb > 0
      ? `${nameForPeople(selectedRectangle.data)} reaches I ${found.reachedInstability.toFixed(2)} in ${plural(found.chain.length - 1, "step")} (climb ${found.climb.toFixed(2)}${found.onlyIndirectly ? ", only indirectly" : ""})`
      : `${nameForPeople(selectedRectangle.data)} reaches nothing less stable`);
  } else if (colourMode === "indirect") {
    parts.push(`${colouring.reachIndirectly} folders reach less stable code only indirectly · pick one for its chain`);
  } else if (colourMode === "coupling") {
    parts.push(selectedRectangle === null
      ? "pick a folder"
      : `${nameForPeople(selectedRectangle.data)}: coupled to ${plural(colouring.coupledFolders, "folder")}`);
  } else if (selectedRectangle !== null) {
    const importsCount = arrowsShown.filter((arrow) => arrow.direction === "out").length;
    parts.push(`${nameForPeople(selectedRectangle.data)}: imports ${importsCount}, imported by ${arrowsShown.length - importsCount}`);
  } else if (caseToCompare !== null) {
    parts.push(`${caseToCompare.from} → ${caseToCompare.to}` + (arrowsShown.length === 0 ? " (no arrow here)" : ""));
  } else {
    parts.push(`${arrowsShown.length}/${allArrows.length} arrows`);
  }
  if (stepIndex > 0) {
    const becameUphill = allArrows.filter((arrow) => arrow.pullRequestStory !== null);
    const byDrift = becameUphill.filter((arrow) => arrow.pullRequestStory === "drift").length;
    parts.push(`+${becameUphill.length} uphill in PR` + (byDrift > 0 ? ` (${byDrift} drift)` : ""));
  }
  return el("p", "view-summary", parts.join(" · "));
}

function drawLegend(aFolderIsSelected, colourMode) {
  const legend = el("div", "legend offender-legend");
  const scale = el("span", "legend-item");
  if (colourMode === "split") {
    scale.append(el("i", "sw side stable"), el("span", "", "stable side"), el("i", "sw side unstable"), el("span", "", "unstable side"));
  } else if (colourMode === "indirect") {
    scale.title = "How much less stable the least stable folder it reaches through imports is";
    scale.append(el("span", "", "0"), el("i", "offence-scale-bar indirect"), el("span", "", "1 climb"));
  } else if (colourMode === "coupling") {
    scale.title = "File imports between each folder and the picked one, both ways";
    scale.append(el("span", "", "none"), el("i", "offence-scale-bar coupling"), el("span", "", "most"));
  } else {
    scale.title = "White: no uphill links. Darkest red: the worst folder on its nesting level.";
    scale.append(el("span", "", "ok"), el("i", "offence-scale-bar"), el("span", "", "worst"));
  }
  legend.append(scale);
  const key = (className, text) => {
    const item = el("span", "legend-item");
    item.append(el("i", className), document.createTextNode(text));
    legend.append(item);
  };
  key("sw line out", colourMode === "split" ? "stable imports unstable" : colourMode === "indirect" && aFolderIsSelected ? "chain" : "imports");
  if (aFolderIsSelected && colourMode !== "indirect") key("sw line in", "imported by");
  key("sw line became-uphill", "new uphill");
  key("sw outline-key changed-in-this-step", "changed");
  return legend;
}

function describeSelectedFolder(rectangle, minimumSteepness, colourMode, splitAt) {
  const box = el("div", "selected-folder");
  const offence = rectangle.offence;
  box.append(el("h3", "", nameForPeople(rectangle.data)));
  if (!offence.existsAtThisStep) {
    box.append(el("p", "", "No files at this step"));
    return box;
  }
  box.append(el("p", "", `I ${offence.measured.instability.toFixed(2)} · score ${offence.score.toFixed(2)}`));
  if (colourMode === "split") {
    box.append(el("p", "", offence.measured.instability < splitAt ? "stable side" : "unstable side"));
  }
  if (colourMode === "indirect" && rectangle.indirect !== undefined && rectangle.indirect.chain.length > 1) {
    box.append(el("p", "", `chain: ${rectangle.indirect.chain.join(" → ")}`));
  }
  const list = el("ul", "uphill-links");
  const MOST_LINKS_LISTED = 3;
  for (const link of offence.allUphillLinks.slice(0, MOST_LINKS_LISTED)) {
    const counted = isAtLeastAsSteepAs(link, minimumSteepness);
    const added = link.steepnessBeforePullRequest === null ? " · new" : link.importsAddedByPullRequest > 0 ? ` · +${link.importsAddedByPullRequest}` : "";
    list.append(el("li", counted ? "counted" : "below-slider", `→ ${link.toFolder}  ${link.steepness.toFixed(2)} · ${link.importCount}${added}`));
  }
  const notListed = offence.allUphillLinks.length - MOST_LINKS_LISTED;
  if (notListed > 0) list.append(el("li", "below-slider", `+${notListed} more`));
  if (offence.allUphillLinks.length > 0) box.append(list);
  return box;
}

function describeArrowForTooltip({ link, pullRequestStory }) {
  const climb = isUphill(link) ? `climbs ${link.steepness.toFixed(2)}` : `down ${Math.abs(link.steepness).toFixed(2)}`;
  const story = pullRequestStory === null ? "" : ` · uphill in PR (${pullRequestStory})`;
  return `${link.fromFolder} → ${link.toFolder}\n${plural(link.importCount, "import")} · ${climb}${story}`;
}

function describeFolderForTooltip(rectangle) {
  const folder = rectangle.data;
  if (folder.measuredAtDepth === null) return "codebase";
  if (!rectangle.offence.existsAtThisStep) return `${nameForPeople(folder)}\nno files at this step`;
  return `${nameForPeople(folder)}\nI ${rectangle.offence.measured.instability.toFixed(2)} · score ${rectangle.offence.score.toFixed(2)}`;
}

function describeFolderInOneLine(rectangle) {
  const folder = rectangle.data;
  if (folder.measuredAtDepth === null) return "The whole codebase";
  return `${nameForPeople(folder)}, offence ${rectangle.offence.score.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Small helpers

function keyOfFolder(folder) {
  if (folder.isOwnFilesCell) return `${folder.folderPath}#files-here`;
  return folder.folderPath || "codebase";
}

function nameForPeople(folder) {
  const path = folder.folderPath === "." ? "repository root" : folder.folderPath || "the whole codebase";
  return folder.isOwnFilesCell ? `${path} (files)` : path;
}

/** "src/core/money" merged to 2 path segments is "src/core". The repository root "." stays ".". */
function mergeToDepth(folderPath, depth) {
  if (folderPath === ".") return ".";
  return folderPath.split("/").slice(0, depth).join("/");
}

function depthOfPath(folderPath) {
  return folderPath === "." ? 1 : folderPath.split("/").length;
}

function middleOf(rectangle) {
  return { x: (rectangle.x0 + rectangle.x1) / 2, y: (rectangle.y0 + rectangle.y1) / 2 };
}

/** Pull both ends of a line in by `gap`, so the arrow head does not sit on the label in the middle of the folder. */
function shortenAtBothEnds(start, end, gap) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length <= gap * 2) return { start, end };
  const along = gap / length;
  return {
    start: { x: start.x + (end.x - start.x) * along, y: start.y + (end.y - start.y) * along },
    end: { x: end.x - (end.x - start.x) * along, y: end.y - (end.y - start.y) * along },
  };
}

function rgb([red, green, blue]) {
  return `rgb(${red}, ${green}, ${blue})`;
}
