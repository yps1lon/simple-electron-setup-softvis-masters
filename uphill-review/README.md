# Uphill imports (prototype)

A pull request can make a folder that much of the code relies on start importing a folder that changes more easily. That import is uphill: it breaks Martin's stable-dependencies principle, and the diff shows it as one line. This tool shows it to the author of the change, asks whether it is meant, and writes the answer down. There is no spec to write up front: the YAML of decisions is the output.

This folder is a copy of the app, rebuilt around that idea. It uses the packages installed in the app folder above it, so there is nothing to install.

## Try it

1. `npm run demo` makes `demo-shop` in this folder (git ignores it): a small TypeScript shop with ten months of history on `main`, and the branch `ai/discount-banner` checked out as the pull request. Run it again any time to start over.
2. `npm start`
3. Click **Pick repo…**, choose `demo-shop`, leave base as `main`, then click **Review change**.

The list shows the three uphill imports the branch adds, riskiest first:

| Link | Gap | Suggestion | Why |
|---|---|---|---|
| src/core → src/features/notifications | +0.44 | Flip it? | 2 of the 3 files importing `email.ts` are in notifications |
| src/core → src/features/checkout | +0.35 | Move it? | only `core/money.ts` imports `rounding.ts` |
| src/ui → src/ui/badge | +0.30 | Likely meant | an index file re-exporting its own subfolder |

Things to try:

- **Ladder**: hover the red arrow to see the import line, the commit and whether it was agent-assisted. Hover a dot for its numbers.
- **Matrix**: every folder link in the codebase, sorted by instability, so every uphill link sits above the diagonal. Switch depth to see merging hide links. Click a cell to select that link in every view.
- **History**: the stability race for `src/core`. The Apr 2026 link to `src/data` was born by a new import (light dot); the Jun 2026 link to `src/config` by drift (ring): the import was already there and config became less stable. The two violet dots in Sep 2026 are this pull request's links from `src/core`.
- **Decide**: click Meant, Fix: move or Fix: flip. The decision goes into `demo-shop/architecture.yaml` with your git name, the date and the number of imports. A link marked meant stays quiet in later reviews until it grows.
- **Copy piece** puts both files, the import lines and a map of the nearby folders on the clipboard (about 600 tokens here). Paste it into LM Studio to see if a model can make the fix from that piece alone.
- Do the move fix, then review again, and the link is gone:
  ```
  cd demo-shop
  git mv src/features/checkout/rounding.ts src/core/rounding.ts
  # in src/core/money.ts, change "../features/checkout/rounding" to "./rounding"
  git commit -am "Move rounding into core"
  ```

## A real case: Outline PR #11186

```
git clone https://github.com/outline/outline
cd outline
git checkout -b pr-11186 1cc4d879d
```

Pick `outline`, set base to `1cc4d879d~1`, then click **Review change**. It flags one link: `server/models → server/collaboration`, uphill by 0.71, "Move it down?", with 283 files in 78 folders importing `server/models`. Replaying a year of Outline (about 1,400 commits) took 12 seconds in our test; the window waits meanwhile.

## How it decides

- A folder is a file's own directory. Tests, stories, fixtures and generated code are left out.
- Instability is I = Ce / (Ca + Ce), counted in files. Ca is the number of files outside the folder that import it; Ce is the number of files in the folder that import something outside it.
- A link is flagged when, at the branch's last commit, it points uphill by 0.2 or more and at least one of its imports is new since the branch left the base (`git merge-base`, as in a pull request). A folder importing its own subfolder is shown as "Likely meant".
- The suggestion counts who imports the imported file: nobody in its own folder means move it; mostly its own folder means flip the dependency; a mix means split it.
- The engine is the replay from our ten-codebase study, ported to TypeScript: the TypeScript parser reads each file's imports (with four kinds: type-only, deferred, load-time, re-export), and imports are resolved through tsconfig `paths` and `baseUrl` and workspace package names. It parses the commit before the history window once, then walks the first-parent history commit by commit, re-parsing only changed files and their importers. That gives the matrix, the history, and which commit added each import.
- Agent-assisted means a coding agent is named as co-author or author (for example `Co-authored-by: Claude`).
- Git is only read. Nothing in the reviewed repository changes, except `architecture.yaml` when you record a decision.

## Files

- `src/engine`: the engine (TypeScript, a library): `imports.ts`, `resolve.ts`, `git.ts`, `replay.ts` (the replay), `stability.ts`, `review-core.ts` (the review and the piece), `matrix.ts`, `decisions.ts`, `review.ts` (puts it together), `types.ts` (the contract with the UI)
- `src/renderer`: the views, in plain DOM and SVG: `ladder.js`, `matrix.js`, `race.js`, `list.js`, `panel.js`, `renderer.js` (the shell and the linked selection)
- `src/main`: Electron main process and the preload bridge (`window.uphill`)
- `demo/make-demo-repo.mjs`: the demo repository
- `test/review.test.mjs`: engine tests, `npm test`

## Known limits

- TypeScript only; JavaScript-only repositories are not parsed.
- The review runs in the main process, so the window waits while a big repository replays.
- History is kept per folder, not for merged folders.
- The suggestion only counts importers. It cannot see what the code means; the author decides.
- The pull-request comment with a picture of the ladder (the doc's notification idea) is not built.
- The views use plain SVG, not d3.
