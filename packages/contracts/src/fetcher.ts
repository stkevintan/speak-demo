import { ApiErrorBody } from "./zod/http.js";

/**
 * The single `fetch` wrapper every generated hook calls.
 *
 * Hand-written (the generator only *references* it) so the browser and the
 * server agree on one error shape: a non-2xx response is thrown as `ApiError`
 * carrying the contract's `{ code, message }`, which is what the UI renders.
 * Without this, orval's default throws a bare `Response` and every call site
 * ends up inventing its own error message.
 *
 * Lives beside `generated/` rather than inside it, because `clean: true` wipes
 * that directory on every codegen run.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Orval's hook error type is the thrown exception, not the JSON error body. */
export type ErrorType<_Body> = ApiError;

export async function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ApiError(response.status, "invalid_error_response", "The server returned an unreadable error.");
    }
    const parsed = ApiErrorBody.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(response.status, "invalid_error_response", "The server returned an invalid error.");
    }
    throw new ApiError(
      response.status,
      parsed.data.code,
      parsed.data.message,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
