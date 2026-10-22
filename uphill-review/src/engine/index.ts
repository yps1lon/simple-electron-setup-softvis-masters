/**
 * The engine, consumed as a library by the Electron main process (there is
 * no CLI). Main imports the compiled version of this file
 * (src/engine/dist/index.js).
 */
export { readDecisions } from "./decisions.js";
export { buildMatrix } from "./matrix.js";
export { replay, snapshotAt } from "./replay.js";
export { findUphillLinks } from "./review-core.js";
export { recordDecision, removeDecision, reviewChange } from "./review.js";
export type { DecisionInput, ReviewOptions } from "./review.js";
export type * from "./types.js";
