# Notes-to-Video

A single-page app that converts text-based PDF study notes into MP4 explainer videos:

1. Upload a PDF.
2. Extract and clean its text.
3. Ask Google Gemini for a structured scene script.
4. Validate the script and generate spoken narration from its scene text. If the measured audio is too long for the scenes, the app requests a shorter scene-aligned narration and measures it again, for up to two retries.
5. Match scene timing to the WAV narration and adapt the composition to Kino's JSON format.
6. Render and serve an MP4 with an embedded audio track.

The app does not perform OCR for scanned PDFs. Video playback and downloads include the generated narration. Shortening retries may make additional Gemini API calls and use API quota. If narration still cannot fit, the error reports its measured duration and the maximum duration available to the scenes.
PDF text is extracted locally, then included as the source of truth in Gemini prompts. Generated scenes are checked against distinctive source terms; mismatched output is retried with the PDF text and rejected rather than rendered if it remains off-topic.

## Requirements

- Node.js 18 or newer (Node.js 20+ recommended).
- A Google Gemini API key.
- Gemini TTS model access and available API quota; narration requests may incur usage charges.
- FFmpeg/Kino dependencies available on the host. Kino's bundled FFmpeg is installed with the package.

## Setup and run (Windows PowerShell)

From the project directory:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Set `GEMINI_API_KEY` in `.env`, save it, and then start the server:

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). Upload a text-based PDF no larger than 10 MB, choose **Generate Video**, then play or download the result.

If PowerShell says the port is occupied, set a different `PORT` value in `.env`.

## Run tests

```powershell
npm test
```

These tests cover script parsing/normalization, source-topic grounding, narration timing, WAV handling, and the Kino scene adapter. They mock Gemini requests and do not require an API key.

## Health check and manual API test

With the server running, check:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

Expected response: `{ "ok": true }`.

To exercise PDF upload end-to-end, use a real, text-based PDF:

```powershell
curl.exe -F "pdf=@C:\path\to\study-notes.pdf;type=application/pdf" http://localhost:3000/api/generate
```

The response contains `videoUrl`, `sceneCount`, `durationSeconds`, and `truncated`. Open the returned video URL in the browser or use it to download the MP4 with embedded voice narration. This end-to-end test uses the configured Gemini text and TTS APIs and may take several minutes.

## Configuration

See [.env.example](.env.example). `GEMINI_TTS_MODEL` defaults to `gemini-3.8-flash-tts`, and `GEMINI_TTS_VOICE` defaults to `Charon`. Important other values include `MAX_UPLOAD_MB`, `MAX_INPUT_CHARS`, `MAX_VIDEO_SECONDS`, `GEMINI_TIMEOUT_MS`, `RENDER_TIMEOUT_MS`, and `FILE_TTL_HOURS`. Uploads are deleted after request completion; generated videos, scene JSON, and temporary narration WAV files are deleted after the configured TTL.
