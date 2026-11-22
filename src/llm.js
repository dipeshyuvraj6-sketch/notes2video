const config = require('./config');
const { SYSTEM_PROMPT, buildUserPrompt, buildRetryPrompt, computeTargetSeconds } = require('./prompt');
const { validateAndNormalize, validateSourceGrounding, stripCodeFences } = require('./validate');

const NARRATION_SYSTEM_PROMPT = `You are a concise educational voiceover editor. Preserve the facts and important concepts in the authoritative source. Keep each narration segment aligned with its corresponding scene. Do not add a greeting, outro, headings, or facts not supported by the source. Return only valid JSON in this shape: {"segments":["short spoken segment for scene 1"]}.`;

async function callGemini(prompt, systemPrompt = SYSTEM_PROMPT) {
  if (!config.GEMINI_API_KEY) {
    const error = new Error('Gemini API key is not configured.');
    error.code = 'LLM_UNAVAILABLE';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.GEMINI_TIMEOUT_MS);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(config.GEMINI_API_KEY)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 8192 }
      })
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(`Gemini request failed with status ${response.status}.`);
      error.code = 'LLM_UNAVAILABLE';
      error.status = response.status;
      throw error;
    }
    if (result.promptFeedback && result.promptFeedback.blockReason) {
      const error = new Error('Gemini blocked this content.');
      error.code = 'CONTENT_BLOCKED';
      throw error;
    }
    const candidate = result.candidates && result.candidates[0];
    if (candidate && candidate.finishReason === 'SAFETY') {
      const error = new Error('Gemini blocked this content.');
      error.code = 'CONTENT_BLOCKED';
      throw error;
    }
    if (candidate && candidate.finishReason === 'MAX_TOKENS') {
      const error = new Error('Gemini output exceeded its token limit.');
      error.code = 'MAX_TOKENS';
      throw error;
    }
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((part) => part.text || '').join('')
      : '';
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Gemini request timed out.');
      timeoutError.code = 'LLM_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateConciseNarration(sourceText, sceneNarrations, targetWordCount) {
  const prompt = [
    `Shorten the narration to no more than ${targetWordCount} words total.`,
    `Return exactly ${sceneNarrations.length} non-empty segments in the same scene order.`,
    'Keep the main teaching point of each scene, remove repetition and unnecessary phrasing, and use natural spoken language.',
    `Authoritative PDF source: ${JSON.stringify(sourceText)}`,
    `Current narration segments: ${JSON.stringify(sceneNarrations)}`
  ].join('\n\n');

  let raw;
  try {
    raw = await callGemini(prompt, NARRATION_SYSTEM_PROMPT);
  } catch (cause) {
    const error = new Error('Gemini could not shorten the narration.');
    error.userCode = 'NARRATION_REWRITE_FAILED';
    error.status = cause.status;
    throw error;
  }

  let result;
  try {
    result = JSON.parse(stripCodeFences(raw));
  } catch {
    const error = new Error('Gemini returned invalid shortened narration.');
    error.userCode = 'NARRATION_REWRITE_FAILED';
    throw error;
  }

  if (!result || !Array.isArray(result.segments) || result.segments.length !== sceneNarrations.length) {
    const error = new Error('Gemini returned narration segments that do not match the scenes.');
    error.userCode = 'NARRATION_REWRITE_FAILED';
    throw error;
  }

  const segments = result.segments.map((segment) => typeof segment === 'string' ? segment.trim() : '');
  const wordCount = segments.reduce((total, segment) => total + (segment.match(/\S+/g) || []).length, 0);
  const currentWordCount = sceneNarrations.reduce((total, segment) => total + (segment.match(/\S+/g) || []).length, 0);
  if (segments.some((segment) => !segment) || wordCount > targetWordCount || wordCount >= currentWordCount) {
    const error = new Error('Gemini returned narration that did not meet the shorter word budget.');
    error.userCode = 'NARRATION_REWRITE_FAILED';
    throw error;
  }
  return segments;
}

async function generateScenes(text) {
  if (!config.GEMINI_API_KEY) {
    const error = new Error('Gemini API key is not configured.');
    error.userCode = 'LLM_UNAVAILABLE';
    throw error;
  }
  const targetSeconds = computeTargetSeconds(text);
  let previous = '';
  let errors = [];
  let finalErrorCode = 'LLM_INVALID_OUTPUT';
  for (let attempt = 0; attempt <= config.LLM_MAX_RETRIES; attempt += 1) {
    const prompt = attempt === 0
      ? buildUserPrompt(text, targetSeconds, config.MAX_VIDEO_SECONDS)
      : buildRetryPrompt(text, errors, previous);
    try {
      previous = await callGemini(prompt);
    } catch (error) {
      if (error.code === 'CONTENT_BLOCKED') {
        error.userCode = 'CONTENT_BLOCKED';
        throw error;
      }
      if (error.code === 'LLM_UNAVAILABLE') {
        errors = [error.message];
        if ([400, 401, 403, 404].includes(error.status) || attempt === config.LLM_MAX_RETRIES) {
          error.userCode = 'LLM_UNAVAILABLE';
          throw error;
        }
        continue;
      }
      if (error.code === 'LLM_TIMEOUT' && attempt === config.LLM_MAX_RETRIES) {
        error.userCode = 'LLM_TIMEOUT';
        throw error;
      }
      if (error.code === 'LLM_INVALID_OUTPUT' && attempt === config.LLM_MAX_RETRIES) {
        error.userCode = 'LLM_INVALID_OUTPUT';
        throw error;
      }
      errors = [error.message];
      continue;
    }
    const validation = validateAndNormalize(previous);
    if (validation.ok) {
      const grounding = validateSourceGrounding(text, validation.data);
      if (grounding.ok) return { ...validation, targetSeconds, attempt };
      errors = grounding.errors;
      finalErrorCode = 'SOURCE_MISMATCH';
    } else {
      errors = validation.errors;
      finalErrorCode = 'LLM_INVALID_OUTPUT';
    }
    previous = stripCodeFences(previous);
  }
  const error = new Error('Gemini output could not be validated against the source after retries.');
  error.userCode = finalErrorCode;
  error.errors = errors;
  throw error;
}

module.exports = { generateScenes, generateConciseNarration };
