export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}
export const badRequest = (m, c = 'BAD_REQUEST', d) => new HttpError(400, m, c, d);
export const unauthorized = (m = 'Authentication required.', c = 'UNAUTHENTICATED') => new HttpError(401, m, c);
export const forbidden = (m = 'You are not allowed to do that.', c = 'FORBIDDEN') => new HttpError(403, m, c);
export const notFound = (m = 'Not found.', c = 'NOT_FOUND') => new HttpError(404, m, c);
export const conflict = (m, c = 'CONFLICT') => new HttpError(409, m, c);

export const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
