import { baseName, commitLine, decisionLabel, el, fileLink, plural, shortName } from "./ui.js";

/**
 * The side panel: everything the author needs to judge the selected link
 * (T2 to T4 in the doc), next to whichever view is open.
 *
 * @param on { decide(link, decision, note), undo(link), copy(link), open(path), history(from, to) }
 */
export function renderPanel(container, review, selection, on) {
  container.replaceChildren();
  if (selection === null) {
    container.append(el("p", "empty", "Select a link in the list, the matrix or the history to see it here."));
    return;
  }
  if (selection.type === "link") linkDetails(container, review, selection.link, on);
  else pairDetails(container, review, selection, on);
}

function linkDetails(container, review, link, on) {
  container.append(el("h2", "", `${link.from} → ${link.to}`));
  container.append(el("p", "summary",
    `Uphill by ${link.gap.toFixed(2)}: ${link.from} (I ${link.fromInstability.toFixed(2)}) now imports ` +
    `${link.to} (I ${link.toInstability.toFixed(2)}). ` +
    `${plural(link.reliedOnBy.files, "file")} in ${plural(link.reliedOnBy.folders, "other folder")} import ${link.from}.`));
  const facts = [
    link.kind === "into-subfolder" ? "into its own subfolder" : "sideways",
    link.isNewLink ? "new link" : "existing link, more imports",
  ];
  if (link.loop) facts.push(`${link.to} also imports ${link.from}`);
  container.append(el("p", "facts", facts.join(" · ")));
  if (link.grew && link.decision) {
    container.append(el("p", "note",
      `Marked meant on ${link.decision.date} with ${plural(link.decision.imports, "import")}; it has ${plural(link.imports.length, "import")} now, so it is asked again.`));
  }

  const added = link.imports.filter((i) => i.isNew);
  const before = link.imports.filter((i) => !i.isNew);
  container.append(el("h3", "", "Imports in this change"));
  for (const i of added) container.append(importLine(review, i, on));
  if (before.length > 0) {
    container.append(el("h3", "", "Already there before"));
    for (const i of before) container.append(importLine(review, i, on));
  }

  container.append(el("h3", "", "Who imports the imported file"));
  for (const lens of link.lens) container.append(lensRow(review, link, lens, on));

  container.append(el("h3", "", "Suggestion"));
  const clue = el("p", "clue");
  clue.append(el("strong", "", link.clue.headline + " "), document.createTextNode(link.clue.reason));
  container.append(clue);

  container.append(el("h3", "", "Your decision"));
  container.append(decisionBlock(review, link, on));

  container.append(el("h3", "", "History"));
  container.append(historyLine(review, link.from, link.to));
  const show = el("button", "button", "Show in the stability race");
  show.type = "button";
  show.addEventListener("click", () => on.history(link.from, link.to));
  container.append(show);

  container.append(el("h3", "", "Piece for a model"));
  container.append(el("p", "muted",
    `${plural(link.piece.files.length, "file")} and a map of ${plural(link.piece.mapFolders, "folder")}, ` +
    `about ${link.piece.tokens.toLocaleString("en-US")} tokens. Paste it into LM Studio or any chat to see if a model can make the fix from this piece alone.`));
  const copy = el("button", "button", "Copy piece");
  copy.type = "button";
  copy.addEventListener("click", () => on.copy(link));
  container.append(copy);
}

function pairDetails(container, review, pair, on) {
  const level = review.matrix.levels.find((l) => l.depth === pair.depth) ?? review.matrix.levels[review.matrix.levels.length - 1];
  const index = new Map(level.folders.map((f, i) => [f.name, i]));
  const r = index.get(pair.from);
  const c = index.get(pair.to);
  const cell = level.cells.find((x) => x[0] === r && x[1] === c);
  container.append(el("h2", "", `${pair.from} → ${pair.to}`));
  if (pair.depth !== null) container.append(el("p", "facts", `folders merged to depth ${pair.depth}`));
  if (r === undefined || c === undefined) {
    container.append(el("p", "muted", "These folders are not in the codebase at the head."));
    return;
  }
  const a = level.folders[r];
  const b = level.folders[c];
  const gap = b.instability - a.instability;
  const count = cell ? cell[2] : 0;
  container.append(el("p", "summary",
    count === 0
      ? `${pair.from} does not import ${pair.to} at the head.`
      : `${pair.from} (I ${a.instability.toFixed(2)}) imports ${pair.to} (I ${b.instability.toFixed(2)}) ` +
        `with ${plural(count, "file import")}: ${gap > 1e-9 ? `uphill by ${gap.toFixed(2)}` : "it points down or level"}. ` +
        `${plural(a.afferent, "file")} outside import ${pair.from}.`));
  if (cell) {
    const flags = cell[3];
    const notes = [];
    if (flags & 2) notes.push("flagged in this change (pick it in the list)");
    else if (flags & 1) notes.push(gap > 1e-9 ? `this change added an import here, but the gap is below ${review.minGap}` : "this change added an import here, pointing down");
    else notes.push("not touched by this change");
    if (flags & 4) notes.push("marked meant");
    container.append(el("p", "facts", notes.join(" · ")));
  }
  if (pair.depth === null) {
    container.append(el("h3", "", "History"));
    container.append(historyLine(review, pair.from, pair.to));
    const show = el("button", "button", "Show in the stability race");
    show.type = "button";
    show.addEventListener("click", () => on.history(pair.from, pair.to));
    container.append(show);
  } else {
    container.append(el("p", "muted", "History is kept per folder: pick “every folder” in the matrix to see this link over time."));
  }
}

function historyLine(review, from, to) {
  const h = review.history;
  const births = h.births.filter((b) => b.from === from && b.to === to);
  const counts = h.links[`${from} -> ${to}`];
  const p = el("p", "muted");
  if (births.length === 0) {
    p.textContent = counts && counts[0] > 0
      ? `No birth in the last ${plural(h.months.length, "month")}: the link was already there when the window starts (${h.months[0]}).`
      : `No uphill birth in the last ${plural(h.months.length, "month")}.`;
    return p;
  }
  const b = births[births.length - 1];
  const how = b.cause === "new import" ? "a new import" : b.cause === "moved" ? "files moving" : "drift (the import was there; the numbers moved)";
  p.textContent = `Turned uphill in ${b.month} by ${how}: ${commitLine(b.commit)}.` +
    (births.length > 1 ? ` It turned uphill ${births.length} times in the window.` : "") +
    (counts && counts.length > 1 ? ` File imports on the link: ${counts[0]} at the start of the window, ${counts[counts.length - 1]} now.` : "");
  return p;
}

function importLine(review, i, on) {
  const row = el("div", "import");
  const top = el("div", "import-top");
  top.append(fileLink(review.root, i.from, i.line, on.open), el("span", `tag kind-${i.kind}`, i.kind));
  row.append(top);
  row.append(el("code", "code", i.text ?? `imports ${i.to}`));
  if (i.isNew) {
    const who = el("div", `commit ${i.commit ? i.commit.cls : ""}`);
    who.textContent = i.commit ? `added in ${commitLine(i.commit)}` : "added outside the replayed history";
    row.append(who);
  }
  return row;
}

function lensRow(review, link, lens, on) {
  const row = el("div", "lens");
  row.append(fileLink(review.root, lens.file, null, on.open));
  const other = lens.elsewhere.reduce((a, e) => a + e.files, 0);
  const total = Math.max(1, lens.home + lens.importingSide + other);
  const bar = el("div", "lens-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${lens.home} in ${link.to}, ${lens.importingSide} in ${link.from}, ${other} elsewhere`);
  for (const [cls, n] of [["home", lens.home], ["side", lens.importingSide], ["other", other]]) {
    if (n === 0) continue;
    const seg = el("span", `lens-seg ${cls}`);
    seg.style.width = `${(100 * n) / total}%`;
    bar.append(seg);
  }
  row.append(bar);
  const key = el("div", "lens-key");
  for (const [cls, text] of [
    ["home", `${lens.home} in ${shortName(link.to)}`],
    ["side", `${lens.importingSide} in ${shortName(link.from)}`],
    ["other", `${other} elsewhere`],
  ]) {
    const item = el("span", "");
    item.append(el("i", `lens-sw ${cls}`), document.createTextNode(text));
    key.append(item);
  }
  row.append(key);
  if (lens.reexports > 0) {
    row.append(el("div", "muted small", `an entry file: it re-exports ${plural(lens.reexports, "file")}, so these counts are for the package as a whole`));
  }
  if (lens.elsewhere.length > 0) {
    const names = lens.elsewhere.slice(0, 3).map((e) => `${e.folder} (${e.files})`).join(", ");
    const more = lens.elsewhere.length > 3 ? ` and ${lens.elsewhere.length - 3} more` : "";
    row.append(el("div", "muted small", `elsewhere: ${names}${more}`));
  }
  return row;
}

function decisionBlock(review, link, on) {
  const block = el("div", "decision");
  const suggested = link.clue.kind === "subfolder" ? "meant" : link.clue.kind === "flip" ? "flip" : "move";

  if (link.decision !== null && !link.grew) {
    const d = link.decision;
    block.append(el("p", "decision-state",
      `Recorded in ${baseName(review.decisionsFile)}: ${decisionLabel(d.decision)}${d.note ? ` ("${d.note}")` : ""}, by ${d.by} on ${d.date}.`));
    const undo = el("button", "button", "Undo");
    undo.type = "button";
    undo.addEventListener("click", () => on.undo(link));
    block.append(undo);
    return block;
  }

  const note = el("input", "decision-note");
  note.type = "text";
  note.placeholder = "Note (optional)";
  note.setAttribute("aria-label", "Note for the decision");
  const buttons = el("div", "decision-buttons");
  for (const [decision, label, help] of [
    ["meant", "Meant", "Keep the link: it is intended. Later reviews stay quiet until it grows."],
    ["move", "Fix: move", "Move the imported code down to where it belongs."],
    ["flip", "Fix: flip", "Invert the dependency: the stable side owns an interface, a type or an event."],
  ]) {
    const button = el("button", "button", label);
    button.type = "button";
    button.title = help;
    if (decision === suggested) button.classList.add("suggested");
    button.addEventListener("click", () => on.decide(link, decision, note.value));
    buttons.append(button);
  }
  block.append(buttons, note);
  block.append(el("p", "muted small",
    `The highlighted button matches the suggestion. The decision goes into ${baseName(review.decisionsFile)} in the repository: that file is the intended architecture, written one decision at a time.`));
  return block;
}
