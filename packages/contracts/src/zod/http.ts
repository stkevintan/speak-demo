import { z } from "zod";
import { Course } from "./course.js";

export const AUTH_COOKIE_NAME = "rehearsal_session";

export const CourseId = Course.shape.id;
export const SessionId = z.string().min(1);

export const StartSessionRequest = z.strictObject({
  courseId: CourseId,
});
export type StartSessionRequest = z.infer<typeof StartSessionRequest>;

export const ApiErrorBody = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
