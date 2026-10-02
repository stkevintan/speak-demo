/**
 * The runtime half of the contract. Every module imports its types and its
 * validators from here, so `web`, `control-plane` and `agent-worker` cannot
 * drift apart — `ARCHITECTURE.md` §3 makes this the only cross-module
 * dependency.
 */
export * from "./palette.js";
export * from "./course.js";
export * from "./session.js";
export * from "./progress.js";
export * from "./events.js";
export * from "./http.js";
export * from "./worker.js";
