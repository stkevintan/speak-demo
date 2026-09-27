import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  Course, CourseCard, CourseId, Debrief, Profile, ProfilePatch, SessionId, SessionStart, StartSessionRequest,
} from "@rehearsal/contracts";
import { AuthGuard, type AuthenticatedRequest } from "./auth.js";
import { ProfileService } from "./memory.js";
import { CourseService } from "./catalog.js";
import { SessionService } from "./sessions.js";
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
  ) {}
  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return z.array(CourseCard).parse(await this.courses.list((await this.profiles.get(request.userId)).level));
  }
  @Get(":id")
  async get(@Param("id") id: string) { return Course.parse(await this.courses.get(input(CourseId, id))); }
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
