require('dotenv').config();
const path = require('path');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
  PORT: int('PORT', 3000),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
  GEMINI_TTS_VOICE: process.env.GEMINI_TTS_VOICE || 'Charon',
  MAX_UPLOAD_MB: int('MAX_UPLOAD_MB', 10),
  MIN_TEXT_CHARS: int('MIN_TEXT_CHARS', 200),
  MAX_INPUT_CHARS: int('MAX_INPUT_CHARS', 60000),
  MAX_VIDEO_SECONDS: int('MAX_VIDEO_SECONDS', 300),
  MIN_SCENE_SEC: int('MIN_SCENE_SEC', 4),
  MAX_SCENE_SEC: int('MAX_SCENE_SEC', 12),
  MAX_SCENES: int('MAX_SCENES', 120),
  LLM_MAX_RETRIES: int('LLM_MAX_RETRIES', 2),
  GEMINI_TIMEOUT_MS: int('GEMINI_TIMEOUT_MS', 120000),
  RENDER_TIMEOUT_MS: int('RENDER_TIMEOUT_MS', 600000),
  MAX_CONCURRENT_RENDERS: int('MAX_CONCURRENT_RENDERS', 1),
  FILE_TTL_HOURS: int('FILE_TTL_HOURS', 24),
  MIN_FREE_DISK_MB: int('MIN_FREE_DISK_MB', 500),
  CANVAS_WIDTH: 1920,
  CANVAS_HEIGHT: 1080,
  PROJECT_ROOT: path.resolve(__dirname, '..'),
  UPLOADS_DIR: path.resolve(__dirname, '..', 'uploads'),
  VIDEOS_DIR: path.resolve(__dirname, '..', 'videos')
};
