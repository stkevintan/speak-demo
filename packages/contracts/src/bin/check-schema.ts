import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { contractsRoot } from "./paths.js";
import { Course } from "../zod/course.js";
import { REALTIME_EVENTS } from "../zod/events.js";
import {
  CoachSignal,
  Correction,
  CourseCard,
  Debrief,
  Pattern,
  Profile,
  ProfilePatch,
  SessionStart,
  Turn,
  EndReason,
  SessionRecord,
} from "../zod/session.js";
import { Progress } from "../zod/progress.js";
import { ApiErrorBody, StartSessionRequest } from "../zod/http.js";
import { SessionSnapshot } from "../zod/events.js";
import { CloseAck, CloseRequest, WorkerBootstrap, WorkerCheckpoint, WorkerLease } from "../zod/worker.js";

/**
 * JSON Schema for everything that crosses a process boundary — the course
 * definition, the HTTP bodies and the realtime events (`CODE_INSTRUCTION.md`:
 * "JSON Schema for agent + course definitions", checked at runtime **and**
 * offline).
 *
 * The schemas are **generated from zod, not written twice**. One source means
 * they cannot disagree; the offline half of the check is a drift test, so a
 * schema that no longer matches its validator fails here instead of failing in
 * production. Run with `--write` to regenerate.
 *
 * `openapi.yaml` `$ref`s these files rather than restating them, which is what
 * keeps the HTTP spec from becoming a third place to edit the same shape.
 */
const write = process.argv.includes("--write");

const http: Array<[string, z.ZodType]> = [
  ["Profile", Profile],
  ["ProfilePatch", ProfilePatch],
  ["CourseCard", CourseCard],
  ["SessionStart", SessionStart],
  ["Debrief", Debrief],
  ["Correction", Correction],
  ["Pattern", Pattern],
  ["CoachSignal", CoachSignal],
  ["Turn", Turn],
  ["StartSessionRequest", StartSessionRequest],
  ["Progress", Progress],
  ["ApiErrorBody", ApiErrorBody],
];

const targets: Array<[string, z.ZodType]> = [
  ["schema/course.schema.json", Course],
  ...http.map(([name, schema]) => [`schema/http/${name}.schema.json`, schema] as [string, z.ZodType]),
  ...Object.entries(REALTIME_EVENTS).map(
    ([name, schema]) => [`schema/events/${name}.schema.json`, schema as z.ZodType] as [string, z.ZodType],
  ),
  ...Object.entries({
    EndReason, SessionRecord, SessionSnapshot, WorkerBootstrap,
    WorkerLease, WorkerCheckpoint, CloseRequest, CloseAck,
  }).map(([name, schema]) => [`schema/worker/${name}.schema.json`, schema] as [string, z.ZodType]),
];

let drifted = 0;

for (const [rel, schema] of targets) {
  const path = resolve(contractsRoot(), rel);
  const generated = `${JSON.stringify(z.toJSONSchema(schema, { io: "output" }), null, 2)}\n`;

  if (write) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, generated);
    console.log(`  wrote ${rel}`);
    continue;
  }

  if (!existsSync(path)) {
    console.error(`  FAIL  ${rel} is missing — run \`pnpm --filter @rehearsal/contracts codegen:schema\``);
    drifted++;
    continue;
  }

  if (readFileSync(path, "utf8") !== generated) {
    console.error(`  FAIL  ${rel} does not match its zod schema — run \`codegen:schema\``);
    drifted++;
    continue;
  }

  console.log(`  ok    ${rel}`);
}

if (write) {
  console.log(`\nwrote ${targets.length} schema(s)`);
} else if (drifted > 0) {
  console.error(`\n${drifted} schema(s) out of date`);
  process.exit(1);
} else {
  console.log(`\n${targets.length} schema(s) match their validators`);
}

/**
 * Every `$ref` in `openapi.yaml` must point at a file that exists and at a
 * component that is declared.
 *
 * orval resolves these at codegen time, so a typo would surface as a confusing
 * generator error rather than "line 130 points at a schema that isn't there".
 */
function checkOpenApiRefs(): string[] {
  const spec = parse(readFileSync(resolve(contractsRoot(), "openapi.yaml"), "utf8")) as Record<string, unknown>;
  const failures: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !seen.has(value)) {
        seen.add(value);
        if (value.startsWith("#/")) {
          const target = value
            .slice(2)
            .split("/")
            .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], spec);
          if (target === undefined) failures.push(`openapi.yaml: ${value} is not declared`);
        } else {
          if (!existsSync(resolve(contractsRoot(), value))) {
            failures.push(`openapi.yaml: ${value} does not exist`);
          }
        }
      }
      walk(value);
    }
  };

  walk(spec);
  return failures;
}

const refFailures = checkOpenApiRefs();
if (refFailures.length > 0) {
  console.error(`\n${refFailures.length} unresolved ref(s) in openapi.yaml:`);
  for (const f of refFailures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`  ok    openapi.yaml refs resolve`);
