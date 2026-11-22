# Notes-to-Video: Project and Agent Runbook

## Purpose

Notes-to-Video is a Node.js web application that turns a text-based PDF into a narrated MP4 explainer video. A browser uploads the PDF to an Express server. The server extracts and cleans its text, asks Google Gemini to create a scene script, validates the script against the source, generates voice narration with Gemini TTS, and renders the video with Kino.

The generation request is synchronous: the browser waits for script generation, narration, and rendering to finish before it receives the video URL.

## Architecture and request flow

1. The browser UI in `public/` accepts one PDF, checks its extension, MIME type, and size, then submits it as multipart form field `pdf`.
2. `server.js` applies server-side upload limits and PDF MIME/extension checks. It also checks the file's `%PDF-` signature.
3. `src/pdf.js` extracts text with `pdf-parse`, removes control characters and excess whitespace, strips standalone page numbers, and truncates input to the configured character limit. Files with too little readable text are rejected; scanned PDFs are not OCR'd.
4. `src/llm.js` sends the extracted text to Gemini. `src/prompt.js` defines the expected scene output and estimates a target duration from the word count. `src/validate.js` validates and normalizes the response, checks source-topic grounding, and rejects unsuitable output.
5. `src/audio.js` sends scene text to Gemini TTS, checks the returned WAV audio, and aligns scene durations with the measured narration. If narration is too long, `src/llm.js` can ask Gemini to shorten it; up to two shortening attempts are made.
6. `src/adapter.js` maps validated scenes into Kino's format. `src/render.js` invokes the Kino CLI to render an MP4 with narration.
7. The server responds with a video URL and metadata. The browser plays the MP4 and offers a download link.
8. Uploaded PDFs are deleted after processing. Generated videos and intermediate files are stored under `videos/`; `src/cleanup.js` removes old files based on the configured retention period.

The app does not currently accept PPTX, DOCX, images, or arbitrary file formats. It does not OCR scanned PDFs.

## Repository map

- `server.js` — Express app, HTTP routes, upload validation, generation orchestration, and server startup.
- `public/index.html`, `public/style.css`, `public/app.js` — browser interface and upload/generation flow.
- `src/config.js` — environment-backed configuration and project paths.
- `src/pdf.js` — PDF text extraction, cleanup, and PDF errors.
- `src/prompt.js`, `src/llm.js` — Gemini prompts, scene creation, and narration shortening.
- `src/schema.js`, `src/validate.js` — scene schema and validation/grounding.
- `src/audio.js` — Gemini TTS, WAV validation, narration retries, and timing alignment.
- `src/adapter.js`, `src/render.js` — Kino data conversion and MP4 rendering.
- `src/cleanup.js`, `src/logger.js` — storage cleanup, free-space checks, and structured logs.
- `test/` — automated tests, including validation, audio timing, WAV processing, and rendering-adapter behavior.
- `videos/`, `uploads/` — runtime storage directories; their generated contents are not source files.

## Requirements and configuration

- Node.js 18 or newer (Node.js 20+ is recommended).
- npm.
- A Google Gemini API key with access/quota for the configured text and TTS models to generate videos.
- Network access to Gemini APIs.
- Kino and its FFmpeg dependencies, installed through the npm dependencies.

Configuration is loaded from `.env` by `src/config.js`. `.env.example` lists the supported variables and defaults. Important settings include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `GEMINI_API_KEY` | empty | Gemini API credential |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Scene-script model |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-tts` | Narration model |
| `GEMINI_TTS_VOICE` | `Charon` | Narration voice |
| `MAX_UPLOAD_MB` | `10` | Maximum PDF upload size |
| `MAX_INPUT_CHARS` | `60000` | Maximum extracted text sent to Gemini |
| `MAX_VIDEO_SECONDS` | `300` | Maximum scene/video duration |
| `MIN_SCENE_SEC` / `MAX_SCENE_SEC` | `4` / `12` | Per-scene duration limits |
| `LLM_MAX_RETRIES` | `2` | Scene-generation retries after the first attempt |
| `GEMINI_TIMEOUT_MS` | `120000` | Timeout for a Gemini request |
| `RENDER_TIMEOUT_MS` | `600000` | Maximum Kino render duration |
| `MAX_CONCURRENT_RENDERS` | `1` | Concurrent render limit |
| `FILE_TTL_HOURS` | `24` | Retention period for generated files |
| `MIN_FREE_DISK_MB` | `500` | Minimum free disk space before generation |

The target video duration is estimated from extracted word count (about half a second per word), then bounded by the configured minimum/maximum. PDF page count alone does not determine video length. The 300-second default is a cap, not a promise that every input will produce a five-minute video.

## Setup and run on Windows PowerShell

From the project directory:

```powershell
npm ci
Copy-Item .env.example .env
notepad .env
```

Set `GEMINI_API_KEY` in `.env`, save it, then start the server:

```powershell
npm start
```

Open `http://localhost:3000`. To check server health:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

Expected response:

```json
{"ok":true}
```

For development, `npm run dev` starts Node's watch mode. If port 3000 is occupied, set a different `PORT` in `.env`.

## How another AI agent should work with this repository

1. Clone the repository and inspect `README.md`, this report, `package.json`, and `.env.example` before changing code.
2. The current repository includes `node_modules/` because the project owner requested it. For a clean install or a different operating system, run `npm ci` in the repository root; npm recreates dependencies from `package-lock.json`.
3. To run tests, use `npm test`. The automated tests mock Gemini and should not require an API key.
4. To run the app, create a local `.env` from `.env.example`, provide a valid Gemini API key locally, then run `npm start`. Do not ask the user to paste a key into chat or commit `.env`.
5. Verify the server with `GET /api/health`. For full generation, use a small, text-based PDF and expect API usage and potentially several minutes of processing.
6. After a change, run the focused relevant tests, then `npm test` if the change affects shared behavior. Keep the synchronous API contract, upload field name `pdf`, error response format, and cleanup behavior consistent unless intentionally changing them.
7. Never commit credentials, user uploads, generated videos, or runtime output. This repository currently tracks `node_modules/` by request. Review `git status` before committing.

## HTTP interface

- `GET /api/health` — returns `{ "ok": true }` when the server is available.
- `POST /api/generate` — multipart upload using form field `pdf`; on success returns `jobId`, `videoUrl`, `durationSeconds`, `sceneCount`, and `truncated`.
- `GET /videos/<job-id>.mp4` — serves a generated video when the filename uses the expected UUID format.

Generation errors are returned as JSON with `error`, `code`, and (where available) `jobId`. The server writes structured stage logs to stdout to help diagnose extraction, Gemini, narration, rendering, and cleanup failures.

## Known limitations

- PDF is the only supported input format, and only PDFs with extractable text are supported.
- Scanned/image-only PDFs are not OCR'd.
- Gemini text and TTS availability, response time, and quota affect generation.
- The request is synchronous; there is no background job queue or persisted job-status endpoint.
- Video duration depends on extracted content, scene constraints, and configured caps, not just PDF page count.
- Rendering is limited to one concurrent render by default; a second render may receive a busy error.
- The browser request timeout is 10 minutes, while server rendering can be allowed up to 10 minutes in addition to earlier pipeline stages. Long jobs may therefore hit the browser timeout before server processing finishes.
- Generated assets are stored on local disk and cleaned according to `FILE_TTL_HOURS`; this is not durable multi-user/cloud storage.
