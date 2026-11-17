import { badRequest } from '../utils/httpError.js';

/** Validate req[source] with a zod schema; parsed data is stored in req.valid[source]. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    return next(badRequest(first.path ? `${first.path}: ${first.message}` : first.message, 'VALIDATION_ERROR', issues));
  }
  req.valid = { ...(req.valid || {}), [source]: result.data };
  next();
};
