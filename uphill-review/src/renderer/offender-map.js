import { hierarchy, treemap } from "d3-hierarchy";
import { el, hover, plural, svgEl } from "./ui.js";

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
 * @param viewSettings    { minimumSteepness, stepIndex, selectedFolderKey, caseToCompare: {from, to} | null }
 * @param whenUserDoes    { changeMinimumSteepness(value), changeStep(index), selectFolder(key), selectLink({from, to, depth}) }
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

  const width = Math.max(280, Math.floor(container.clientWidth || 640));
  const height = Math.max(420, Math.min(720, Math.round(width * 0.8)));
  const folderTree = buildFolderTree(offenderMap.layoutFolders, offenderMap.deepestFolderDepth);
  const laidOutRoot = layOutCascadedTreemap(folderTree, width, height);
  const everyRectangle = laidOutRoot.descendants().filter((node) => node.x1 - node.x0 >= 1 && node.y1 - node.y0 >= 1);

  for (const rectangle of everyRectangle) {
    rectangle.offence = offenceOfFolder(rectangle.data, step, minimumSteepness);
  }
  const darkestScoreOnLevel = darkestScoreForEachNestingLevel(everyRectangle);
  const changedFolders = {
    inThisStep: new Set(step.foldersChangedInThisStep),
    sinceStart: new Set(step.foldersChangedSinceStart),
  };

  // Clicking the whole-codebase background selects nothing: every arrow is inside it.
  const selectedRectangle = everyRectangle.find((rectangle) => rectangle.depth > 0 && keyOfFolder(rectangle.data) === viewSettings.selectedFolderKey) ?? null;
  const caseToCompare = selectedRectangle === null ? (viewSettings.caseToCompare ?? null) : null;
  const allArrows = everyDependencyArrow(everyRectangle, step, offenderMap.deepestFolderDepth, minimumSteepness);
  const arrowsShown = chooseArrowsToShow(allArrows, { minimumSteepness, selectedRectangle, caseToCompare });
  const foldersNearTheChoice = foldersTouchedBy(arrowsShown, selectedRectangle, caseToCompare);

  container.append(
    drawControls(offenderMap, stepIndex, minimumSteepness, whenUserDoes),
    describeWhatIsShown({ allArrows, arrowsShown, stepIndex, selectedRectangle, caseToCompare }),
    drawLegend(selectedRectangle !== null),
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
    svg.append(drawFolderRectangle(rectangle, { darkestScoreOnLevel, changedFolders, selectedRectangle, dimmed, whenUserDoes }));
  }
  for (const rectangle of outerFirst) {
    const dimmed = foldersNearTheChoice !== null && !foldersNearTheChoice.has(rectangle);
    const label = drawFolderLabel(rectangle, darkestScoreOnLevel, dimmed);
    if (label !== null) svg.append(label);
  }

  const arrowLayer = svgEl("g", { class: "deps" });
  svg.append(arrowLayer);
  const mostImportsOnOneArrow = Math.max(1, ...arrowsShown.map((arrow) => arrow.link.importCount));
  // Thin arrows first, so the thick ones are drawn on top and stay readable.
  for (const arrow of [...arrowsShown].sort((a, b) => a.link.importCount - b.link.importCount)) {
    drawDependencyArrow(arrowLayer, arrow, mostImportsOnOneArrow, whenUserDoes);
  }

  if (selectedRectangle !== null) container.append(describeSelectedFolder(selectedRectangle, minimumSteepness));
}

// ---------------------------------------------------------------------------
// The folder tree and its layout

/**
 * Turn the flat list of folders into a tree. A folder that holds files and
 * also has subfolders gets an extra child, "files here", for its own files.
 * Every node remembers at which level it is measured: its own depth, except
 * for "files here", which is measured with nothing merged, so it is just
 * the files directly in that folder.
 */
function buildFolderTree(layoutFolders, deepestFolderDepth) {
  const root = { name: "codebase", folderPath: "", subfolders: new Map(), ownFileCount: 0 };
  for (const folder of layoutFolders) {
    const pathSegments = folder.folderPath === "." ? ["."] : folder.folderPath.split("/");
    let current = root;
    pathSegments.forEach((segment, index) => {
      if (!current.subfolders.has(segment)) {
        const folderPath = folder.folderPath === "." ? "." : pathSegments.slice(0, index + 1).join("/");
        current.subfolders.set(segment, { name: segment, folderPath, subfolders: new Map(), ownFileCount: 0 });
      }
      current = current.subfolders.get(segment);
    });
    current.ownFileCount = folder.fileCountForLayout;
  }
  return toTreemapNode(root, deepestFolderDepth);
}

function toTreemapNode(folder, deepestFolderDepth) {
  const isWholeCodebase = folder.folderPath === "";
  const measuredAtDepth = isWholeCodebase ? null : depthOfPath(folder.folderPath);
  const children = [...folder.subfolders.values()].map((subfolder) => toTreemapNode(subfolder, deepestFolderDepth));

  if (children.length === 0) {
    return { name: folder.name, folderPath: folder.folderPath, measuredAtDepth, isOwnFilesCell: false, fileCount: folder.ownFileCount };
  }
  if (folder.ownFileCount > 0) {
    children.push({
      name: "files",
      folderPath: folder.folderPath,
      measuredAtDepth: deepestFolderDepth,
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
// Arrows

/**
 * Every dependency as an arrow. Each import is drawn once, from the rectangle
 * without subfolders it starts in, at that rectangle's own level, so the
 * other end is the folder it imports as seen at that level.
 */
function everyDependencyArrow(everyRectangle, step, deepestFolderDepth, minimumSteepness) {
  const rectangleFor = rectangleFinder(everyRectangle, deepestFolderDepth);
  const arrows = [];
  for (const source of everyRectangle) {
    if (source.children || source.data.measuredAtDepth === null) continue;
    const level = step.levels[source.data.measuredAtDepth - 1];
    for (const link of level.links) {
      if (link.fromFolder !== source.data.folderPath) continue;
      const target = rectangleFor(link.toFolder, source.data.measuredAtDepth);
      if (target === undefined || target === source) continue;
      arrows.push({ link, source, target, pullRequestStory: whatThePullRequestDidToLink(link, minimumSteepness) });
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
function chooseArrowsToShow(allArrows, { minimumSteepness, selectedRectangle, caseToCompare }) {
  if (caseToCompare !== null) {
    return allArrows
      .filter((arrow) => arrowMatchesCase(arrow, caseToCompare))
      .map((arrow) => ({ ...arrow, direction: "out" }));
  }
  const shown = [];
  for (const arrow of allArrows) {
    if (minimumSteepness > 0 && !isAtLeastAsSteepAs(arrow.link, minimumSteepness)) continue;
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
 * Finds the rectangle a link points to. At the deepest level a folder that
 * also has subfolders means only its own files, so the "files here" cell;
 * at any other level it means the folder with everything inside it.
 */
function rectangleFinder(everyRectangle, deepestFolderDepth) {
  const folderRectangle = new Map();
  const ownFilesRectangle = new Map();
  for (const rectangle of everyRectangle) {
    if (rectangle.depth === 0) continue;
    if (rectangle.data.isOwnFilesCell) ownFilesRectangle.set(rectangle.data.folderPath, rectangle);
    else folderRectangle.set(rectangle.data.folderPath, rectangle);
  }
  return (folderPath, levelOfTheLink) => {
    if (levelOfTheLink === deepestFolderDepth && ownFilesRectangle.has(folderPath)) return ownFilesRectangle.get(folderPath);
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

function drawFolderRectangle(rectangle, { darkestScoreOnLevel, changedFolders, selectedRectangle, dimmed, whenUserDoes }) {
  const folder = rectangle.data;
  const group = svgEl("g", rectangle.children ? { filter: "url(#cascade-shadow)" } : {});
  const isWholeCodebase = rectangle.depth === 0;
  const darkest = darkestScoreOnLevel.get(rectangle.depth)?.score ?? 0;

  let fill = BACKGROUND_OF_WHOLE_CODEBASE;
  if (!isWholeCodebase) fill = rectangle.offence.existsAtThisStep ? colourForScore(rectangle.offence.score, darkest) : "url(#not-here-yet)";

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

function drawFolderLabel(rectangle, darkestScoreOnLevel, dimmed) {
  const width = rectangle.x1 - rectangle.x0;
  const height = rectangle.y1 - rectangle.y0;
  if (width < 28 || height < 12) return null;

  const isDarkFill = rectangle.depth === 0 || shareOfWorstOnLevel(rectangle, darkestScoreOnLevel) > 0.55;
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

function drawControls(offenderMap, stepIndex, minimumSteepness, whenUserDoes) {
  const controls = el("div", "view-head offender-map-controls");

  const steepnessControl = el("label", "control");
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

function describeWhatIsShown({ allArrows, arrowsShown, stepIndex, selectedRectangle, caseToCompare }) {
  const parts = [];
  if (selectedRectangle !== null) {
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

function drawLegend(aFolderIsSelected) {
  const legend = el("div", "legend offender-legend");
  const scale = el("span", "legend-item");
  scale.title = "White: no uphill links. Darkest red: the worst folder on its nesting level.";
  scale.append(el("span", "", "ok"), el("i", "offence-scale-bar"), el("span", "", "worst"));
  legend.append(scale);
  const key = (className, text) => {
    const item = el("span", "legend-item");
    item.append(el("i", className), document.createTextNode(text));
    legend.append(item);
  };
  key("sw line out", "imports");
  if (aFolderIsSelected) key("sw line in", "imported by");
  key("sw line became-uphill", "new uphill");
  key("sw outline-key changed-in-this-step", "changed");
  return legend;
}

function describeSelectedFolder(rectangle, minimumSteepness) {
  const box = el("div", "selected-folder");
  const offence = rectangle.offence;
  box.append(el("h3", "", nameForPeople(rectangle.data)));
  if (!offence.existsAtThisStep) {
    box.append(el("p", "", "No files at this step"));
    return box;
  }
  box.append(el("p", "", `I ${offence.measured.instability.toFixed(2)} · score ${offence.score.toFixed(2)}`));
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
