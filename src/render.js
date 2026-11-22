const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { toKinoSchema } = require('./adapter');

const KINO_CLI = path.join(config.PROJECT_ROOT, 'node_modules', '@glitchoff', 'kino', 'dist', 'cli.js');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let activeRenders = 0;

function acquireSlot() {
  if (activeRenders >= config.MAX_CONCURRENT_RENDERS) return false;
  activeRenders += 1;
  return true;
}

function releaseSlot() {
  activeRenders = Math.max(0, activeRenders - 1);
}

function runKino(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [KINO_CLI, ...args], {
      cwd: config.PROJECT_ROOT,
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error('Kino command failed.');
        failure.code = error.killed ? 'RENDER_TIMEOUT' : 'RENDER_FAILED';
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function checkKinoAvailable() {
  if (!fs.existsSync(KINO_CLI)) return false;
  try {
    await runKino(['--help'], 15000);
    return true;
  } catch {
    return false;
  }
}

async function writeKinoJson(jobId, canonicalData, audioPath) {
  if (!UUID_REGEX.test(jobId)) throw new Error('Invalid job ID.');
  const jsonPath = path.join(config.VIDEOS_DIR, `${jobId}.json`);
  const temporaryPath = `${jsonPath}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(toKinoSchema(canonicalData, audioPath), null, 2), 'utf8');
  await fs.promises.rename(temporaryPath, jsonPath);
  return jsonPath;
}

async function render(jobId, canonicalData, audioPath) {
  if (!UUID_REGEX.test(jobId)) throw new Error('Invalid job ID.');
  if (!acquireSlot()) {
    const error = new Error('Server is busy rendering another video.');
    error.code = 'BUSY';
    throw error;
  }
  const jsonPath = path.join(config.VIDEOS_DIR, `${jobId}.json`);
  const mp4Path = path.join(config.VIDEOS_DIR, `${jobId}.mp4`);
  try {
    await writeKinoJson(jobId, canonicalData, audioPath);
    if (!fs.existsSync(KINO_CLI)) {
      const error = new Error('Kino CLI was not found.');
      error.code = 'RENDER_UNAVAILABLE';
      throw error;
    }
    const result = await runKino([jsonPath, '-o', mp4Path], config.RENDER_TIMEOUT_MS);
    const stats = await fs.promises.stat(mp4Path);
    if (!stats.isFile() || stats.size < 10240) {
      const error = new Error('Kino did not produce a valid MP4 file.');
      error.code = 'RENDER_FAILED';
      throw error;
    }
    return { jsonPath, mp4Path, size: stats.size, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    await fs.promises.unlink(mp4Path).catch(() => {});
    throw error;
  } finally {
    releaseSlot();
  }
}

module.exports = { render, checkKinoAvailable, acquireSlot, releaseSlot };
