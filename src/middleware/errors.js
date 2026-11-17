import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}`, code: 'ROUTE_NOT_FOUND' });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.code === 11000) {
    // Name the colliding field/index (never the value) so the cause is visible instead of a vague message.
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    const index = (String(err.message).match(/index: (\S+)/) || [])[1] || '';
    logger.warn('duplicate key', { path: req.path, index, fields: fields.join(',') });
    return res.status(409).json({
      error: fields.length ? `A record with the same ${fields.join(' + ')} already exists (unique index ${index || 'unknown'}).` : 'A record with this value already exists.',
      code: 'DUPLICATE', fields, index
    });
  }
  if (err?.name === 'ValidationError' || err?.name === 'CastError') return res.status(400).json({ error: 'Invalid data.', code: 'VALIDATION_ERROR' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.', code: 'INVALID_JSON' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) logger.error('Unhandled request error', { method: req.method, path: req.path, err: err?.message });
  const body = { error: err?.expose ? err.message : 'Internal server error.', code: err?.expose ? (err.code || 'ERROR') : 'INTERNAL_ERROR' };
  if (err?.expose && err.details) body.details = err.details;
  res.status(status).json(body);
}
