(() => {
  const MAX_UPLOAD_MB = 10;
  const CLIENT_TIMEOUT_MS = 10 * 60 * 1000;
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const generateBtn = document.getElementById('generateBtn');
  const statusEl = document.getElementById('status');
  const videoContainer = document.getElementById('videoContainer');
  const videoPlayer = document.getElementById('videoPlayer');
  const downloadLink = document.getElementById('downloadLink');
  const btnText = generateBtn.querySelector('.btn-text');
  const btnSpinner = generateBtn.querySelector('.btn-spinner');
  let selectedFile = null;
  let timer = null;
  let controller = null;

  function showStatus(message, type, elapsed = false) {
    statusEl.replaceChildren();
    statusEl.className = `status ${type}`;
    statusEl.append(document.createTextNode(message));
    if (elapsed) {
      const span = document.createElement('span');
      span.className = 'elapsed';
      span.id = 'elapsedTime';
      span.textContent = 'Elapsed: 0:00';
      statusEl.append(span);
    }
    statusEl.classList.remove('hidden');
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function chooseFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf')) {
      showStatus('Please select a PDF file.', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      showStatus(`File exceeds ${MAX_UPLOAD_MB} MB.`, 'error');
      return;
    }
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.classList.remove('hidden');
    statusEl.classList.add('hidden');
    generateBtn.disabled = false;
    videoContainer.classList.add('hidden');
  }

  function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.add('hidden');
    generateBtn.disabled = true;
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    chooseFile(event.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
  document.getElementById('removeFile').addEventListener('click', clearFile);
  document.getElementById('resetBtn').addEventListener('click', () => {
    clearFile();
    stopTimer();
    statusEl.classList.add('hidden');
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    videoContainer.classList.add('hidden');
  });

  generateBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    generateBtn.disabled = true;
    btnText.textContent = 'Generating...';
    btnSpinner.classList.remove('hidden');
    videoContainer.classList.add('hidden');
    showStatus('Generating your video. This can take a few minutes.', 'loading', true);
    const startedAt = Date.now();
    timer = setInterval(() => {
      const elapsed = document.getElementById('elapsedTime');
      if (elapsed) {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = `Elapsed: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }
    }, 1000);
    controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const formData = new FormData();
      formData.append('pdf', selectedFile);
      const response = await fetch('/api/generate', { method: 'POST', body: formData, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Video generation failed.');
      videoPlayer.src = result.videoUrl;
      downloadLink.href = result.videoUrl;
      videoContainer.classList.remove('hidden');
      showStatus(
        result.truncated ? 'Video ready. The source notes were shortened to fit the input limit.' : 'Your video is ready.',
        result.truncated ? 'warning' : 'success'
      );
    } catch (error) {
      showStatus(error.name === 'AbortError' ? 'The request timed out. Please try again.' : error.message, 'error');
    } finally {
      clearTimeout(timeoutId);
      stopTimer();
      controller = null;
      btnText.textContent = 'Generate Video';
      btnSpinner.classList.add('hidden');
      generateBtn.disabled = !selectedFile;
    }
  });
})();
