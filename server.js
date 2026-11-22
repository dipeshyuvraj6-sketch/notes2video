const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const config = require('./src/config');
const logger = require('./src/logger');
const { extractText, prepareText, classifyPdfError } = require('./src/pdf');
const { generateScenes, generateConciseNarration } = require('./src/llm');
const { generateNarrationWithRetries } = require('./src/audio');
const { render, checkKinoAvailable } = require('./src/render');
const { runCleanup, startInterval, checkDiskSpace } = require('./src/cleanup');

const app = express();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
fs.mkdirSync(config.VIDEOS_DIR, { recursive: true });

function errorResponse(res, status, code, message, jobId = null) {
  return res.status(status).json({ error: message, code, jobId });
}

const upload = multer({
  dest: config.UPLOADS_DIR,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname)) callback(null, true);
    else callback(Object.assign(new Error('ONLY_PDF'), { code: 'ONLY_PDF' }));
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/videos/:file', (req, res, next) => {
  if (!uuidPattern.test(req.params.file.replace(/\.mp4$/i, '')) || !/\.mp4$/i.test(req.params.file)) {
    return res.sendStatus(404);
  }
  return res.sendFile(path.join(config.VIDEOS_DIR, req.params.file), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.post('/api/generate', upload.single('pdf'), async (req, res) => {
  const jobId = randomUUID();
  const log = (stage, status, ms, meta) => logger.log(jobId, stage, status, ms, meta);
  if (!req.file) return errorResponse(res, 400, 'NO_FILE', 'No PDF file was received.', jobId);
  let narrationPath = null;
  let renderCompleted = false;

  try {
    const handle = await fs.promises.open(req.file.path, 'r');
    const signature = Buffer.alloc(5);
    try {
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    if (signature.toString('latin1') !== '%PDF-') {
      return errorResponse(res, 400, 'ONLY_PDF', 'Only valid PDF files are supported.', jobId);
    }

    const disk = await checkDiskSpace();
    if (!disk.ok) return errorResponse(res, 503, 'DISK_FULL', 'Server storage is full.', jobId);

    const extractStart = Date.now();
    let extracted;
    try {
      extracted = await extractText(req.file.path);
    } catch (error) {
      const issue = classifyPdfError(error);
      log('extract', 'error', Date.now() - extractStart, { code: issue.code, error: error.message });
      return errorResponse(res, 400, issue.code, issue.message, jobId);
    }
    const cleaned = prepareText(extracted.text);
    if (cleaned.text.length < config.MIN_TEXT_CHARS) {
      return errorResponse(res, 422, 'PDF_NO_TEXT', 'No readable text found. Scanned PDFs are not supported yet.', jobId);
    }
    log('extract', 'ok', Date.now() - extractStart, { pages: extracted.pages, chars: cleaned.text.length });

    const llmStart = Date.now();
    let generated;
    try {
      generated = await generateScenes(cleaned.text);
    } catch (error) {
      log('llm', 'error', Date.now() - llmStart, {
        code: error.userCode || error.code,
        status: error.status,
        validationErrors: error.errors
      });
      const code = error.userCode || error.code || 'LLM_UNAVAILABLE';
      const status = ['CONTENT_BLOCKED', 'SOURCE_MISMATCH'].includes(code) ? 422 : code === 'LLM_TIMEOUT' ? 504 : 502;
      const messages = {
        CONTENT_BLOCKED: 'This content could not be processed.',
        SOURCE_MISMATCH: 'The generated script did not match your PDF notes. Please retry with a clearer, text-based PDF.',
        LLM_TIMEOUT: 'AI generation timed out. Please try again.',
        LLM_INVALID_OUTPUT: 'AI returned an unusable script. Please try again.',
        LLM_UNAVAILABLE: 'AI service is unavailable. Check your API key and try again.'
      };
      return errorResponse(res, status, code, messages[code] || messages.LLM_UNAVAILABLE, jobId);
    }
    log('llm', 'ok', Date.now() - llmStart, { scenes: generated.sceneCount, duration: generated.totalDuration });

    const sceneNarrations = generated.data.scenes
      .map((scene) => scene.elements.map((element) => element.text).join('. '))
    const narrationStart = Date.now();
    try {
      const narration = await generateNarrationWithRetries(
        generated.data,
        cleaned.text,
        sceneNarrations,
        jobId,
        generateConciseNarration
      );
      narrationPath = narration.audioPath;
      generated.totalDuration = narration.totalDuration;
      log('narration', 'ok', Date.now() - narrationStart, {
        duration: narration.durationSeconds,
        audioDurations: narration.audioDurationsSeconds,
        maxDuration: narration.maxDurationSeconds,
        shortenRetries: narration.shortenRetries,
        size: narration.size
      });
    } catch (error) {
      if (error.audioPath) narrationPath = error.audioPath;
      log('narration', 'error', Date.now() - narrationStart, {
        code: error.userCode || error.code,
        status: error.status,
        audioDuration: error.audioDurationSeconds,
        audioDurations: error.audioDurationsSeconds,
        maxDuration: error.maxDurationSeconds,
        shortenRetries: error.shortenRetries,
        scenes: error.sceneCount
      });
      const code = error.userCode || error.code || 'TTS_UNAVAILABLE';
      const status = code === 'TTS_TIMEOUT' ? 504 : code === 'NARRATION_TOO_LONG' ? 422 : code === 'TTS_STORAGE_ERROR' ? 500 : 502;
      const messages = {
        TTS_TIMEOUT: 'Voice narration timed out. Please try again.',
        TTS_UNAVAILABLE: 'Voice narration is unavailable. Check that Gemini TTS is enabled for your API key.',
        NARRATION_REWRITE_FAILED: 'The app could not safely shorten the narration. Please try again.',
        TTS_INVALID_AUDIO: 'The voice service returned invalid audio. Please try again.',
        TTS_STORAGE_ERROR: 'The server could not save the narration audio.',
        NARRATION_TOO_LONG: 'The narration is too long to synchronize with this video. Please try a shorter PDF.'
      };
      const hasMeasuredDuration = Number.isFinite(error.audioDurationSeconds) &&
        Number.isFinite(error.maxDurationSeconds);
      const message = hasMeasuredDuration && code === 'NARRATION_TOO_LONG'
        ? `Narration is ${error.audioDurationSeconds.toFixed(1)} seconds after ${error.shortenRetries} shortening attempts; these scenes can fit up to ${error.maxDurationSeconds} seconds.`
        : hasMeasuredDuration && code === 'NARRATION_REWRITE_FAILED'
          ? `Narration is ${error.audioDurationSeconds.toFixed(1)} seconds, but these scenes can fit up to ${error.maxDurationSeconds} seconds. The app could not safely shorten it.`
          : messages[code] || messages.TTS_UNAVAILABLE;
      return errorResponse(res, status, code, message, jobId);
    }

    const renderStart = Date.now();
    try {
      const result = await render(jobId, generated.data, narrationPath);
      renderCompleted = true;
      log('render', 'ok', Date.now() - renderStart, { size: result.size });
    } catch (error) {
      log('render', 'error', Date.now() - renderStart, { code: error.code, stderr: (error.stderr || '').slice(0, 500) });
      const code = error.code || 'RENDER_FAILED';
      const status = code === 'BUSY' ? 429 : code === 'RENDER_TIMEOUT' ? 504 : 500;
      const messages = {
        BUSY: 'Server is busy. Please retry in a minute.',
        RENDER_TIMEOUT: 'Video rendering took too long. Please try again.',
        RENDER_UNAVAILABLE: 'Rendering service is unavailable.',
        RENDER_FAILED: 'Video rendering failed. Please try again.'
      };
      return errorResponse(res, status, code, messages[code] || messages.RENDER_FAILED, jobId);
    }
    return res.json({
      jobId,
      videoUrl: `/videos/${jobId}.mp4`,
      durationSeconds: generated.totalDuration,
      sceneCount: generated.sceneCount,
      truncated: cleaned.truncated
    });
  } catch (error) {
    log('unexpected', 'error', 0, { error: error.message });
    return errorResponse(res, 500, 'INTERNAL', 'Something went wrong. Please try again.', jobId);
  } finally {
    await fs.promises.unlink(req.file.path).catch((error) => {
      log('upload_cleanup', 'error', 0, { error: error.message });
    });
    if (narrationPath && !renderCompleted) {
      await fs.promises.unlink(narrationPath).catch((error) => {
        log('narration_cleanup', 'error', 0, { error: error.message });
      });
    }
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return errorResponse(res, 413, 'FILE_TOO_LARGE', `File exceeds ${config.MAX_UPLOAD_MB} MB.`);
  }
  if (error.code === 'ONLY_PDF') return errorResponse(res, 400, 'ONLY_PDF', 'Only PDF files are supported.');
  if (error.code === 'LIMIT_UNEXPECTED_FILE') return errorResponse(res, 400, 'NO_FILE', 'Upload one PDF using the pdf field.');
  console.error(JSON.stringify({ ts: new Date().toISOString(), stage: 'http', error: error.message }));
  return errorResponse(res, 500, 'INTERNAL', 'Something went wrong. Please try again.');
});

async function start() {
  const cleanup = await runCleanup();
  startInterval();
  logger.log(null, 'startup_cleanup', 'ok', undefined, cleanup);
  const kinoAvailable = await checkKinoAvailable();
  if (!kinoAvailable) console.warn('[STARTUP] Kino CLI unavailable; rendering will fail until dependencies are installed.');
  if (!config.GEMINI_API_KEY) console.warn('[STARTUP] GEMINI_API_KEY is not set; generation will return an AI service error.');
  const server = app.listen(config.PORT, () => {
    console.log(`Notes-to-Video server running at http://localhost:${config.PORT}`);
  });
  server.setTimeout(15 * 60 * 1000);
  server.requestTimeout = 0;
  server.headersTimeout = 70 * 1000;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[STARTUP] Unable to start server:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
