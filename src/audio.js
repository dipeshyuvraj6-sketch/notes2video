const fs = require('fs');
const path = require('path');
const config = require('./config');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

function getWavDuration(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Gemini returned audio that is not a WAV file.');
  }

  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunkName = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > wav.length) throw new Error('Gemini returned a truncated WAV file.');
    if (chunkName === 'fmt ' && chunkSize >= 16) byteRate = wav.readUInt32LE(chunkStart + 8);
    if (chunkName === 'data') dataSize = chunkSize;
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) throw new Error('Gemini returned a WAV file without audio data.');
  return dataSize / byteRate;
}

function readAudioData(result) {
  if (result.output_audio && typeof result.output_audio.data === 'string') {
    return result.output_audio.data;
  }
  const steps = Array.isArray(result.steps) ? result.steps.slice().reverse() : [];
  for (const step of steps) {
    const content = Array.isArray(step.content) ? step.content.slice().reverse() : [];
    const audio = content.find((part) => part.type === 'audio' && typeof part.data === 'string');
    if (audio) return audio.data;
  }
  return null;
}

function getMaxNarrationDuration(sceneCount) {
  if (!Number.isInteger(sceneCount) || sceneCount < 1) return 0;
  const maxSceneDuration = Math.min(config.MAX_SCENE_SEC, Math.floor(config.MAX_VIDEO_SECONDS / sceneCount));
  if (maxSceneDuration < config.MIN_SCENE_SEC) return 0;
  return sceneCount * maxSceneDuration;
}

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function getTargetNarrationWordCount(sceneNarrations, audioDurationSeconds, maxDurationSeconds) {
  const currentWordCount = sceneNarrations.reduce((total, text) => total + countWords(text), 0);
  const targetDurationSeconds = Math.max(1, maxDurationSeconds - 1);
  return Math.max(
    sceneNarrations.length,
    Math.floor(currentWordCount * targetDurationSeconds / audioDurationSeconds)
  );
}

async function generateNarration(text, jobId) {
  if (!UUID_REGEX.test(jobId)) throw new Error('Invalid job ID.');
  if (!config.GEMINI_API_KEY) {
    const error = new Error('Gemini API key is not configured.');
    error.userCode = 'TTS_UNAVAILABLE';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.GEMINI_TIMEOUT_MS);
  let response;
  let result;
  try {
    response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.GEMINI_API_KEY
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.GEMINI_TTS_MODEL,
        input: [{
          type: 'user_input',
          content: [{
            type: 'text',
            text,
            annotations: [{
              type: 'speech_metadata',
              style: 'Clear, friendly educational narration at a measured pace.'
            }]
          }]
        }],
        response_format: { type: 'audio', mime_type: 'audio/wav' },
        generation_config: { speech_config: [{ voice: config.GEMINI_TTS_VOICE }] }
      })
    });
    result = await response.json();
  } catch (cause) {
    const error = new Error(cause.name === 'AbortError' ? 'Gemini narration timed out.' : 'Gemini narration request failed.');
    error.userCode = cause.name === 'AbortError' ? 'TTS_TIMEOUT' : 'TTS_UNAVAILABLE';
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = new Error(`Gemini narration request failed with status ${response.status}.`);
    error.userCode = 'TTS_UNAVAILABLE';
    error.status = response.status;
    throw error;
  }

  const encoded = readAudioData(result);
  if (!encoded) {
    const error = new Error('Gemini did not return narration audio.');
    error.userCode = 'TTS_INVALID_AUDIO';
    throw error;
  }

  let wav;
  let durationSeconds;
  try {
    wav = Buffer.from(encoded, 'base64');
    durationSeconds = getWavDuration(wav);
  } catch {
    const error = new Error('Gemini returned invalid narration audio.');
    error.userCode = 'TTS_INVALID_AUDIO';
    throw error;
  }

  const audioPath = path.join(config.VIDEOS_DIR, `${jobId}.wav`);
  try {
    await fs.promises.writeFile(audioPath, wav, { flag: 'wx' });
  } catch (cause) {
    cause.userCode = 'TTS_STORAGE_ERROR';
    throw cause;
  }
  return { audioPath, durationSeconds, size: wav.length };
}

function narrationTooLongError(audioDurationSeconds, maxDurationSeconds, shortenRetries, sceneCount) {
  const error = new Error('The narration is too long to synchronize with the generated scenes.');
  error.userCode = 'NARRATION_TOO_LONG';
  error.audioDurationSeconds = audioDurationSeconds;
  error.maxDurationSeconds = maxDurationSeconds;
  error.shortenRetries = shortenRetries;
  error.sceneCount = sceneCount;
  return error;
}

function alignScenesToNarration(canonical, audioDuration, sceneNarrations) {
  const scenes = canonical.scenes;
  const minDuration = config.MIN_SCENE_SEC;
  const maxDuration = Math.min(config.MAX_SCENE_SEC, Math.floor(config.MAX_VIDEO_SECONDS / scenes.length));
  const maxTotalDuration = getMaxNarrationDuration(scenes.length);
  const targetDuration = Math.max(scenes.length * minDuration, Math.ceil(audioDuration + 0.5));
  if (maxDuration < minDuration || targetDuration > maxTotalDuration) {
    throw narrationTooLongError(audioDuration, maxTotalDuration, 0, scenes.length);
  }

  const wordCounts = scenes.map((scene, index) => {
    const narration = sceneNarrations
      ? sceneNarrations[index]
      : scene.elements.map((element) => element.text).join(' ');
    return Math.max(1, countWords(narration.trim()));
  });
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  const targetShares = wordCounts.map((count) => targetDuration * count / totalWords);
  const durations = targetShares.map((share) => Math.min(maxDuration, Math.max(minDuration, Math.floor(share))));
  let currentTotal = durations.reduce((sum, duration) => sum + duration, 0);

  while (currentTotal < targetDuration) {
    let bestIndex = -1;
    for (let i = 0; i < durations.length; i += 1) {
      if (durations[i] < maxDuration &&
          (bestIndex === -1 || targetShares[i] - durations[i] > targetShares[bestIndex] - durations[bestIndex])) {
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    durations[bestIndex] += 1;
    currentTotal += 1;
  }

  while (currentTotal > targetDuration) {
    let bestIndex = -1;
    for (let i = 0; i < durations.length; i += 1) {
      if (durations[i] > minDuration &&
          (bestIndex === -1 || durations[i] - targetShares[i] > durations[bestIndex] - targetShares[bestIndex])) {
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    durations[bestIndex] -= 1;
    currentTotal -= 1;
  }

  scenes.forEach((scene, index) => {
    scene.duration = durations[index];
  });
  return currentTotal;
}

async function generateNarrationWithRetries(
  canonical,
  sourceText,
  initialSceneNarrations,
  jobId,
  shortenNarration,
  maxRetries = 2
) {
  let sceneNarrations = initialSceneNarrations;
  let audioPath = null;
  let shortenRetries = 0;
  let lastAudioDurationSeconds = null;
  const audioDurationsSeconds = [];
  const sceneCount = canonical.scenes.length;
  const maxDurationSeconds = getMaxNarrationDuration(sceneCount);

  try {
    while (true) {
      const narration = await generateNarration(sceneNarrations.join('\n'), jobId);
      audioPath = narration.audioPath;
      lastAudioDurationSeconds = narration.durationSeconds;
      audioDurationsSeconds.push(narration.durationSeconds);

      if (Math.ceil(narration.durationSeconds + 0.5) <= maxDurationSeconds) {
        return {
          ...narration,
          sceneNarrations,
          totalDuration: alignScenesToNarration(canonical, narration.durationSeconds, sceneNarrations),
          maxDurationSeconds,
          shortenRetries,
          audioDurationsSeconds
        };
      }

      if (shortenRetries >= maxRetries) {
        throw narrationTooLongError(
          narration.durationSeconds,
          maxDurationSeconds,
          shortenRetries,
          sceneCount
        );
      }

      if (typeof shortenNarration !== 'function') {
        const error = new Error('A narration-shortening service is required for overlong audio.');
        error.userCode = 'NARRATION_REWRITE_FAILED';
        throw error;
      }

      const targetWordCount = getTargetNarrationWordCount(
        sceneNarrations,
        narration.durationSeconds,
        maxDurationSeconds
      );
      const shortened = await shortenNarration(sourceText, sceneNarrations, targetWordCount);
      const currentWordCount = sceneNarrations.reduce((total, text) => total + countWords(text), 0);
      const shortenedWordCount = Array.isArray(shortened)
        ? shortened.reduce((total, text) => total + (typeof text === 'string' ? countWords(text) : 0), 0)
        : 0;
      if (!Array.isArray(shortened) ||
          shortened.length !== sceneCount ||
          shortened.some((text) => typeof text !== 'string' || !text.trim()) ||
          shortenedWordCount >= currentWordCount ||
          shortenedWordCount > targetWordCount) {
        const error = new Error('Gemini did not return a shorter narration that matches the scenes.');
        error.userCode = 'NARRATION_REWRITE_FAILED';
        throw error;
      }

      await fs.promises.unlink(audioPath);
      audioPath = null;
      sceneNarrations = shortened;
      shortenRetries += 1;
    }
  } catch (error) {
    if (audioPath) error.audioPath = audioPath;
    if (!Number.isFinite(error.audioDurationSeconds) && Number.isFinite(lastAudioDurationSeconds)) {
      error.audioDurationSeconds = lastAudioDurationSeconds;
    }
    if (!Number.isFinite(error.maxDurationSeconds)) error.maxDurationSeconds = maxDurationSeconds;
    if (!Number.isFinite(error.shortenRetries)) error.shortenRetries = shortenRetries;
    if (!Number.isFinite(error.sceneCount)) error.sceneCount = sceneCount;
    error.audioDurationsSeconds = audioDurationsSeconds;
    throw error;
  }
}

module.exports = {
  generateNarration,
  generateNarrationWithRetries,
  getWavDuration,
  getMaxNarrationDuration,
  getTargetNarrationWordCount,
  alignScenesToNarration
};
