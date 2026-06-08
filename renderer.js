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
let tuiUnblockTimer = null;
const TUI_SAFETY_UNBLOCK_MS = 5000;
const MAX_HISTORY_LINES = 1200;
const TRIM_BATCH_SIZE = 120;
const MAX_LINE_LEN = 8192;
const MAX_PENDING_ESC = 256;

// 跨 chunk 缝合被截断的转义序列时，暂存结尾未完成的半截序列。
let pendingEscape = '';
// 行跨行延续的 SGR（颜色/样式）状态：每行渲染时回填行首生效的 SGR，
// 因为 ansiToHtml 每次调用相互独立、不会自动跨行保留颜色。
let lineStartSgr = '';

const ALT_SCREEN_ENTER = /\x1b\[\?(?:47|1047|1048|1049)h/g;
const ALT_SCREEN_EXIT = /\x1b\[\?(?:47|1047|1048|1049)l/g;
const SGR_GLOBAL = /\x1b\[[0-9;:]*m/g;

// 累积当前生效的 SGR 状态。遇到含复位字段（空/0…）的 SGR 丢弃旧状态。
function applySgr(state, seq) {
  const params = seq.slice(2, -1); // [ 与 m 之间
  if (params === '' || /^0*(?:;|$)/.test(params)) {
    // 前导复位：清掉旧状态；若复位后又设了其它属性则保留本序列
    return /(?:^0*[1-9])|(?:;[1-9])/.test(params) ? seq : '';
  }
  const next = state + seq;
  return next.length > 512 ? seq : next;
}

// 返回 startState 叠加 text 内所有 SGR 之后的状态。
function sgrAfter(startState, text) {
  let st = startState;
  SGR_GLOBAL.lastIndex = 0;
  let m;
  while ((m = SGR_GLOBAL.exec(text)) !== null) st = applySgr(st, m[0]);
  return st;
}

// 把一行 buffer 渲染成 innerHTML：回填行首 SGR；纯空白行用 &nbsp; 保高度。
function lineInnerHtml(buffer) {
  const visible = buffer.replace(SGR_GLOBAL, '');
  if (visible.trim() === '') return '&nbsp;';
  return window.terminalAPI.ansiToHtml(lineStartSgr + buffer);
}

// 返回结尾处“未完成转义序列”的起点下标；无则 -1。用于跨 chunk 缝合。
function incompleteEscapeStart(s) {
  const i = s.lastIndexOf('\x1b');
  if (i === -1) return -1;
  if (s.length - i > MAX_PENDING_ESC) return -1; // 超长无终止 → 当垃圾，不滞留
  const tail = s.slice(i);
  if (tail.length === 1) return i;               // 孤立 ESC
  const c = tail[1];
  if (c === '[') {                                // CSI：需以 @-~ 终止
    return /\x1b\[[0-9;:<>?]*[ -\/]*[@-~]/.test(tail) ? -1 : i;
  }
  if (c === ']' || c === 'P' || c === '^' || c === '_' || c === 'X') {
    return /\x07|\x1b\\/.test(tail.slice(2)) ? -1 : i; // 字符串序列：需 BEL/ST
  }
  if (c === '(' || c === ')' || c === '*' || c === '+' || c === '#') {
    return tail.length >= 3 ? -1 : i;            // 字符集：需 1 个 id 字节
  }
  return -1;                                      // 单字节 Fe/Fs，已完整
}

function requestRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    currentLineSpan.innerHTML = window.terminalAPI.ansiToHtml(lineStartSgr + currentLineBuffer);
    renderScheduled = false;
  });
}

function popLastCodePoint(text) {
  if (!text) return text;
  const last = text.charCodeAt(text.length - 1);
  // 低位代理：和前一个高位代理一起删
  if (last >= 0xDC00 && last <= 0xDFFF && text.length >= 2) {
    return text.slice(0, -2);
  }
  return text.slice(0, -1);
}

function safeBackspace(text) {
  if (text.length === 0) return '';
  // 匹配所有 ANSI 转义序列（SGR、CSI 非 SGR、OSC 等），不仅 SGR
  const ansiRegex = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-_]/g;
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
      segments[i].content = popLastCodePoint(segments[i].content);
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
  inCsiSequence = false;
  inputLineBuffer = '';
  lineStartSgr = '';
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

let inputLineBuffer = '';

function clearTuiBlocked(reason) {
  if (!tuiBlocked && !tuiUnblockTimer) return;
  tuiBlocked = false;
  tuiNoticeShown = false;
  inputLineBuffer = '';
  if (tuiUnblockTimer) {
    clearTimeout(tuiUnblockTimer);
    tuiUnblockTimer = null;
  }
  if (reason) appendSystemNotice(reason);
}

function scheduleTuiSafetyUnblock() {
  if (tuiUnblockTimer) clearTimeout(tuiUnblockTimer);
  tuiUnblockTimer = setTimeout(() => {
    tuiUnblockTimer = null;
    if (tuiBlocked) {
      clearTuiBlocked('[S-term] TUI lock auto-released. Press Esc Esc Esc to unlock manually.');
    }
  }, TUI_SAFETY_UNBLOCK_MS);
}

let escUnlockCount = 0;
let escUnlockTimer = null;
function noteEscapeForUnlock() {
  if (!tuiBlocked) return false;
  escUnlockCount += 1;
  if (escUnlockTimer) clearTimeout(escUnlockTimer);
  escUnlockTimer = setTimeout(() => {
    escUnlockCount = 0;
    escUnlockTimer = null;
  }, 600);
  if (escUnlockCount >= 3) {
    escUnlockCount = 0;
    clearTuiBlocked('[S-term] TUI lock manually released.');
    return true;
  }
  return false;
}

function isBlockedShellCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let s = trimmed.replace(/^sudo\s+/i, '').trim();
  const firstToken = (s.split(/\s/)[0] || '').replace(/^['"]|['"]$/g, '');
  const base = firstToken.replace(/^.*[/\\]/, '');
  const BLOCKED = new Set([
    'vim', 'vi', 'nvim', 'gvim', 'view', 'less', 'more', 'top', 'htop', 'btop',
    'man', 'nano', 'emacs', 'neovim', 'vifm', 'ranger', 'ncdu', 'tmux', 'screen'
  ]);
  return BLOCKED.has(base);
}

(function wrapSendKeystroke() {
  const raw = window.terminalAPI.sendKeystroke.bind(window.terminalAPI);

  function flushPending(pending) {
    if (pending) raw(pending);
  }

  // 处理可能携带换行的多字符输入（粘贴 / IME 多字符）：按 \r 或 \n
  // 切片，逐段累加到 inputLineBuffer，遇到换行做和单字符按 Enter 一样
  // 的拦截判定，避免粘贴绕过 isBlockedShellCommand。
  function handleMultiCharInput(key) {
    const parts = key.split(/(\r\n|\r|\n)/);
    let pending = '';
    for (const part of parts) {
      if (part === '') continue;
      if (part === '\r' || part === '\n' || part === '\r\n') {
        if (isBlockedShellCommand(inputLineBuffer)) {
          appendSystemNotice('[S-term] This command is disabled (vim/less/TUI).');
          inputLineBuffer = '';
          flushPending(pending);
          pending = '';
          continue;
        }
        pending += '\r';
        inputLineBuffer = '';
      } else {
        inputLineBuffer += part;
        pending += part;
      }
    }
    flushPending(pending);
  }

  window.terminalAPI.sendKeystroke = function wrappedSend(key) {
    if (typeof key !== 'string' || key.length === 0) return;

    if (tuiBlocked) {
      if (key === '\x03') raw(key);
      return;
    }
    if (key === '\r' || key === '\n') {
      if (isBlockedShellCommand(inputLineBuffer)) {
        appendSystemNotice('[S-term] This command is disabled (vim/less/TUI).');
        inputLineBuffer = '';
        return;
      }
      raw('\r');
      inputLineBuffer = '';
      return;
    }
    if (key === '\x03') {
      inputLineBuffer = '';
      raw(key);
      return;
    }
    if (key === '\x15') {            // Ctrl+U：删除整行
      inputLineBuffer = '';
      raw(key);
      return;
    }
    if (key === '\x17') {            // Ctrl+W：删除前一个词
      inputLineBuffer = inputLineBuffer.replace(/\s*\S*$/, '');
      raw(key);
      return;
    }
    if (key === '\x7f' || key === '\x08') {
      inputLineBuffer = inputLineBuffer.slice(0, -1);
      raw(key);
      return;
    }
    if (key.length > 1 && !key.startsWith('\x1b')) {
      handleMultiCharInput(key);
      return;
    }
    if (key.length === 1 && key >= ' ' && key <= '~') {
      inputLineBuffer += key;
    }
    raw(key);
  };
})();

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

// 该渲染器只认 SGR 颜色（交给 ansiToHtml），其余转义序列若残留，终止字母会作为
// 可见字符泄漏（实测 \x1b[1A→"A"、\x1b[3G→"G"、OSC-ST→"]0;…"）。这里统一剥离，只留 …m。
function preprocessData(data) {
  // 屏幕清除：先触发本地清屏，序列随后被通用 CSI 规则移除
  if (data.includes('\x1b[2J') || data.includes('\x1b[3J')) {
    performClear();
  }
  return data
    // OSC（窗口标题/超链接等），BEL 或 ST 结尾
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // DCS / PM / APC / SOS 字符串序列，ST 结尾
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '')
    // 字符集指定（ESC ( B 等）
    .replace(/\x1b[()*+#][\s\S]?/g, '')
    // 除 SGR（…m）外的所有 CSI：光标移动、擦除、滚动、私有模式(?…h/l)等
    .replace(/\x1b\[[0-9;:<>?]*[ -\/]*[@-ln-~]/g, '')
    // 其它单字节/未识别的 ESC 引导序列（ESC 7/8/=/>/M/c…）；不匹配 \x1b[ 故 SGR 安全
    .replace(/\x1b[^[]/g, '')
    // 残留 BEL
    .replace(/\x07/g, '')
    // 退格-空格-退格 → 单个退格
    .replace(/\x08 +\x08/g, '\x08')
    // DEL → 退格
    .replace(/\x7f/g, '\x08');
}

function applyAltScreenTransitions(rawData) {
  const events = [];
  ALT_SCREEN_ENTER.lastIndex = 0;
  ALT_SCREEN_EXIT.lastIndex = 0;
  let m;
  while ((m = ALT_SCREEN_ENTER.exec(rawData)) !== null) {
    events.push({ index: m.index, type: 'enter' });
  }
  while ((m = ALT_SCREEN_EXIT.exec(rawData)) !== null) {
    events.push({ index: m.index, type: 'exit' });
  }
  events.sort((a, b) => a.index - b.index);

  for (const ev of events) {
    if (ev.type === 'enter') {
      tuiBlocked = true;
      if (!tuiNoticeShown) {
        appendSystemNotice('[S-term] Full-screen TUI (vim/less/top) is disabled in S-term.');
        appendSystemNotice('[S-term] Sending exit; if stuck, press Esc three times.');
        tuiNoticeShown = true;
        window.terminalAPI.forceExitTui();
      }
      scheduleTuiSafetyUnblock();
    } else {
      clearTuiBlocked();
    }
  }
  return events.length > 0;
}

window.terminalAPI.onTerminalIncoming((rawData) => {
  // 跨 chunk 缝合被截断的转义序列（node-pty 的数据块可能从序列中间断开），
  // 否则下一块开头会把残半截当普通文本渲染。主流终端同样会缓存半截序列。
  let chunk = pendingEscape + rawData;
  pendingEscape = '';
  const cut = incompleteEscapeStart(chunk);
  if (cut !== -1) {
    pendingEscape = chunk.slice(cut);
    chunk = chunk.slice(0, cut);
  }

  const shouldStickToBottom = isNearBottom();

  // 唯一可靠的 TUI 信号：alt-screen 切换。内容 banner 启发式误报率太高
  // （如 `top -bn1`、含 "less 5." 的普通文本），且会盲发 :q! 污染会话，已移除。
  applyAltScreenTransitions(chunk);

  const data = preprocessData(chunk);

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
      // ECMA-48 CSI 终止字节范围 0x40-0x7E（@A-Z[\]^_`a-z{|}~）。
      const code = char.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7E) {
        inCsiSequence = false;
      }
      continue;
    }

    if (char === '\x1b') continue;

    if (char === '\n') {
      const newLine = document.createElement('div');
      newLine.className = 'history-line';
      newLine.innerHTML = lineInnerHtml(currentLineBuffer);
      historyContainer.appendChild(newLine);
      trimHistoryIfNeeded();

      lineStartSgr = sgrAfter(lineStartSgr, currentLineBuffer);
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
    if (currentLineBuffer.length > MAX_LINE_LEN) {
      // 无换行的超长输出：硬换行，避免无限增长与每帧重排整行
      const wrapLine = document.createElement('div');
      wrapLine.className = 'history-line';
      wrapLine.innerHTML = lineInnerHtml(currentLineBuffer);
      historyContainer.appendChild(wrapLine);
      trimHistoryIfNeeded();
      lineStartSgr = sgrAfter(lineStartSgr, currentLineBuffer);
      currentLineBuffer = '';
    }
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
  // Enter is handled in keydown only; a follow-up input (insertLineBreak / lone \n)
  // would otherwise send a second \r and bypass blocked-command checks.
  if (e.inputType === 'insertLineBreak') return;
  if (e.data === '\n' || e.data === '\r') return;
  if (e.data) {
    window.terminalAPI.sendKeystroke(e.data);
  }
  hiddenInput.value = '';
});

hiddenInput.addEventListener('keydown', (e) => {
  if (isComposing) return;
  const key = e.key;
  const lower = typeof key === 'string' ? key.toLowerCase() : '';

  // 复制/粘贴/全选/新窗口/重载等交给 Cmd（mac）与原生菜单加速键处理。
  if (e.metaKey) return;

  if (tuiBlocked) {
    if (key === 'Escape') {
      noteEscapeForUnlock();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && lower === 'c') {
      window.terminalAPI.sendKeystroke('\x03');
      e.preventDefault();
      return;
    }
    e.preventDefault();
    return;
  }

  // Ctrl + 键 → 控制字符（终端惯例：Ctrl+A..Z → 0x01..0x1A 等）。
  if (e.ctrlKey && !e.altKey && typeof key === 'string' && key.length === 1) {
    // 非 mac 的复制/粘贴/全选是 Ctrl+Shift+C/V/A，交给菜单，别发成控制字符。
    if (e.shiftKey && (lower === 'c' || lower === 'v' || lower === 'a')) return;
    const cc = lower.charCodeAt(0);
    let byte = null;
    if (cc >= 97 && cc <= 122) byte = cc - 96;                          // A..Z → 1..26
    else if (key === ' ' || key === '@' || key === '2') byte = 0x00;    // NUL
    else if (key === '[' || key === '3') byte = 0x1b;                   // ESC
    else if (key === '\\' || key === '4') byte = 0x1c;
    else if (key === ']' || key === '5') byte = 0x1d;
    else if (key === '^' || key === '6') byte = 0x1e;
    else if (key === '_' || key === '7' || key === '/') byte = 0x1f;
    else if (key === '8') byte = 0x7f;                                  // DEL
    if (byte !== null) {
      window.terminalAPI.sendKeystroke(String.fromCharCode(byte));
      e.preventDefault();
      return;
    }
    // 其它 Ctrl 组合不拦截，交还系统
  }

  const map = {
    Enter: '\r',
    NumpadEnter: '\r',
    Backspace: '\x7f',
    Tab: e.shiftKey ? '\x1b[Z' : '\t',
    Escape: '\x1b',
    Delete: '\x1b[3~',
    Insert: '\x1b[2~',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowLeft: '\x1b[D',
    ArrowRight: '\x1b[C'
  };

  if (map[key]) {
    window.terminalAPI.sendKeystroke(map[key]);
    e.preventDefault();
  }
});

// Cmd/Ctrl+N is handled by the native application menu to avoid duplicate opens.
