import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadCourse } from "../load.js";

/**
 * Offline check of the course loader — the counterpart to the runtime validation
 * inside `loadCourse`.
 *
 * The invalid fixtures are the useful half: each one is a way a course file has
 * actually gone wrong, and each carries the message an author should see. If a
 * fixture stops failing, the loader has quietly become more permissive, which is
 * exactly the regression nobody would notice until a bad course shipped.
 */
const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function checkValid(): string[] {
  const failures: string[] = [];
  const dir = resolve(fixtures, "valid");

  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    try {
      loadCourse(read(resolve(dir, name)), name);
      console.log(`  ok    valid/${name}`);
    } catch (error) {
      failures.push(`valid/${name} should load but failed: ${(error as Error).message}`);
      console.log(`  FAIL  valid/${name}`);
    }
  }
  return failures;
}

function checkInvalid(): string[] {
  const failures: string[] = [];
  const dir = resolve(fixtures, "invalid");
  const expected = JSON.parse(read(resolve(dir, "expected.json"))) as Record<string, string>;

  for (const [name, message] of Object.entries(expected)) {
    const file = `${name}.yaml`;
    try {
      loadCourse(read(resolve(dir, file)), file);
      failures.push(`invalid/${file} should have been rejected but loaded`);
      console.log(`  FAIL  invalid/${file} — loaded, expected ${JSON.stringify(message)}`);
    } catch (error) {
      const actual = (error as Error).message;
      if (!actual.includes(message)) {
        failures.push(
          `invalid/${file} said ${JSON.stringify(actual)}, expected ${JSON.stringify(message)}`,
        );
        console.log(`  FAIL  invalid/${file} — wrong message`);
      } else {
        console.log(`  ok    invalid/${file}`);
      }
    }
  }
  return failures;
}

console.log("check:loader");
const failures = [...checkValid(), ...checkInvalid()];

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nloader ok`);
