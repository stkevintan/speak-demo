import { z } from "zod";
import { parse } from "yaml";
import { Course } from "./zod/course.js";

/**
 * `ARCHITECTURE.md` §6.4 — turn a course document into the `Course` contract.
 *
 * There is deliberately no hand-written parser. The previous format was Markdown
 * whose body sections were key-value bullets — structure wearing prose's clothes
 * — so recovering it cost ~270 lines of section splitting, keyed-bullet parsing
 * and sub-section splitting. YAML hands that structure over directly, which
 * leaves the zod schema as the only validator and this file as the only glue.
 *
 * A course file opens with a `yaml-language-server` schema hint pointing at
 * `schema/course.schema.json`, so an author's editor catches the same mistakes
 * this does, one keystroke earlier.
 */

/** §8 requires the message to name the file; a bare zod dump does not. */
export class CourseLoadError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = "CourseLoadError";
  }
}

/** The document was well-formed YAML but not a valid `Course`. */
export class CourseSchemaError extends CourseLoadError {
  constructor(
    source: string,
    readonly error: z.ZodError,
  ) {
    super(source, z.prettifyError(error));
    this.name = "CourseSchemaError";
  }
}

/**
 * @param text   the raw document
 * @param source the path to name in errors; §8 requires the message identify the file
 */
export function loadCourse(text: string, source = "<course>"): Course {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new CourseLoadError(source, `invalid YAML — ${(error as Error).message}`);
  }

  const result = Course.safeParse(document);
  if (!result.success) throw new CourseSchemaError(source, result.error);
  return result.data;
}
