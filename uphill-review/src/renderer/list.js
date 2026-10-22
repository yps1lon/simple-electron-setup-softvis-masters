import { decisionLabel, el, plural, shortName } from "./ui.js";

/**
 * The uphill links the change adds, sorted by gap times exposure (the links
 * that put the most code at risk of the most change come first), with the
 * ones still to decide on top.
 */
export function renderList(container, review, selectedId, pick) {
  container.replaceChildren();
  if (review.stats.commits === 0) {
    container.append(el("p", "empty",
      `Nothing to review: ${review.head.ref} has no commits beyond ${review.base.ref}. ` +
      "Check out the pull request's branch in the repository, or pick another base. The matrix and the history still show the codebase."));
    return;
  }
  if (review.links.length === 0) {
    container.append(el("p", "empty",
      `No new uphill imports. The change adds ${plural(review.stats.newImports, "import")} between files, ` +
      `and none makes a folder depend on a less stable one by ${review.minGap} or more.`));
  }
  const open = review.links.filter((l) => l.decision === null || l.grew);
  const decided = review.links.filter((l) => l.decision !== null && !l.grew);
  for (const [title, links] of [["To decide", open], ["Decided", decided]]) {
    if (links.length === 0) continue;
    container.append(el("div", "group", `${title} · ${links.length}`));
    for (const link of links) container.append(card(link, link.id === selectedId, pick));
  }
  if (review.stats.quiet > 0) {
    container.append(el("p", "muted small",
      `${plural(review.stats.quiet, "link")} marked meant earlier got new imports without growing past what was accepted, so ${review.stats.quiet === 1 ? "it stays" : "they stay"} quiet.`));
  }
}

function card(link, selected, pick) {
  const button = el("button", "card");
  button.type = "button";
  button.title = link.id;
  if (selected) button.classList.add("selected");
  if (link.decision !== null && !link.grew) button.classList.add("decided");

  const top = el("div", "card-top");
  top.append(el("span", "card-link", `${shortName(link.from)} → ${shortName(link.to)}`), el("span", "card-gap", `+${link.gap.toFixed(2)}`));
  const sub = el("div", "card-sub");
  sub.append(el("span", `clue clue-${link.clue.kind}`, link.clue.headline));
  sub.append(document.createTextNode(link.grew ? " · grew since marked meant" : link.isNewLink ? " · new link" : " · more imports"));
  const commits = link.imports.filter((i) => i.isNew && i.commit).map((i) => i.commit);
  if (commits.some((c) => c.cls === "agent")) sub.append(el("span", "who agent", "agent-assisted"));
  else if (commits.length > 0) sub.append(el("span", "who human", commits[0].cls));
  if (link.decision !== null && !link.grew) sub.append(el("span", "chip", decisionLabel(link.decision.decision)));
  button.append(top, sub);
  button.addEventListener("click", () => pick(link.id));
  return button;
}
