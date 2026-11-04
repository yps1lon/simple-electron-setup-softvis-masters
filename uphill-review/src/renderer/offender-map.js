import { hierarchy, treemap } from "d3-hierarchy";
import { el, hover, plural, svgEl } from "./ui.js";

/**
 * The offender map: the whole codebase as a cascaded treemap, with every
 * folder coloured by how much it breaks the stable-dependencies principle.
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
 * The pull request part: the stepper moves from the codebase before the pull
 * request through each of its commits. The layout never moves; only colours,
 * outlines and arrows change. Blue outlines mark folders the pull request
 * changed, and blue arrows mark links that became uphill during it (solid:
 * a new import did it; dashed: drift, the import was there and the folders'
 * instability moved).
 */

const SPACE_FOR_FOLDER_NAME = 16;
const CASCADE_STEP = 3;
const WHITE = [255, 255, 255];
const DARKEST_RED = [178, 24, 43];
const BACKGROUND_OF_WHOLE_CODEBASE = "#2e2e2e";

/**
 * @param container       the element to draw into
 * @param review          the ReviewResult from the engine
 * @param viewSettings    { minimumSteepness, stepIndex, selectedFolderKey }
 * @param whenUserDoes    { changeMinimumSteepness(value), changeStep(index), selectFolder(key) }
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
  const linksThatBecameUphill = findLinksThatBecameUphill(everyRectangle, minimumSteepness, offenderMap.deepestFolderDepth);

  container.append(
    drawControls(offenderMap, stepIndex, minimumSteepness, whenUserDoes),
    describeWhatIsShown(everyRectangle, linksThatBecameUphill, step, stepIndex),
    drawLegend(darkestScoreOnLevel, everyRectangle),
  );

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "treemap offender-map", role: "img" });
  svg.setAttribute("aria-label", "Cascaded treemap of the codebase, folders coloured white to red by how much they import less stable folders");
  svg.append(drawingDefinitions());
  container.append(svg);

  // Outer folders first, so the folders inside them are drawn on top.
  const outerFirst = [...everyRectangle].sort((a, b) => a.depth - b.depth);
  for (const rectangle of outerFirst) {
    svg.append(drawFolderRectangle(rectangle, darkestScoreOnLevel, changedFolders, viewSettings.selectedFolderKey, whenUserDoes));
  }
  for (const rectangle of outerFirst) {
    const label = drawFolderLabel(rectangle, darkestScoreOnLevel);
    if (label !== null) svg.append(label);
  }
  for (const link of linksThatBecameUphill) svg.append(drawArrow(link));

  const selectedRectangle = everyRectangle.find((rectangle) => keyOfFolder(rectangle.data) === viewSettings.selectedFolderKey);
  if (selectedRectangle !== undefined) container.append(describeSelectedFolder(selectedRectangle, minimumSteepness));
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
      name: "files here",
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
  const allUphillLinks = level.uphillLinks.filter((link) => link.fromFolder === folder.folderPath);
  const countedLinks = allUphillLinks.filter((link) => link.steepness >= minimumSteepness - 1e-9);
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

// ---------------------------------------------------------------------------
// Links that became uphill during the pull request

/**
 * Only for folders drawn without subfolders (so each link is drawn once, at
 * the most detailed rectangle). A link counts when it is at least as steep
 * as the slider now, and was not before the pull request.
 */
function findLinksThatBecameUphill(everyRectangle, minimumSteepness, deepestFolderDepth) {
  const rectangleFor = rectangleFinder(everyRectangle, deepestFolderDepth);
  const found = [];
  for (const rectangle of everyRectangle) {
    if (rectangle.children) continue;
    for (const link of rectangle.offence.countedLinks) {
      const wasUphillBefore = link.steepnessBeforePullRequest !== null && link.steepnessBeforePullRequest >= minimumSteepness - 1e-9;
      if (wasUphillBefore) continue;
      const target = rectangleFor(link.toFolder, rectangle.data.measuredAtDepth);
      if (target === undefined) continue;
      found.push({
        link,
        source: rectangle,
        target,
        cause: link.importsAddedByPullRequest > 0 ? "new import" : "drift",
      });
    }
  }
  return found;
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

// ---------------------------------------------------------------------------
// Drawing

function drawFolderRectangle(rectangle, darkestScoreOnLevel, changedFolders, selectedFolderKey, whenUserDoes) {
  const folder = rectangle.data;
  const group = svgEl("g", rectangle.children ? { filter: "url(#cascade-shadow)" } : {});
  const isWholeCodebase = rectangle.depth === 0;
  const darkest = darkestScoreOnLevel.get(rectangle.depth)?.score ?? 0;

  let fill = BACKGROUND_OF_WHOLE_CODEBASE;
  if (!isWholeCodebase) fill = rectangle.offence.existsAtThisStep ? colourForScore(rectangle.offence.score, darkest) : "url(#not-here-yet)";

  const shape = svgEl("rect", {
    class: rectangle.children ? "frame" : "cell",
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
  if (keyOfFolder(folder) === selectedFolderKey) outlines.push("selected");
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

function drawFolderLabel(rectangle, darkestScoreOnLevel) {
  const width = rectangle.x1 - rectangle.x0;
  const height = rectangle.y1 - rectangle.y0;
  if (width < 28 || height < 12) return null;

  const isDarkFill = rectangle.depth === 0 || shareOfWorstOnLevel(rectangle, darkestScoreOnLevel) > 0.55;
  const group = svgEl("g", { class: isDarkFill ? "label on-dark" : "label" });
  const clipId = `offender-map-clip-${rectangle.x0}-${rectangle.y0}-${rectangle.depth}`;
  const clip = svgEl("clipPath", { id: clipId });
  clip.append(svgEl("rect", { x: rectangle.x0, y: rectangle.y0, width, height }));
  group.append(clip);

  const text = svgEl("text", { "clip-path": `url(#${clipId})` });
  const name = svgEl("tspan", { x: rectangle.x0 + 4, y: rectangle.y0 + 12 });
  name.textContent = rectangle.data.folderPath === "." ? "root" : rectangle.data.name;
  text.append(name);
  if (!rectangle.children && height >= 28 && rectangle.offence.score > 0) {
    const score = svgEl("tspan", { x: rectangle.x0 + 4, y: rectangle.y0 + 24, class: "count" });
    score.textContent = `offence ${rectangle.offence.score.toFixed(2)}`;
    text.append(score);
  }
  group.append(text);
  return group;
}

/** A curved arrow between the middles of two folders, so arrows both ways do not overlap. */
function drawArrow({ source, target, cause, link }) {
  const start = middleOf(source);
  const end = middleOf(target);
  const bend = 0.2;
  const control = {
    x: (start.x + end.x) / 2 - (end.y - start.y) * bend,
    y: (start.y + end.y) / 2 + (end.x - start.x) * bend,
  };
  const path = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  const group = svgEl("g", { class: `became-uphill ${cause === "new import" ? "by-new-import" : "by-drift"}` });
  group.append(svgEl("path", { class: "halo", d: path }));
  const line = svgEl("path", { class: "line", d: path, "marker-end": "url(#arrow-head)" });
  hover(line, () => [
    `${link.fromFolder} → ${link.toFolder}`,
    `became uphill in this pull request (${cause === "new import" ? "a new import" : "drift: the import was already there"})`,
    `steepness ${link.steepness.toFixed(2)}, ${plural(link.importCount, "file import")}, ${link.importsAddedByPullRequest} added by the pull request`,
  ].join("\n"));
  group.append(line);
  return group;
}

function drawingDefinitions() {
  const definitions = svgEl("defs");

  const shadow = svgEl("filter", { id: "cascade-shadow", x: "-20%", y: "-20%", width: "140%", height: "140%" });
  shadow.append(svgEl("feDropShadow", { "flood-color": "#000", "flood-opacity": "0.45", dx: "0", dy: "1", stdDeviation: "1.4" }));

  const notHereYet = svgEl("pattern", { id: "not-here-yet", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  notHereYet.append(svgEl("rect", { width: 6, height: 6, fill: "#3a3a3a" }), svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#5a5a5a", "stroke-width": 2 }));

  const arrowHead = svgEl("marker", { id: "arrow-head", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  arrowHead.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow-head" }));

  definitions.append(shadow, notHereYet, arrowHead);
  return definitions;
}

// ---------------------------------------------------------------------------
// Controls, legend and text

function drawControls(offenderMap, stepIndex, minimumSteepness, whenUserDoes) {
  const controls = el("div", "view-head offender-map-controls");

  const steepnessControl = el("label", "control");
  steepnessControl.append(el("span", "lbl", "count a link as uphill when it climbs at least"));
  const steepnessSlider = el("input");
  Object.assign(steepnessSlider, { type: "range", min: "0.05", max: "1", step: "0.05", value: String(minimumSteepness) });
  steepnessSlider.setAttribute("aria-label", "Smallest steepness that counts as uphill");
  const steepnessReadout = el("span", "readout", minimumSteepness.toFixed(2));
  steepnessSlider.addEventListener("input", () => {
    steepnessReadout.textContent = Number(steepnessSlider.value).toFixed(2);
  });
  steepnessSlider.addEventListener("change", () => whenUserDoes.changeMinimumSteepness(Number(steepnessSlider.value)));
  steepnessControl.append(steepnessSlider, steepnessReadout);
  controls.append(steepnessControl);

  const lastStep = offenderMap.steps.length - 1;
  const stepControl = el("div", "control step-control");
  const earlier = el("button", "", "◀ earlier");
  earlier.type = "button";
  earlier.disabled = stepIndex === 0;
  earlier.addEventListener("click", () => whenUserDoes.changeStep(stepIndex - 1));
  const later = el("button", "", "later ▶");
  later.type = "button";
  later.disabled = stepIndex === lastStep;
  later.addEventListener("click", () => whenUserDoes.changeStep(stepIndex + 1));
  const stepSlider = el("input");
  Object.assign(stepSlider, { type: "range", min: "0", max: String(lastStep), step: "1", value: String(stepIndex) });
  stepSlider.disabled = lastStep === 0;
  stepSlider.setAttribute("aria-label", "Step through the pull request");
  stepSlider.addEventListener("change", () => whenUserDoes.changeStep(Number(stepSlider.value)));
  stepControl.append(el("span", "lbl", "pull request"), earlier, stepSlider, later);
  controls.append(stepControl);

  controls.append(el("p", "step-caption", describeStep(offenderMap, stepIndex)));
  return controls;
}

function describeStep(offenderMap, stepIndex) {
  const step = offenderMap.steps[stepIndex];
  const commitsShown = offenderMap.steps.length - 1;
  if (step.commit === null) {
    return commitsShown === 0
      ? "This branch has no commits beyond the base, so this is the codebase as it is."
      : `Before the pull request (step 0 of ${commitsShown}).`;
  }
  const who = step.commit.cls === "agent" ? `agent-assisted (${step.commit.tools.join(", ")})` : step.commit.cls;
  const skipped = offenderMap.someCommitsSkipped ? " Some commits are skipped to keep the stepper short." : "";
  return `After commit ${stepIndex} of ${commitsShown}: ${step.commit.date} "${step.commit.subject}", ${who}.${skipped}`;
}

function describeWhatIsShown(everyRectangle, linksThatBecameUphill, step, stepIndex) {
  const offendingFolders = everyRectangle.filter((rectangle) => !rectangle.children && rectangle.offence.score > 0).length;
  const byNewImport = linksThatBecameUphill.filter((found) => found.cause === "new import").length;
  const byDrift = linksThatBecameUphill.length - byNewImport;
  let text = `${plural(offendingFolders, "folder")} without subfolders offend at this step. `;
  if (stepIndex > 0) {
    text += `${plural(linksThatBecameUphill.length, "link")} became uphill during the pull request so far ` +
      `(${byNewImport} by a new import, ${byDrift} by drift). ` +
      `${plural(step.foldersChangedSinceStart.length, "folder")} changed so far, ${step.foldersChangedInThisStep.length} in this commit.`;
  }
  return el("p", "view-summary", text);
}

function drawLegend(darkestScoreOnLevel, everyRectangle) {
  const legend = el("div", "legend offender-legend");
  const scale = el("span", "legend-item");
  scale.append(el("span", "", "no uphill links"), el("i", "offence-scale-bar"), el("span", "", "worst folder on its nesting level"));
  legend.append(scale);

  const outlineKey = el("span", "legend-item");
  outlineKey.append(el("i", "sw outline-key changed-in-this-step"), document.createTextNode("changed in this commit"),
    el("i", "sw outline-key changed-earlier-in-pull-request"), document.createTextNode("changed earlier in the pull request"));
  legend.append(outlineKey);

  const arrowKey = el("span", "legend-item");
  arrowKey.append(el("i", "sw arrow-key by-new-import"), document.createTextNode("became uphill by a new import"),
    el("i", "sw arrow-key by-drift"), document.createTextNode("became uphill by drift"));
  legend.append(arrowKey);

  const levels = [...darkestScoreOnLevel.entries()].sort((a, b) => a[0] - b[0]);
  const darkestList = el("p", "darkest-per-level");
  darkestList.textContent = "Darkest red per nesting level: " + levels
    .map(([nestingLevel, darkest]) => darkest.score > 0
      ? `level ${nestingLevel} = ${darkest.score.toFixed(2)} (${nameForPeople(darkest.folder)})`
      : `level ${nestingLevel} = none`)
    .join(" · ");
  legend.append(darkestList);
  return legend;
}

function describeSelectedFolder(rectangle, minimumSteepness) {
  const box = el("div", "selected-folder");
  const offence = rectangle.offence;
  const folder = rectangle.data;
  box.append(el("h3", "", nameForPeople(folder)));
  if (folder.measuredAtDepth === null) {
    box.append(el("p", "", "The whole codebase. Pick a folder to see its links."));
    return box;
  }
  if (!offence.existsAtThisStep) {
    box.append(el("p", "", "This folder has no files at this step."));
    return box;
  }
  const measured = offence.measured;
  box.append(el("p", "",
    `Measured with folders merged to ${plural(folder.measuredAtDepth, "path segment")}. ` +
    `Instability ${measured.instability.toFixed(2)}: imported by ${plural(measured.importedByFiles, "file")} outside, ` +
    `and ${plural(measured.importsFilesOutside, "file")} inside import something outside. ` +
    `Offence ${offence.score.toFixed(2)}.`));
  if (offence.allUphillLinks.length === 0) {
    box.append(el("p", "", "It imports nothing less stable than itself."));
    return box;
  }
  const list = el("ul", "uphill-links");
  for (const link of offence.allUphillLinks) {
    const counted = link.steepness >= minimumSteepness - 1e-9;
    const history = link.steepnessBeforePullRequest === null
      ? "the folders were not linked before the pull request"
      : `steepness before the pull request ${link.steepnessBeforePullRequest.toFixed(2)}`;
    const item = el("li", counted ? "counted" : "below-slider",
      `→ ${link.toFolder}: steepness ${link.steepness.toFixed(2)}, ${plural(link.importCount, "file import")}` +
      (link.importsAddedByPullRequest > 0 ? ` (${link.importsAddedByPullRequest} added by the pull request)` : "") +
      `, ${history}${counted ? "" : ", below the slider so not counted"}`);
    list.append(item);
  }
  box.append(list);
  return box;
}

function describeFolderForTooltip(rectangle) {
  const folder = rectangle.data;
  if (folder.measuredAtDepth === null) return "The whole codebase";
  const offence = rectangle.offence;
  if (!offence.existsAtThisStep) return `${nameForPeople(folder)}\nno files at this step`;
  return [
    nameForPeople(folder),
    `offence ${offence.score.toFixed(2)} from ${plural(offence.countedLinks.length, "uphill link")}`,
    `instability ${offence.measured.instability.toFixed(2)}, ${plural(offence.measured.filesInside, "file")}`,
    "click for its links",
  ].join("\n");
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
  return folder.isOwnFilesCell ? `${path} (its own files)` : path;
}

function depthOfPath(folderPath) {
  return folderPath === "." ? 1 : folderPath.split("/").length;
}

function middleOf(rectangle) {
  return { x: (rectangle.x0 + rectangle.x1) / 2, y: (rectangle.y0 + rectangle.y1) / 2 };
}

function rgb([red, green, blue]) {
  return `rgb(${red}, ${green}, ${blue})`;
}
