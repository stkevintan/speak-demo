import {
  Catch, HttpException, HttpStatus, Logger,
  type ArgumentsHost, type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiErrorBody } from "@rehearsal/contracts";

export function apiError(status: number, code: string, message: string) {
  return new HttpException(ApiErrorBody.parse({ code, message }), status);
}
export function unavailable() {
  return apiError(503, "unavailable", "Practice is temporarily unavailable. Please try again.");
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = ApiErrorBody.safeParse(error.getResponse());
      response.status(status).json(body.success ? body.data : {
        code: status === 404 ? "not_found" : "invalid_request",
        message: status === 404 ? "That resource was not found." : "The request could not be processed.",
      });
      return;
    }
    this.logger.error("Unhandled request failure");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "internal_error", message: "Something went wrong. Please try again.",
    });
  }
}
