const historyContainer = document.getElementById('history-container');
const currentLineSpan = document.getElementById('current-line');
const hiddenInput = document.getElementById('hidden-input');
const terminalContainer = document.getElementById('terminal-container');

let currentLineBuffer = '';
let pendingCR = false;
let inCsiSequence = false;
let isComposing = false;
let renderScheduled = false;
let tuiBlocked = false;
let tuiNoticeShown = false;
const MAX_HISTORY_LINES = 1200;
const TRIM_BATCH_SIZE = 120;

const ALT_SCREEN_ENTER = /\x1b\[\?(?:47|1047|1048|1049)h/;
const ALT_SCREEN_EXIT = /\x1b\[\?(?:47|1047|1048|1049)l/;

function requestRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    currentLineSpan.innerHTML = window.terminalAPI.ansiToHtml(currentLineBuffer);
    renderScheduled = false;
  });
}

function safeBackspace(text) {
  if (text.length === 0) return '';
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = ansiRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'ansi', content: match[0] });
    lastIndex = ansiRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].type === 'text' && segments[i].content.length > 0) {
      segments[i].content = segments[i].content.slice(0, -1);
      break;
    }
  }

  return segments.map((s) => s.content).join('');
}

function scrollToBottom() {
  if (!terminalContainer) return;
  requestAnimationFrame(() => {
    terminalContainer.scrollTop = terminalContainer.scrollHeight;
  });
}

function isNearBottom() {
  if (!terminalContainer) return true;
  const threshold = 32;
  return terminalContainer.scrollHeight - terminalContainer.scrollTop - terminalContainer.clientHeight <= threshold;
}

function performClear() {
  historyContainer.innerHTML = '';
  currentLineBuffer = '';
  currentLineSpan.innerHTML = '';
  pendingCR = false;
  if (terminalContainer) terminalContainer.scrollTop = 0;
}

function appendSystemNotice(message) {
  const notice = document.createElement('div');
  notice.className = 'history-line';
  notice.textContent = message;
  historyContainer.appendChild(notice);
  trimHistoryIfNeeded();
  if (isNearBottom()) scrollToBottom();
}

function trimHistoryIfNeeded() {
  if (historyContainer.children.length <= MAX_HISTORY_LINES) return;
  let removeCount = Math.min(
    TRIM_BATCH_SIZE,
    historyContainer.children.length - MAX_HISTORY_LINES
  );
  while (removeCount > 0 && historyContainer.firstChild) {
    historyContainer.removeChild(historyContainer.firstChild);
    removeCount -= 1;
  }
}

async function copySelectionToClipboard() {
  const selectedText = window.getSelection ? window.getSelection().toString() : '';
  if (!selectedText) return false;
  try {
    await navigator.clipboard.writeText(selectedText);
    return true;
  } catch (_error) {
    return false;
  }
}

function selectAllTerminalText() {
  if (!terminalContainer) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(terminalContainer);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function pasteToTerminal() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      window.terminalAPI.sendKeystroke(text);
    }
  } catch (_error) {
    // Ignore clipboard permission errors to avoid breaking input flow.
  }
}

async function executeAppCommand(command) {
  if (command === 'new-window') {
    window.terminalAPI.requestNewWindow();
    return true;
  }
  if (command === 'copy') {
    await copySelectionToClipboard();
    return true;
  }
  if (command === 'paste') {
    await pasteToTerminal();
    return true;
  }
  if (command === 'select-all') {
    selectAllTerminalText();
    return true;
  }
  return false;
}

function getWindowSize() {
  const computedStyle = getComputedStyle(document.documentElement);
  const fontSize = parseFloat(computedStyle.getPropertyValue('--font-size').trim());
  const lineHeight = parseFloat(computedStyle.getPropertyValue('--line-height').trim());

  if (Number.isNaN(fontSize) || fontSize <= 0 || Number.isNaN(lineHeight) || lineHeight <= 0) return;

  const cols = Math.max(20, Math.floor((window.innerWidth - 40) / (fontSize * 0.55)));
  const rows = Math.max(10, Math.floor((window.innerHeight - 30) / (fontSize * lineHeight)));

  window.terminalAPI.resizeTerminal({ cols, rows });
}

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    getWindowSize();
  }, 100);
});

if (terminalContainer) {
  terminalContainer.addEventListener('click', () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) {
      hiddenInput.focus();
    }
  });
}
window.addEventListener('focus', () => hiddenInput.focus());

window.terminalAPI.onApplySettings((settings) => {
  const root = document.documentElement;
  root.style.setProperty('--font-family', settings.fontFamily);
  root.style.setProperty('--font-size', settings.fontSize);
  root.style.setProperty('--line-height', settings.lineHeight);
  root.style.setProperty('--cursor-width', settings.cursorWidth);
  root.style.setProperty('--cursor-height', settings.cursorHeight);
  root.style.setProperty('--cursor-translateY', settings.cursorTranslateY);
  root.style.setProperty('--text-color', settings.textColor);
  document.body.style.backgroundColor = settings.backgroundColor;

  if (settings.backgroundImage && settings.backgroundImage.trim() !== '') {
    root.style.setProperty('--bg-image', `url("${settings.backgroundImage}")`);

    const dpr = window.devicePixelRatio || 1;
    const img = new Image();
    img.onload = function onload() {
      const cssWidth = img.width / dpr;
      const cssHeight = img.height / dpr;
      root.style.setProperty('--bg-size', `${cssWidth}px ${cssHeight}px`);
    };
    img.src = settings.backgroundImage;
  } else {
    root.style.setProperty('--bg-image', 'none');
    root.style.setProperty('--bg-size', 'auto auto');
  }

  requestAnimationFrame(() => {
    getWindowSize();
  });
});

function preprocessData(data) {
  data = data.replace(/\x1b\][\s\S]*?\x07/g, '');
  data = data.replace(/\x1b\[\?2004[hl]/g, '');
  data = data.replace(/\x07/g, '');
  data = data.replace(/\x08[\x20 ]+\x08/g, '\x08');
  data = data.replace(/\x7f/g, '\x08');

  if (data.includes('\x1b[2J') || data.includes('\x1b[3J')) {
    performClear();
    data = data.replace(/\x1b\[[23]J/g, '');
  }

  return data;
}

window.terminalAPI.onTerminalIncoming((rawData) => {
  const shouldStickToBottom = isNearBottom();
  if (ALT_SCREEN_ENTER.test(rawData)) {
    tuiBlocked = true;
    if (!tuiNoticeShown) {
      appendSystemNotice('[S-term] Full-screen TUI (vim/ssh-vim/less/top) is temporarily unsupported.');
      appendSystemNotice('[S-term] Please use a regular terminal for vim. Press Ctrl+C to exit current mode.');
      tuiNoticeShown = true;
    }
  }

  if (ALT_SCREEN_EXIT.test(rawData)) {
    tuiBlocked = false;
    tuiNoticeShown = false;
  }

  const data = preprocessData(rawData);

  for (let i = 0; i < data.length; i += 1) {
    const char = data[i];

    if (char === '\x00') {
      currentLineBuffer = '';
      pendingCR = false;
      continue;
    }

    if (char === '\x1b') {
      if (pendingCR) {
        currentLineBuffer = '';
        pendingCR = false;
      }
      if (data[i + 1] === '[') {
        inCsiSequence = true;
      }
    }

    if (inCsiSequence) {
      currentLineBuffer += char;
      if (/[a-zA-Z]/.test(char)) {
        inCsiSequence = false;
      }
      continue;
    }

    if (char === '\x1b') continue;

    if (char === '\n') {
      const newLine = document.createElement('div');
      newLine.className = 'history-line';
      const html = window.terminalAPI.ansiToHtml(currentLineBuffer);
      newLine.innerHTML = html.trim() === '' ? '&nbsp;' : html;
      historyContainer.appendChild(newLine);
      trimHistoryIfNeeded();

      currentLineBuffer = '';
      pendingCR = false;
      requestRender();
      if (shouldStickToBottom) scrollToBottom();
      continue;
    }

    if (char === '\r') {
      pendingCR = true;
      continue;
    }

    if (pendingCR) {
      currentLineBuffer = '';
      pendingCR = false;
    }

    if (char === '\x08') {
      currentLineBuffer = safeBackspace(currentLineBuffer);
      requestRender();
      continue;
    }

    currentLineBuffer += char;
    requestRender();
  }

  requestRender();
  if (shouldStickToBottom) scrollToBottom();
});

window.terminalAPI.onAppCommand((command) => {
  executeAppCommand(command);
});

hiddenInput.addEventListener('compositionstart', () => {
  isComposing = true;
});

hiddenInput.addEventListener('compositionend', (e) => {
  isComposing = false;
  if (tuiBlocked) {
    hiddenInput.value = '';
    return;
  }
  if (e.data) {
    window.terminalAPI.sendKeystroke(e.data);
  }
  hiddenInput.value = '';
  scrollToBottom();
});

hiddenInput.addEventListener('input', (e) => {
  if (tuiBlocked) {
    hiddenInput.value = '';
    return;
  }
  if (isComposing) return;
  if (e.inputType === 'insertCompositionText') return;
  if (e.data) {
    window.terminalAPI.sendKeystroke(e.data);
  }
  hiddenInput.value = '';
});

hiddenInput.addEventListener('keydown', (e) => {
  if (isComposing) return;
  const key = e.key;
  const normalizedKey = typeof key === 'string' ? key.toLowerCase() : '';
  if (tuiBlocked) {
    if (e.ctrlKey && normalizedKey === 'c') {
      window.terminalAPI.sendKeystroke('\x03');
      e.preventDefault();
      return;
    }
    e.preventDefault();
    return;
  }

  if (e.ctrlKey && normalizedKey === 'c') {
    window.terminalAPI.sendKeystroke('\x03');
    e.preventDefault();
    return;
  }

  const map = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowLeft: '\x1b[D',
    ArrowRight: '\x1b[C'
  };

  if (map[key]) {
    window.terminalAPI.sendKeystroke(map[key]);
    if (
      key === 'Tab' ||
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      key === 'Backspace'
    ) {
      e.preventDefault();
    }
  }
});

// Cmd/Ctrl+N is handled by the native application menu to avoid duplicate opens.
