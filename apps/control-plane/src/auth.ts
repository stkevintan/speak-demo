import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response } from "express";
import { z } from "zod";
import { AUTH_COOKIE_NAME } from "@rehearsal/contracts";
import { CONFIG, type AppConfig } from "./config.js";
import { apiError } from "./errors.js";

export interface AuthenticatedRequest extends Request { userId: string }

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const origin = request.headers.origin;
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method);
    if ((origin && !this.config.WEB_ORIGINS.includes(origin))
      || (!safeMethod && !this.config.WEB_ORIGINS.includes(origin ?? ""))) {
      throw apiError(403, "origin_rejected", "This request did not come from the practice app.");
    }
    const cookies = (request.headers.cookie ?? "").split(";")
      .map((part) => part.trim()).filter((part) => part.startsWith(`${AUTH_COOKIE_NAME}=`));
    if (cookies.length === 0 && this.config.devAuth && request.method === "GET" && request.path === "/api/me") {
      request.userId = "dev-user";
      const token = await this.jwt.signAsync({ sub: request.userId }, {
        secret: this.config.JWT_SECRET, algorithm: "HS256",
        issuer: this.config.JWT_ISSUER, audience: this.config.JWT_AUDIENCE,
        expiresIn: this.config.JWT_TTL_SECONDS,
      });
      response.cookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true, sameSite: "lax",
        secure: this.config.NODE_ENV === "production" || request.secure || this.config.WEB_ORIGINS.some((origin) => origin.startsWith("https:")),
        path: "/", maxAge: this.config.JWT_TTL_SECONDS * 1000,
      });
      return true;
    }
    if (cookies.length !== 1) throw apiError(401, "unauthorized", "Open the app to start your session.");
    const encoded = cookies[0]?.slice(AUTH_COOKIE_NAME.length + 1);
    try {
      const token = decodeURIComponent(encoded ?? "");
      const payload: unknown = await this.jwt.verifyAsync(token, {
        secret: this.config.JWT_SECRET, algorithms: ["HS256"],
        issuer: this.config.JWT_ISSUER, audience: this.config.JWT_AUDIENCE,
      });
      request.userId = z.object({ sub: z.string().min(1), exp: z.number().int().positive() }).parse(payload).sub;
    } catch { throw apiError(401, "unauthorized", "Your session has expired. Reopen the app to continue."); }
    return true;
  }
}
