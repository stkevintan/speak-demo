import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Course, CourseLoadError, loadCourse, toCourseCard, type Level } from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "./config.js";
import { CourseRepo } from "./storage/ports.js";
import { apiError } from "./errors.js";

@Injectable()
export class CourseService {
  private readonly logger = new Logger(CourseService.name);
  constructor(
    @Inject(CourseRepo) private readonly repo: CourseRepo,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  async onModuleInit() {
    const files = (await readdir(this.config.coursesDir)).filter((name) => /\.ya?ml$/u.test(name)).sort();
    const courses: Course[] = [];
    const ids = new Set<string>();
    for (const name of files) {
      const file = join(this.config.coursesDir, name);
      const text = await readFile(file, "utf8");
      let course: Course;
      try { course = loadCourse(text, name); }
      catch (error) {
        if (!(error instanceof CourseLoadError)) throw error;
        this.logger.error(error.message);
        continue;
      }
      if (ids.has(course.id)) throw new Error(`Duplicate course ID in ${name}`);
      ids.add(course.id);
      courses.push(course);
    }
    if (!courses.length) throw new Error("No valid courses available");
    await this.repo.replaceCatalog(courses);
  }
  async list(level: Level) {
    const order = { on_level: 0, easy: 1, stretch: 2 };
    return (await this.repo.listCourses()).map((course) => toCourseCard(course, level))
      .sort((a, b) => order[a.fit] - order[b.fit] || a.id.localeCompare(b.id));
  }
  async get(id: string) {
    const course = await this.repo.course(id);
    if (!course) throw apiError(404, "not_found", "That scene was not found.");
    return course;
  }
}
