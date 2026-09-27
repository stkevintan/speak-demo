import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { coursesDir } from "./paths.js";
import { loadCourse } from "../load.js";
import { toCourseCard } from "../card.js";
import { Level } from "../zod/course.js";

/**
 * Offline check of every course document in `courses/` — the same `loadCourse`
 * the control-plane calls at load time.
 *
 * Sharing the function is the point: a file that passes here cannot fail on
 * startup, so this is a real guarantee rather than a lint. It also catches the
 * duplicate-`id` case, which no single-file parse can see.
 *
 * @see `COURSES_DIR` to point it at a mounted volume (`ARCHITECTURE.md` §10).
 */
const dir = coursesDir();

if (!existsSync(dir)) {
  console.error(`no courses directory at ${dir}`);
  console.error(`set COURSES_DIR to point elsewhere, or add ${dir}/*.yaml`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
if (files.length === 0) {
  console.error(`no .yaml course documents in ${dir}`);
  process.exit(1);
}

console.log(`check:courses  (${dir})`);

const failures: string[] = [];
const seen = new Map<string, string>();

for (const file of files) {
  try {
    const course = loadCourse(readFileSync(resolve(dir, file), "utf8"), file);

    const clash = seen.get(course.id);
    if (clash) {
      failures.push(`${file}: id \`${course.id}\` is already used by ${clash}`);
      console.log(`  FAIL  ${file}`);
      continue;
    }
    seen.set(course.id, file);

    // Project every card the picker could ask for, so a fit rule that only breaks
    // for one learner level breaks here rather than on someone's screen.
    const cards = Level.options.map((level) => toCourseCard(course, level));
    console.log(
      `  ok    ${file}  ${course.id}  ${course.levels.join("/")}  ` +
        `fits ${cards.map((c) => `${c.fit}`).join("/")}  ${course.coachHints.length} hint(s)`,
    );
  } catch (error) {
    failures.push((error as Error).message);
    console.log(`  FAIL  ${file}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} course(s) failed:`);
  for (const f of failures) console.error(`\n${f}`);
  process.exit(1);
}

console.log(`\n${files.length} course(s) ok`);
