import type { NextFunction, Request, Response } from 'express';

/** Consistent JSON error shape (RFC 7807-ish) for every error response this API sends. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string;

  constructor(status: number, title: string, detail?: string, type = 'about:blank') {
    super(detail ?? title);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = type;
  }

  toProblem(): ProblemDetails {
    return { type: this.type, title: this.title, status: this.status, detail: this.detail };
  }
}

export const badRequest = (detail?: string): ApiError => new ApiError(400, 'Bad Request', detail);
export const notFound = (detail?: string): ApiError => new ApiError(404, 'Not Found', detail);
export const conflict = (detail?: string): ApiError => new ApiError(409, 'Conflict', detail);
export const payloadTooLarge = (detail?: string): ApiError => new ApiError(413, 'Payload Too Large', detail);
export const unsupportedMediaType = (detail?: string): ApiError =>
  new ApiError(415, 'Unsupported Media Type', detail);

export function notFoundHandler(req: Request, res: Response): void {
  const problem = new ApiError(404, 'Not Found', `No route for ${req.method} ${req.path}`).toProblem();
  res.status(404).contentType('application/problem+json').json(problem);
}

// Express recognizes error middleware by arity (4 params) — `next` must stay unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError(500, 'Internal Server Error', err instanceof Error ? err.message : String(err));

  if (apiError.status >= 500) {
    req.log?.error({ err }, 'unhandled error');
  }

  res.status(apiError.status).contentType('application/problem+json').json(apiError.toProblem());
}
