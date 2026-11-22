const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const {
  generateNarration,
  generateNarrationWithRetries,
  getWavDuration,
  getMaxNarrationDuration,
  getTargetNarrationWordCount,
  alignScenesToNarration
} = require('../src/audio');

function createWav(durationSeconds) {
  const sampleRate = 24000;
  const dataSize = sampleRate * 2 * durationSeconds;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function sampleComposition(sceneCount = 3) {
  return {
    meta: { title: 'Narration', width: 1920, height: 1080, fps: 30 },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      id: `s${index + 1}`,
      duration: 5,
      background: '#101010',
      elements: [{ text: `Scene ${index + 1} explains the key idea.` }]
    }))
  };
}

test('reads WAV duration and aligns scene timing to narration', () => {
  assert.equal(getWavDuration(createWav(2)), 2);
  const composition = sampleComposition();
  const total = alignScenesToNarration(composition, 18.2);
  assert.equal(total, 19);
  assert.equal(composition.scenes.reduce((sum, scene) => sum + scene.duration, 0), 19);
  assert.ok(composition.scenes.every((scene) => scene.duration >= config.MIN_SCENE_SEC));
});

test('rejects narration that cannot fit scene duration limits', () => {
  assert.throws(
    () => alignScenesToNarration(sampleComposition(), 40),
    (error) => error.userCode === 'NARRATION_TOO_LONG' &&
      error.audioDurationSeconds === 40 &&
      error.maxDurationSeconds === 36
  );
});

test('calculates the available narration limit and a measured-length word budget', () => {
  const sceneNarrations = ['One two three four five six', 'Seven eight nine ten eleven twelve'];
  assert.equal(getMaxNarrationDuration(7), 84);
  assert.equal(getTargetNarrationWordCount(sceneNarrations, 100, 84), 9);
});

test('shortens overlong narration, measures the retry, and aligns the scenes', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  const jobId = randomUUID();
  const durations = [100, 79];
  const sceneNarrations = Array.from({ length: 7 }, (_, index) => `Scene ${index + 1} explains the key idea.`);
  const shorterNarration = Array.from({ length: 7 }, (_, index) => `Idea ${index + 1}.`);
  const audioPath = path.join(config.VIDEOS_DIR, `${jobId}.wav`);
  let fetchCount = 0;
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => {
    const wav = createWav(durations[fetchCount]);
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_audio: { data: wav.toString('base64') } })
    };
  };
  try {
    const result = await generateNarrationWithRetries(
      sampleComposition(7),
      'Authoritative source notes.',
      sceneNarrations,
      jobId,
      async (source, current, targetWords) => {
        assert.equal(source, 'Authoritative source notes.');
        assert.deepEqual(current, sceneNarrations);
        assert.ok(targetWords < current.join(' ').split(/\s+/).length);
        return shorterNarration;
      }
    );
    assert.equal(fetchCount, 2);
    assert.equal(result.durationSeconds, 79);
    assert.equal(result.maxDurationSeconds, 84);
    assert.equal(result.shortenRetries, 1);
    assert.deepEqual(result.audioDurationsSeconds, [100, 79]);
    assert.deepEqual(result.sceneNarrations, shorterNarration);
    assert.equal(result.totalDuration, 80);
    assert.equal(fs.existsSync(audioPath), true);
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.promises.unlink(audioPath).catch(() => {});
  }
});

test('reports measured audio length and preserves the failed WAV path for cleanup', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  const jobId = randomUUID();
  const audioPath = path.join(config.VIDEOS_DIR, `${jobId}.wav`);
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => {
    const wav = createWav(100);
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_audio: { data: wav.toString('base64') } })
    };
  };
  try {
    await assert.rejects(
      generateNarrationWithRetries(
        sampleComposition(7),
        'Authoritative source notes.',
        Array.from({ length: 7 }, (_, index) => `Scene ${index + 1} explains the key idea.`),
        jobId,
        async () => Array.from({ length: 7 }, (_, index) => `Idea ${index + 1}.`),
        0
      ),
      (error) => error.userCode === 'NARRATION_TOO_LONG' &&
        error.audioDurationSeconds === 100 &&
        error.maxDurationSeconds === 84 &&
        error.shortenRetries === 0 &&
        error.audioDurationsSeconds.length === 1 &&
        error.audioPath === audioPath
    );
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.promises.unlink(audioPath).catch(() => {});
  }
});

test('requests WAV narration from Gemini and stores the returned audio', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  const jobId = randomUUID();
  const wav = createWav(1);
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.GEMINI_TTS_MODEL);
    assert.equal(body.response_format.mime_type, 'audio/wav');
    assert.equal(body.generation_config.speech_config[0].voice, config.GEMINI_TTS_VOICE);
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_audio: { data: wav.toString('base64') } })
    };
  };
  const audioPath = path.join(config.VIDEOS_DIR, `${jobId}.wav`);
  try {
    const result = await generateNarration('A short test narration.', jobId);
    assert.equal(result.audioPath, audioPath);
    assert.equal(result.durationSeconds, 1);
    assert.deepEqual(await fs.promises.readFile(audioPath), wav);
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
    await fs.promises.unlink(audioPath).catch(() => {});
  }
});
