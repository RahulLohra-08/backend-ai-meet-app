// OpenAPI 3.0 description of the REST API (served at /api/docs.json, UI at /api/docs).
const json = schema => ({ 'application/json': { schema } });
const ref = n => ({ $ref: `#/components/schemas/${n}` });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (extra = {}) => ({ type: 'string', ...extra });
const err = d => ({ description: d, content: json(ref('Error')) });
const sec = [{ bearerAuth: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: str(), description: 'Meeting id or 8-character join code' };
const std = { 400: err('Validation error'), 401: err('Missing/invalid access token'), 403: err('Not allowed'), 404: err('Not found') };
const op = (summary, tag, { auth = true, params = [], body, ok = 200, okSchema, responses = {} } = {}) => ({
  summary, tags: [tag], ...(auth ? { security: sec } : {}), ...(params.length ? { parameters: params } : {}),
  ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
  responses: { [ok]: { description: 'Success', ...(okSchema ? { content: json(okSchema) } : {}) }, ...std, ...responses }
});
const q = (name, schema = str(), description = '') => ({ name, in: 'query', required: false, schema, description });

export const openApiSpec = {
  openapi: '3.0.3',
  info: { title: 'Lingua Meet API', version: '2.0.0', description: 'Multilingual meeting assistant: speech-to-text -> translation -> live captions -> AI notes -> action items. Real-time events are documented in docs/ARCHITECTURE.md.' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: obj({ error: str(), code: str(), details: { type: 'array', items: { type: 'object' } } }, ['error']),
      User: obj({ id: str(), name: str(), email: str(), role: str({ enum: ['user', 'admin'] }), preferredLanguage: str() }),
      Session: obj({ user: ref('User'), accessToken: str() }),
      Meeting: obj({ _id: str(), code: str(), title: str(), description: str(), status: str({ enum: ['scheduled', 'live', 'completed'] }), sourceLanguage: str(), targetLanguage: str(), requireInvite: { type: 'boolean' }, isHost: { type: 'boolean' }, lastSeq: { type: 'integer' }, participants: { type: 'array', items: obj({ userId: str(), name: str(), role: str(), captionLanguage: str() }) } }),
      Segment: obj({ id: str(), seq: { type: 'integer' }, segmentId: str(), speaker: obj({ id: str(), name: str() }), text: str(), sourceLanguage: str(), detectedLanguage: { type: 'string', nullable: true }, provider: str(), occurredAt: str({ format: 'date-time' }), translation: { type: 'object', nullable: true, properties: { text: str(), targetLanguage: str(), provider: str() } } }),
      Summary: obj({ status: str({ enum: ['processing', 'completed', 'failed'] }), content: obj({ overview: str(), executiveSummary: str(), discussionTopics: { type: 'array', items: str() }, keyPoints: { type: 'array', items: str() }, decisions: { type: 'array', items: str() }, unresolvedQuestions: { type: 'array', items: str() }, nextSteps: { type: 'array', items: str() } }), error: str(), errorCode: str() }),
      ActionItem: obj({ id: str(), meetingId: str(), description: str(), assignedTo: { type: 'object', nullable: true }, dueDate: { type: 'string', nullable: true }, priority: str({ enum: ['low', 'medium', 'high'] }), status: str({ enum: ['todo', 'in_progress', 'done'] }), source: str({ enum: ['ai_suggested', 'user_confirmed', 'manual'] }), transcriptSeqs: { type: 'array', items: { type: 'integer' } } })
    }
  },
  paths: {
    '/api/health': { get: op('Health check (includes database state)', 'System', { auth: false }) },
    '/api/languages': { get: op('Supported languages', 'System', { auth: false }) },
    '/api/capabilities': { get: op('Which speech / translation / AI providers are configured', 'System', { auth: false }) },
    '/api/diagnostics/providers': { post: op('Live check of the configured LLM / speech / translation providers (what the provider really answers: ok, invalid_key, quota_exceeded, rate_limited...)', 'System') },
    '/api/auth/register': { post: op('Create account', 'Auth', { auth: false, ok: 201, okSchema: ref('Session'), body: obj({ name: str(), email: str(), password: str({ minLength: 8 }), remember: { type: 'boolean' } }, ['name', 'email', 'password']), responses: { 409: err('Email already registered') } }) },
    '/api/auth/login': { post: op('Sign in (sets httpOnly refresh cookie)', 'Auth', { auth: false, okSchema: ref('Session'), body: obj({ email: str(), password: str(), remember: { type: 'boolean' } }, ['email', 'password']) }) },
    '/api/auth/refresh': { post: op('Rotate refresh cookie and get a new access token', 'Auth', { auth: false, okSchema: ref('Session') }) },
    '/api/auth/logout': { post: op('Revoke the current refresh token', 'Auth', { auth: false }) },
    '/api/auth/logout-all': { post: op('Revoke every session of the user', 'Auth') },
    '/api/auth/me': {
      get: op('Current user', 'Auth', { okSchema: obj({ user: ref('User') }) }),
      patch: op('Update profile', 'Auth', { body: obj({ name: str(), preferredLanguage: str() }) })
    },
    '/api/auth/change-password': { post: op('Change password (revokes other sessions)', 'Auth', { body: obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword']) }) },
    '/api/auth/forgot-password': { post: op('Request a password reset link', 'Auth', { auth: false, body: obj({ email: str() }, ['email']) }) },
    '/api/auth/reset-password': { post: op('Set a new password with a reset token', 'Auth', { auth: false, body: obj({ token: str(), newPassword: str() }, ['token', 'newPassword']) }) },
    '/api/meetings': {
      post: op('Create meeting', 'Meetings', { ok: 201, okSchema: obj({ meeting: ref('Meeting') }), body: obj({ title: str(), description: str(), sourceLanguage: str({ description: "ISO code or 'auto'" }), targetLanguage: str(), requireInvite: { type: 'boolean' }, invitedEmails: { type: 'array', items: str() } }, ['title']) }),
      get: op('List my meetings (paged)', 'Meetings', { params: [q('page', { type: 'integer' }), q('limit', { type: 'integer' }), q('status'), q('q')] })
    },
    '/api/meetings/{id}': {
      get: op('Get meeting', 'Meetings', { params: [idParam], okSchema: obj({ meeting: ref('Meeting') }) }),
      patch: op('Update meeting (host)', 'Meetings', { params: [idParam], body: obj({ title: str(), description: str(), sourceLanguage: str(), targetLanguage: str() }) }),
      delete: op('Delete meeting and all derived data (host)', 'Meetings', { params: [idParam] })
    },
    '/api/meetings/{id}/join': { post: op('Join (or rejoin) a meeting', 'Meetings', { params: [idParam], body: obj({ captionLanguage: str() }), responses: { 409: err('Meeting has ended') } }) },
    '/api/meetings/{id}/leave': { post: op('Leave a meeting', 'Meetings', { params: [idParam] }) },
    '/api/meetings/{id}/end': { post: op('End meeting for everyone (host); starts AI notes automatically', 'Meetings', { params: [idParam] }) },
    '/api/meetings/{id}/participants': { get: op('Participants with presence', 'Meetings', { params: [idParam] }) },
    '/api/meetings/{id}/transcripts': {
      post: op('Store a final transcript segment from the browser speech engine (idempotent on clientSegmentId)', 'Transcription', { params: [idParam], ok: 201, okSchema: obj({ transcript: ref('Segment'), duplicate: { type: 'boolean' } }), body: obj({ text: str(), sourceLanguage: str(), clientSegmentId: str(), occurredAt: str({ format: 'date-time' }) }, ['text', 'clientSegmentId']) }),
      get: op('List transcript segments (paged; afterSeq for catch-up; lang attaches stored translations)', 'Transcription', { params: [idParam, q('page', { type: 'integer' }), q('limit', { type: 'integer' }), q('afterSeq', { type: 'integer' }), q('lang')] })
    },
    '/api/meetings/{id}/audio': {
      post: {
        summary: 'Upload a short self-contained audio file for server-side speech-to-text', tags: ['Transcription'], security: sec, parameters: [idParam,
          { name: 'X-Segment-Id', in: 'header', required: true, schema: str() }, { name: 'X-Source-Language', in: 'header', required: false, schema: str() }],
        requestBody: { required: true, content: { 'audio/webm': { schema: str({ format: 'binary' }) }, 'audio/ogg': { schema: str({ format: 'binary' }) }, 'audio/wav': { schema: str({ format: 'binary' }) }, 'audio/mp4': { schema: str({ format: 'binary' }) } } },
        responses: { 200: { description: 'Duplicate segment, or no speech detected' }, 201: { description: 'Segment stored and broadcast' }, 415: err('Unsupported / invalid audio'), 503: err('Speech provider not configured'), ...std }
      }
    },
    '/api/meetings/{id}/translations': {
      get: op('List stored translations for a language', 'Translation', { params: [idParam, q('lang', str(), 'required'), q('page', { type: 'integer' })] }),
      post: op('Translate (or retry) one stored transcript segment and persist the result', 'Translation', { params: [idParam], body: obj({ transcriptId: str(), targetLanguage: str() }, ['transcriptId', 'targetLanguage']), responses: { 503: err('Translation provider not configured') } })
    },
    '/api/meetings/{id}/summarize': { post: op('Generate / regenerate AI notes (host, meeting must have ended). Returns 202 immediately.', 'AI notes', { params: [idParam], ok: 202, body: obj({ outputLanguage: str() }), responses: { 409: err('Meeting not ended, or generation already running') } }) },
    '/api/meetings/{id}/summary': { get: op('Get AI notes and generation status', 'AI notes', { params: [idParam], okSchema: obj({ summary: ref('Summary') }) }) },
    '/api/meetings/{id}/action-items': {
      get: op('List action items of a meeting', 'Action items', { params: [idParam] }),
      post: op('Create an action item', 'Action items', { params: [idParam], ok: 201, okSchema: obj({ actionItem: ref('ActionItem') }), body: obj({ description: str(), assignedTo: str(), dueDate: str({ format: 'date-time' }), priority: str() }, ['description']) })
    },
    '/api/action-items': { get: op('My assigned tasks across meetings', 'Action items', { params: [q('assignedTo', str(), "only 'me'"), q('status')] }) },
    '/api/action-items/{actionItemId}': {
      patch: op('Update an action item (host, creator or assignee). Editing an AI suggestion marks it user_confirmed.', 'Action items', { params: [{ name: 'actionItemId', in: 'path', required: true, schema: str() }], body: obj({ description: str(), assignedTo: str(), dueDate: str(), priority: str(), status: str() }) }),
      delete: op('Delete an action item', 'Action items', { params: [{ name: 'actionItemId', in: 'path', required: true, schema: str() }] })
    }
  }
};
