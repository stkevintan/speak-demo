import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this file to the workspace root.
 *
 * `process.cwd()` is deliberately avoided: these scripts are run from the repo
 * root during development and from inside a container in packaging, and a
 * cwd-relative path would work in the first case and silently point at the wrong
 * place in the second (`CODE_INSTRUCTION.md`).
 */
export function workspaceRoot(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate the workspace root (no pnpm-workspace.yaml)");
    dir = parent;
  }
}

/**
 * Where the course documents live.
 *
 * `COURSES_DIR` overrides, so the same script can check a mounted volume in
 * packaging without a code change — `ARCHITECTURE.md` §10.
 */
export function coursesDir(): string {
  return process.env.COURSES_DIR
    ? resolve(process.env.COURSES_DIR)
    : resolve(workspaceRoot(), "courses");
}

export function contractsRoot(): string {
  return resolve(workspaceRoot(), "packages/contracts");
}
