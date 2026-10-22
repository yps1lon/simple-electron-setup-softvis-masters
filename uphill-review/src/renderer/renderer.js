import { drawLadder } from "./ladder.js";
import { renderList } from "./list.js";
import { defaultLevel, drawMatrix } from "./matrix.js";
import { renderPanel } from "./panel.js";
import { drawRace } from "./race.js";
import { guard, setStatus } from "./status.js";
import { baseName, decisionLabel, el, hideTip, plural } from "./ui.js";

// The app shell: one review at a time, three linked views and a side panel.
// Selecting a link anywhere (the list, a matrix cell, a line in the race)
// selects it everywhere. Main keeps no state; the renderer holds the review
// it was handed and updates it in place when a decision is recorded.

const state = {
  repoPath: null,
  review: null,
  tab: "ladder",
  // { type: "link", id } for a link this change added, or
  // { type: "pair", from, to, depth } for any folder link in the codebase.
  selection: null,
  matrixLevel: 0,
  race: { folder: null, dep: null, tol: 0.2 },
};

const byId = (id) => document.getElementById(id);

window.addEventListener("DOMContentLoaded", () => {
  byId("pick-repo").addEventListener("click", onPickRepo);
  byId("review").addEventListener("click", onReview);
  for (const tab of ["ladder", "matrix", "race"]) byId(`tab-${tab}`).addEventListener("click", () => showTab(tab));
  let timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(drawView, 150);
  });
});

async function onPickRepo() {
  const picked = await window.uphill.pickFolder();
  if (picked !== null) {
    state.repoPath = picked;
    setStatus(`repo: ${picked}. Check out the pull request's branch there, then click Review change.`);
  }
}

async function onReview() {
  if (state.repoPath === null) {
    setStatus("pick a repository first");
    return;
  }
  const baseRef = byId("base-ref").value.trim() || "main";
  const months = Number(byId("months").value);
  await guard(async () => {
    setStatus(`reviewing the checked-out branch against ${baseRef}, replaying ${months} months of history…`);
    const review = await window.uphill.review(state.repoPath, baseRef, months);
    state.review = review;
    const first = review.links[0] ?? null;
    state.selection = first ? { type: "link", id: first.id } : null;
    state.matrixLevel = defaultLevel(review.matrix);
    state.race = { folder: first ? first.from : mostImported(review), dep: first ? first.to : null, tol: 0.2 };
    byId("app").hidden = false;
    render();
    setStatus(
      `reviewed ${review.base.ref}..${review.head.ref}: ${plural(review.stats.flagged, "uphill link")}` +
      (review.stats.flagged > 0 ? ", largest risk first" : ""),
    );
  });
}

function render() {
  renderStats();
  renderList(byId("list"), state.review, state.selection?.type === "link" ? state.selection.id : null, selectLink);
  drawView();
  renderPanel(byId("panel"), state.review, panelSelection(), panelHandlers);
}

function showTab(tab) {
  state.tab = tab;
  for (const t of ["ladder", "matrix", "race"]) {
    byId(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
    byId(`view-${t}`).hidden = t !== tab;
  }
  drawView();
}

function drawView() {
  if (state.review === null) return;
  hideTip();
  const review = state.review;
  if (state.tab === "ladder") {
    const link = selectedLink();
    if (link === null && state.selection !== null) {
      const box = byId("view-ladder");
      box.replaceChildren(el("p", "empty",
        "The ladder shows the uphill links this change added. The selected link was not added by it; see the panel, the matrix and the history."));
    } else drawLadder(byId("view-ladder"), link);
  } else if (state.tab === "matrix") {
    drawMatrix(byId("view-matrix"), review, { levelIndex: state.matrixLevel, selected: selectedPair(), meant: meantLinks() }, {
      level: (i) => {
        state.matrixLevel = i;
        drawView();
      },
      pick: selectPair,
      folder: (name, depth) => {
        if (depth !== null) return;
        state.race = { ...state.race, folder: name, dep: null };
        showTab("race");
      },
    });
  } else {
    drawRace(byId("view-race"), review, state.race, {
      folder: (name) => {
        state.race = { ...state.race, folder: name, dep: null };
        drawView();
      },
      pick: selectPair,
      tol: (value) => {
        state.race = { ...state.race, tol: value };
        drawView();
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Selection, shared by all views

function selectLink(id) {
  const link = state.review.links.find((l) => l.id === id);
  if (link === undefined) return;
  state.selection = { type: "link", id };
  state.race = { ...state.race, folder: link.from, dep: link.to };
  render();
}

function selectPair({ from, to, depth }) {
  if (depth === null && state.review.links.some((l) => l.from === from && l.to === to)) {
    selectLink(`${from} -> ${to}`);
    return;
  }
  state.selection = { type: "pair", from, to, depth };
  if (depth === null) state.race = { ...state.race, folder: from, dep: to };
  render();
}

function selectedLink() {
  if (state.selection?.type !== "link") return null;
  return state.review.links.find((l) => l.id === state.selection.id) ?? null;
}

function selectedPair() {
  const link = selectedLink();
  if (link !== null) return { from: link.from, to: link.to };
  if (state.selection?.type === "pair") return { from: state.selection.from, to: state.selection.to };
  return null;
}

function panelSelection() {
  const link = selectedLink();
  if (link !== null) return { type: "link", link };
  return state.selection;
}

function meantLinks() {
  return new Set(state.review.links.filter((l) => l.decision?.decision === "meant" && !l.grew).map((l) => l.id));
}

function mostImported(review) {
  const full = review.matrix.levels[review.matrix.levels.length - 1];
  const top = [...full.folders].sort((a, b) => b.afferent - a.afferent)[0];
  return top ? top.name : null;
}

// ---------------------------------------------------------------------------
// Decisions, the piece, files

const panelHandlers = {
  decide: (link, decision, note) =>
    guard(async () => {
      const r = state.review;
      const records = await window.uphill.decide(r.root, r.decisionsFile, {
        from: link.from,
        to: link.to,
        decision,
        note,
        change: `${r.base.ref}..${r.head.ref}`,
        imports: link.imports.length,
      });
      applyDecisions(records);
      setStatus(`recorded "${decisionLabel(decision)}" for ${link.id} in ${r.decisionsFile}`);
    }),
  undo: (link) =>
    guard(async () => {
      const records = await window.uphill.undecide(state.review.decisionsFile, link.from, link.to);
      applyDecisions(records);
      setStatus(`removed the decision for ${link.id}`);
    }),
  copy: (link) =>
    guard(async () => {
      await window.uphill.copyText(link.piece.text);
      setStatus(`piece for ${link.id} copied (${link.piece.tokens.toLocaleString("en-US")} tokens): paste it into a model`);
    }),
  open: (path) => guard(() => window.uphill.openFile(path)),
  history: (from, to) => {
    state.race = { ...state.race, folder: from, dep: to };
    showTab("race");
  },
};

function applyDecisions(records) {
  const byPair = new Map(records.map((d) => [`${d.from} -> ${d.to}`, d]));
  for (const link of state.review.links) {
    link.decision = byPair.get(link.id) ?? null;
    link.grew = link.decision !== null && link.decision.decision === "meant" && link.imports.length > link.decision.imports;
  }
  state.review.stats.decided = state.review.links.filter((l) => l.decision !== null && !l.grew).length;
  render();
}

// ---------------------------------------------------------------------------

function renderStats() {
  const r = state.review;
  const s = r.stats;
  const open = r.links.filter((l) => l.decision === null || l.grew).length;
  const bar = byId("stats");
  bar.replaceChildren();
  const chip = (text, cls, title) => {
    const span = el("span", cls ?? "", text);
    if (title) span.title = title;
    bar.append(span);
  };
  chip(`change: ${r.base.ref}..${r.head.ref}, ${plural(s.commits, "commit")}${s.agentCommits ? ` (${s.agentCommits} agent-assisted)` : ""}`);
  chip(`files: ${s.files}`);
  chip(`new imports: ${s.newImports}`);
  chip(`uphill links: ${s.flagged} (${s.sideways} sideways, ${s.intoSubfolder} into a subfolder)`);
  chip(`to decide: ${open}`, open > 0 ? "alert" : "");
  chip(`history: ${plural(r.history.months.length, "month")}, ${plural(r.history.commits, "commit")}`);
  chip(`decisions: ${baseName(r.decisionsFile)}`, "", r.decisionsFile);
}
