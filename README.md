# Lingua Meet API

## Requirements
Node.js 20+ and MongoDB local or Atlas.

## Run on Windows PowerShell
```powershell
cd server
Copy-Item .env.example .env
# Edit .env and set a unique JWT_SECRET; set MONGODB_URI for your MongoDB.
npm install
npm run dev
```
Health check: `GET http://localhost:4000/api/health`.

## Main routes
- `POST /api/auth/register` `{ "name":"A User", "email":"a@example.com", "password":"at-least-8-chars" }`
- `POST /api/auth/login` `{ "email":"a@example.com", "password":"..." }`
- `GET /api/auth/me` (Bearer access token)
- `POST /api/meetings` `{ "title":"Hindi-English Sync", "sourceLanguage":"hi", "targetLanguage":"en" }`
- `GET /api/meetings`, `GET /api/meetings/:id`
- `POST /api/meetings/:id/join`, `/leave`, `/end`
- `GET /api/meetings/:id/transcripts`
- `POST /api/meetings/:id/transcripts` `{ "text":"नमस्ते", "sourceLanguage":"hi", "targetLanguage":"en", "clientSegmentId":"unique-id" }`
- `POST /api/meetings/:id/translations` `{ "text":"नमस्ते", "sourceLanguage":"hi", "targetLanguage":"en" }`
- `POST /api/meetings/:id/summarize`, `GET /api/meetings/:id/summary`
- `GET /api/meetings/:id/action-items`
- `POST /api/action-items`, `PATCH /api/action-items/:id`, `DELETE /api/action-items/:id`

Pass `Authorization: Bearer <accessToken>` on protected routes. Socket.IO uses `io(url, { auth: { token } })`; emit `meeting:join` with `{ meetingId }` and acknowledgement callback. Server only joins a room after checking membership. Server broadcasts persisted `transcript:updated` events only into that meeting room.

## Provider setup
- Translation: configure `LIBRETRANSLATE_URL`; optional `LIBRETRANSLATE_API_KEY`. Self-host LibreTranslate or use a provider endpoint you are authorized to use.
- AI notes: configure `OPENAI_API_KEY`, optionally `OPENAI_MODEL` and `OPENAI_BASE_URL`.
- Speech: the frontend browser SpeechRecognition API can be used where supported. Browser support varies; use HTTPS or localhost. This API is browser-provided and does not guarantee availability on every browser/device. For production-grade streaming, integrate a dedicated speech provider adapter.

## Important limitations
Access tokens are short-lived JWTs, but this initial implementation does not issue refresh tokens and logout is client-side token removal. Do not describe it as full refresh-token security. Password reset, profile update, audio object storage, and automated integration tests still need to be added before production deployment. AI action items are explicitly marked `ai_suggested`; users should confirm them before treating them as commitments.
