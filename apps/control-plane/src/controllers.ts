import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  Course, CourseCard, CourseId, Debrief, Profile, ProfilePatch, Progress, progressView, SessionId,
  SessionStart, StartSessionRequest,
} from "@rehearsal/contracts";
import { AuthGuard, type AuthenticatedRequest } from "./auth.js";
import { ProfileService } from "./memory.js";
import { CourseService } from "./catalog.js";
import { SessionService } from "./sessions.js";
import { CourseRepo, SessionRepo } from "./storage/ports.js";
import { apiError } from "./errors.js";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw apiError(400, "invalid_request", "Please check the request and try again.");
  return parsed.data;
}

@Controller("me")
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}
  @Get()
  async get(@Req() request: AuthenticatedRequest) { return Profile.parse(await this.profiles.get(request.userId)); }
  @Patch()
  async patch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return Profile.parse(await this.profiles.patch(request.userId, input(ProfilePatch, body)));
  }
}

@Controller("courses")
@UseGuards(AuthGuard)
export class CourseController {
  constructor(
    @Inject(CourseService) private readonly courses: CourseService,
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(SessionRepo) private readonly sessions: SessionRepo,
  ) {}
  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const profile = await this.profiles.get(request.userId);
    return z.array(CourseCard).parse(await this.courses.list(profile.level, await this.sessions.learnedCourses(request.userId)));
  }
  @Get(":id")
  async get(@Param("id") id: string) { return Course.parse(await this.courses.get(input(CourseId, id))); }
  @Post(":id/unlearn")
  @HttpCode(204)
  async unlearn(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const courseId = input(CourseId, id);
    await this.courses.get(courseId);
    await this.sessions.unlearnCourse(request.userId, courseId);
  }
}

@Controller("progress")
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(
    @Inject(CourseRepo) private readonly catalog: CourseRepo,
    @Inject(SessionRepo) private readonly sessions: SessionRepo,
  ) {}
  @Get()
  async get(@Req() request: AuthenticatedRequest) {
    // Derivation lives in the contract, so `web` and the API cannot disagree
    // about what a goal state means; the controller only gathers the two inputs.
    return Progress.parse(progressView(await this.catalog.listCourses(), await this.sessions.attempts(request.userId)));
  }
}

@Controller("sessions")
@UseGuards(AuthGuard)
export class SessionController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}
  @Post()
  async start(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return SessionStart.parse(await this.sessions.start(request.userId, input(StartSessionRequest, body).courseId));
  }
  @Post(":id/end")
  @HttpCode(200)
  async end(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return Debrief.parse(await this.sessions.end(request.userId, input(SessionId, id)));
  }
  @Get(":id/debrief")
  async debrief(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return Debrief.parse(await this.sessions.debrief(request.userId, input(SessionId, id)));
  }
}
