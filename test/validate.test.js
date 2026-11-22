const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAndNormalize, validateSourceGrounding, parseJSON } = require('../src/validate');
const { toKinoSchema } = require('../src/adapter');
const config = require('../src/config');
const { generateScenes, generateConciseNarration } = require('../src/llm');
const { buildRetryPrompt, buildUserPrompt } = require('../src/prompt');

function sample() {
  return {
    meta: { title: 'Test notes', width: 1920, height: 1080, fps: 30 },
    scenes: [0, 1, 2].map((index) => ({
      id: `s${index + 1}`,
      role: index === 0 ? 'intro' : index === 2 ? 'summary' : 'explanation',
      duration: 5,
      background: '#101010',
      transition: 'fade',
      elements: [{
        type: 'text', style: 'body', text: `Scene ${index + 1}`, x: 960, y: 200,
        fontSize: 44, color: '#ffffff', align: 'center', bold: false, appearAt: 0
      }]
    }))
  };
}

test('parses JSON in optional markdown fences', () => {
  assert.deepEqual(parseJSON('```json\n{"ok":true}\n```'), { ok: true });
});

test('normalizes bounded scene data and adapts it to Kino text elements', () => {
  const result = validateAndNormalize(sample());
  assert.equal(result.ok, true);
  assert.equal(result.sceneCount, 3);
  const kino = toKinoSchema(result.data);
  assert.equal(kino.width, 1920);
  assert.equal(kino.scenes[0].elements[0].content, 'Scene 1');
  assert.equal(kino.scenes[0].elements[0].fontColor, '#ffffff');
  assert.equal(kino.scenes[0].transition, undefined);
  assert.equal(kino.scenes[1].transition.type, 'fade');
  const withNarration = toKinoSchema(result.data, 'C:\\temp\\narration.wav');
  assert.equal(withNarration.audio.src, 'C:\\temp\\narration.wav');
});

test('rejects too few scenes and caps total video duration', () => {
  const tooFew = sample();
  tooFew.scenes.pop();
  assert.equal(validateAndNormalize(tooFew).ok, false);

  const long = sample();
  long.scenes = Array.from({ length: 60 }, (_, index) => ({
    ...sample().scenes[index % 3],
    id: `s${index + 1}`,
    duration: 12
  }));
  const result = validateAndNormalize(long);
  assert.equal(result.ok, true);
  assert.ok(result.totalDuration <= 300);
  assert.ok(result.sceneCount <= 75);
});

test('keeps the PDF source in first and retry prompts', () => {
  const notes = 'Note-making organizes lecture notes into key ideas for later review.';
  assert.match(buildUserPrompt(notes, 30, 300), /authoritative/);
  assert.match(buildRetryPrompt(notes, ['wrong subject'], '{}'), /Note-making organizes lecture notes/);
});

test('creates concise narration segments grounded in the PDF and scene order', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.systemInstruction.parts[0].text, /voiceover editor/);
    assert.match(body.contents[0].parts[0].text, /Authoritative PDF source/);
    assert.match(body.contents[0].parts[0].text, /no more than 6 words/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ segments: ['Keep key ideas.', 'Review them.'] }) }] },
          finishReason: 'STOP'
        }]
      })
    };
  };
  try {
    const segments = await generateConciseNarration(
      'Note-making keeps useful ideas for later review.',
      ['This scene introduces the note-making idea.', 'This scene explains reviewing notes.'],
      6
    );
    assert.deepEqual(segments, ['Keep key ideas.', 'Review them.']);
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
  }
});

test('rejects narration rewrites that exceed the measured word budget', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ segments: ['These four words exceed.', 'Also too long.'] }) }] },
        finishReason: 'STOP'
      }]
    })
  });
  try {
    await assert.rejects(
      generateConciseNarration('Source notes.', ['First segment with words.', 'Second segment with words.'], 4),
      (error) => error.userCode === 'NARRATION_REWRITE_FAILED'
    );
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
  }
});

test('rejects a valid but unrelated script and accepts note-making scenes', () => {
  const source = 'Note-making organizes lecture notes into key ideas for later review.';
  const unrelated = sample();
  unrelated.meta.title = 'Understanding Photosynthesis';
  unrelated.scenes.forEach((scene) => {
    scene.elements[0].text = 'Plants use sunlight to create glucose and oxygen.';
  });
  assert.equal(validateSourceGrounding(source, unrelated).ok, false);

  const grounded = sample();
  grounded.meta.title = 'Note-Making';
  grounded.scenes.forEach((scene) => {
    scene.elements[0].text = 'Note-making organizes lecture notes for review.';
  });
  assert.equal(validateSourceGrounding(source, grounded).ok, true);
});

test('retries unrelated Gemini output with the source PDF text', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  const unrelated = sample();
  unrelated.meta.title = 'Understanding Photosynthesis';
  unrelated.scenes.forEach((scene) => {
    scene.elements[0].text = 'Plants use sunlight to create glucose and oxygen.';
  });
  let callCount = 0;
  const prompts = [];
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    callCount += 1;
    prompts.push(JSON.parse(options.body).contents[0].parts[0].text);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(unrelated) }] }, finishReason: 'STOP' }]
      })
    };
  };
  try {
    await assert.rejects(
      generateScenes('Note-making organizes lecture notes into key ideas for later review.'),
      (error) => error.userCode === 'SOURCE_MISMATCH'
    );
    assert.equal(callCount, 3);
    assert.match(prompts[1], /Note-making organizes lecture notes/);
    assert.match(prompts[1], /does not match the source topic/i);
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
  }
});

test('reports a missing Gemini key as an unavailable service', async () => {
  const originalKey = config.GEMINI_API_KEY;
  config.GEMINI_API_KEY = '';
  try {
    await assert.rejects(generateScenes('test notes'), (error) => error.userCode === 'LLM_UNAVAILABLE');
  } finally {
    config.GEMINI_API_KEY = originalKey;
  }
});

test('reports Gemini API model errors as service unavailable', async () => {
  const originalKey = config.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  config.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: { message: 'model not found' } })
  });
  try {
    await assert.rejects(
      generateScenes('test notes'),
      (error) => error.userCode === 'LLM_UNAVAILABLE' && error.status === 404
    );
  } finally {
    config.GEMINI_API_KEY = originalKey;
    global.fetch = originalFetch;
  }
});
