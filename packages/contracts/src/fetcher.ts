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

export async function fetcher<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.code ?? "unknown",
      body?.message ?? "Something went wrong. Try again.",
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
