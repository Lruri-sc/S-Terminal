const { app, BrowserWindow, ipcMain, systemPreferences, screen, Menu } = require('electron');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR_NAME = 'chloe-term';
const LEGACY_CONFIG_DIR_NAME = 'Strange-term';
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

const windowSessions = new Map();
let isIpcRegistered = false;
let lastWindowCascadeIndex = 0;

// 默认配置 (格式错误或文件不存在时使用)
const defaultSettings = {
  fontFamily: '"Faraco Hand", "Sue Ellen Francisco", sans-serif',
  fontSize: '22px',
  lineHeight: '1.3',
  cursorWidth: '10px',
  cursorHeight: '20px',
  cursorTranslateY: '-1px',
  textColor: '#000000',
  backgroundColor: '#ffffff',
  backgroundImage: ''
};

// -------------------------------------------------------------------------
// 配置读取
// -------------------------------------------------------------------------
function readSettings() {
  const userConfigDir = path.join(os.homedir(), CONFIG_DIR_NAME);
  const legacyConfigDir = path.join(os.homedir(), LEGACY_CONFIG_DIR_NAME);
  const userConfigPath = path.join(userConfigDir, 'config.txt');
  const legacyConfigPath = path.join(legacyConfigDir, 'config.txt');

  // 如果配置目录不存在，创建它
  if (!fs.existsSync(userConfigDir)) {
    try {
      fs.mkdirSync(userConfigDir, { recursive: true });
      console.log('[INFO] Created config directory:', userConfigDir);
    } catch (error) {
      console.error('[ERROR] Failed to create config directory:', error);
    }
  }

  // 兼容旧目录：首次升级时迁移配置文件
  if (!fs.existsSync(userConfigPath) && fs.existsSync(legacyConfigPath)) {
    try {
      fs.copyFileSync(legacyConfigPath, userConfigPath);
      console.log('[INFO] Migrated legacy config to new directory:', userConfigPath);
    } catch (error) {
      console.error('[ERROR] Failed to migrate legacy config:', error);
    }
  }

  // 如果配置文件不存在，创建默认配置
  if (!fs.existsSync(userConfigPath)) {
    try {
      const defaultConfig = JSON.stringify(defaultSettings, null, 2);
      fs.writeFileSync(userConfigPath, defaultConfig, 'utf8');
      console.log('[INFO] Created default config file:', userConfigPath);
    } catch (error) {
      console.error('[ERROR] Failed to create config file:', error);
    }
  }

  let settings = { ...defaultSettings };

  try {
    const configContent = fs.readFileSync(userConfigPath, 'utf8');
    const userSettings = JSON.parse(configContent);

    // 兼容旧配置：支持 color 和 textColor
    if (userSettings.color && !userSettings.textColor) {
      userSettings.textColor = userSettings.color;
    }

    settings = { ...defaultSettings, ...userSettings };
    console.log('[INFO] Loaded user config:', userConfigPath);

    // 验证 fontSize 格式
    if (typeof settings.fontSize !== 'string' || !settings.fontSize.endsWith('px')) {
      console.warn('[WARN] Invalid fontSize format, using default');
      settings.fontSize = defaultSettings.fontSize;
    }

    // 处理背景图片路径
    if (settings.backgroundImage && settings.backgroundImage.trim() !== '') {
      let imagePath = settings.backgroundImage.trim();

      console.log('[DEBUG] Original image path:', imagePath);

      if (!path.isAbsolute(imagePath)) {
        imagePath = path.join(userConfigDir, imagePath);
        console.log('[DEBUG] Converted to absolute path:', imagePath);
      }

      if (!fs.existsSync(imagePath)) {
        console.error('[ERROR] Background image not found:', imagePath);
        console.error('[ERROR] Please place images in:', userConfigDir);
        settings.backgroundImage = '';
      } else {
        console.log('[SUCCESS] Background image found:', imagePath);
        const fileUrl = 'file://' + imagePath.replace(/\\/g, '/');
        settings.backgroundImage = fileUrl;
        console.log('[DEBUG] Final URL:', fileUrl);
      }
    } else {
      settings.backgroundImage = '';
    }
  } catch (error) {
    console.error('[ERROR] Failed to read settings:', error);
    settings = { ...defaultSettings };
  }

  return settings;
}

// -------------------------------------------------------------------------
// PTY 清理函数
// -------------------------------------------------------------------------
function buildTerminalEnv() {
  const env = { ...process.env };
  const standardPaths = process.platform === 'win32'
    ? [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
        path.join(process.env.SystemRoot || 'C:\\Windows'),
      ]
    : [
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/opt/homebrew/bin',
        '/usr/local/opt',
        path.join(os.homedir(), '.local/bin'),
        path.join(os.homedir(), 'bin')
      ];

  const existingPath = env.PATH || '';
  const pathArray = existingPath.split(PATH_SEP).concat(standardPaths);
  env.PATH = [...new Set(pathArray)].filter((p) => p).join(PATH_SEP);

  env.SHELL_SESSIONS_DISABLE = '1';
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.CLICOLOR = '1';
  env.CLICOLOR_FORCE = '1';
  env.FORCE_COLOR = '1';
  env.HOME = os.homedir();
  env.USER = os.userInfo().username;
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
  return env;
}

function resolveShellPath() {
  const defaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh';
  const shell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'] || defaultShell;
  if (process.platform !== 'win32' && !fs.existsSync(shell)) {
    console.error('[ERROR] Shell not found:', shell);
    return '/bin/sh';
  }
  return shell;
}

function cleanupSession(webContentsId) {
  const session = windowSessions.get(webContentsId);
  if (!session) return;

  if (session.loginTimeout) {
    clearTimeout(session.loginTimeout);
    session.loginTimeout = null;
  }

  if (session.ptyProcess && !session.ptyProcess.killed) {
    try {
      session.ptyProcess.kill();
    } catch (error) {
      console.error('[ERROR] Failed to kill PTY:', error.message);
    }
  }
  windowSessions.delete(webContentsId);
}

function createPtyForWindow(win, initialCols = 80, initialRows = 30) {
  cleanupSession(win.webContents.id);

  const shell = resolveShellPath();
  const env = buildTerminalEnv();
  const shellArgs = process.platform === 'win32' ? [] : ['--login'];
  let spawnedPty = null;

  try {
    spawnedPty = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: initialCols,
      rows: initialRows,
      cwd: os.homedir(),
      env: env
    });
    console.log('[INFO] PTY spawned successfully, PID:', spawnedPty.pid, 'WCID:', win.webContents.id);
  } catch (error) {
    console.error('[FATAL] Failed to spawn PTY:', error.message);
    if (process.platform !== 'win32') {
      try {
        spawnedPty = pty.spawn('/bin/sh', [], {
          name: 'xterm-256color',
          cols: initialCols,
          rows: initialRows,
          cwd: os.homedir(),
          env: env
        });
        console.log('[INFO] Fallback to /bin/sh successful, WCID:', win.webContents.id);
      } catch (fallbackError) {
        console.error('[FATAL] Fallback shell also failed:', fallbackError.message);
        return;
      }
    } else {
      return;
    }
  }

  if (!spawnedPty) return;

  const session = {
    window: win,
    ptyProcess: spawnedPty,
    cols: initialCols,
    rows: initialRows,
    loginTimeout: null
  };
  windowSessions.set(win.webContents.id, session);

  spawnedPty.on('data', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal-incoming', data);
    }
  });

  spawnedPty.on('exit', (exitCode, signal) => {
    console.log(`[INFO] PTY exited with code ${exitCode}, signal ${signal}`);
    if (!win.isDestroyed()) {
      win.webContents.send('terminal-incoming',
        `\r\n[Process exited with code ${exitCode}]\r\n`);
    }
  });

  session.loginTimeout = setTimeout(() => {
    if (win.isDestroyed()) return;
    // 仅发送 clear screen，不发送 ESC[H，避免偶发显示为字母 h。
    win.webContents.send('terminal-incoming', '\x1b[2J');
    const now = new Date();
    const dateStr = now.toDateString() + ' ' + now.toTimeString().split(' ')[0];
    const ttyName = 'ttys' + Math.floor(Math.random() * 900 + 100);
    win.webContents.send('terminal-incoming', `Last login: ${dateStr} on ${ttyName}\r`);
    if (spawnedPty && !spawnedPty.killed) {
      spawnedPty.write('\r');
    }
  }, 120);
}

function registerIPCHandlers() {
  if (!isIpcRegistered) {
    ipcMain.on('terminal-keystroke', (event, key) => {
      const session = windowSessions.get(event.sender.id);
      if (session && session.ptyProcess && !session.ptyProcess.killed) {
        session.ptyProcess.write(key);
      }
    });

    ipcMain.on('resize-terminal', (event, size) => {
      const session = windowSessions.get(event.sender.id);
      if (session && session.ptyProcess && !session.ptyProcess.killed) {
        session.cols = size.cols;
        session.rows = size.rows;
        try {
          session.ptyProcess.resize(size.cols, size.rows);
        } catch (error) {
          console.error('[ERROR] Failed to resize PTY:', error.message);
        }
      }
    });

    ipcMain.on('request-prompt-redraw', (event) => {
      const session = windowSessions.get(event.sender.id);
      if (session && session.ptyProcess && !session.ptyProcess.killed) {
        session.ptyProcess.write('\x0C');
      }
    });

    ipcMain.on('new-window', () => {
      createWindow();
    });

    isIpcRegistered = true;
    console.log('[INFO] IPC handlers registered');
  }
}

function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const copyAccelerator = isMac ? 'CmdOrCtrl+C' : 'Ctrl+Shift+C';
  const pasteAccelerator = isMac ? 'CmdOrCtrl+V' : 'Ctrl+Shift+V';
  const selectAllAccelerator = isMac ? 'CmdOrCtrl+A' : 'Ctrl+Shift+A';

  const sendCommandToFocusedWindow = (command) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    win.webContents.send('app-command', command);
  };

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        {
          label: 'Copy',
          accelerator: copyAccelerator,
          click: () => sendCommandToFocusedWindow('copy')
        },
        {
          label: 'Paste',
          accelerator: pasteAccelerator,
          click: () => sendCommandToFocusedWindow('paste')
        },
        {
          label: 'Select All',
          accelerator: selectAllAccelerator,
          click: () => sendCommandToFocusedWindow('select-all')
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function getNextWindowBounds(defaultWidth, defaultHeight) {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length === 0) {
    return { width: defaultWidth, height: defaultHeight };
  }

  const anchorWindow = BrowserWindow.getFocusedWindow() || allWindows[allWindows.length - 1];
  const anchorBounds = anchorWindow.getBounds();
  const display = screen.getDisplayMatching(anchorBounds);
  const area = display.workArea;

  const step = 24;
  lastWindowCascadeIndex += 1;
  const offset = step * Math.min(lastWindowCascadeIndex, 10);

  const maxX = area.x + area.width - defaultWidth;
  const maxY = area.y + area.height - defaultHeight;
  const x = Math.max(area.x, Math.min(anchorBounds.x + offset, maxX));
  const y = Math.max(area.y, Math.min(anchorBounds.y + offset, maxY));

  return { x, y, width: defaultWidth, height: defaultHeight };
}

// -------------------------------------------------------------------------
// 窗口创建
// -------------------------------------------------------------------------
function createWindow() {
  registerIPCHandlers();
  const settings = readSettings();
  const defaultWidth = 800;
  const defaultHeight = 600;
  const bounds = getNextWindowBounds(defaultWidth, defaultHeight);

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: true,
    transparent: false,
    backgroundColor: settings.backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      enableRemoteModule: false,
      zoomFactor: 1.0
    }
  });

  win.loadFile('index.html');

  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1.0);
    win.webContents.send('apply-settings', settings);
    createPtyForWindow(win);
  });

  win.webContents.on('context-menu', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Copy', click: () => win.webContents.send('app-command', 'copy') },
      { label: 'Paste', click: () => win.webContents.send('app-command', 'paste') },
      { label: 'Select All', click: () => win.webContents.send('app-command', 'select-all') },
      { type: 'separator' },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() }
    ]);
    contextMenu.popup({ window: win });
  });

  // macOS 键盘重复设置
  if (process.platform === 'darwin') {
    try {
      systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
    } catch (e) {
      console.error('[WARN] Failed to set key repeat preference:', e);
    }
  }

  win.on('closed', () => {
    cleanupSession(win.webContents.id);
  });

  return win;
}

// -------------------------------------------------------------------------
// 应用生命周期
// -------------------------------------------------------------------------
app.whenReady().then(() => {
  setupApplicationMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    win.focus();
  }
});

app.on('before-quit', () => {
  for (const webContentsId of Array.from(windowSessions.keys())) {
    cleanupSession(webContentsId);
  }
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  for (const webContentsId of Array.from(windowSessions.keys())) {
    cleanupSession(webContentsId);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled rejection at:', promise, 'reason:', reason);
});