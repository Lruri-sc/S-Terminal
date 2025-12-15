const { app, BrowserWindow, ipcMain, systemPreferences } = require('electron');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs');
const path = require('path');

// -------------------------------------------------------------------------
// 全局变量和状态管理
// -------------------------------------------------------------------------
let mainWindow = null;
let ptyProcess = null;
let isIpcRegistered = false; 
let currentCols = 80;
let currentRows = 30;

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

function readSettings() {
  // 用户配置目录和文件路径
  const userConfigDir = path.join(os.homedir(), 'Strange-term');
  const userConfigPath = path.join(userConfigDir, 'config.txt');
  
  // 如果配置目录不存在，创建它
  if (!fs.existsSync(userConfigDir)) {
    try {
      fs.mkdirSync(userConfigDir, { recursive: true });
      console.log('[INFO] Created config directory:', userConfigDir);
    } catch (error) {
      console.error('[ERROR] Failed to create config directory:', error);
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
    
    settings = { ...defaultSettings, ...userSettings };
    console.log('[INFO] Loaded user config:', userConfigPath);

    if (typeof settings.fontSize !== 'string' || !settings.fontSize.endsWith('px')) {
      settings.fontSize = defaultSettings.fontSize;
    }

    if (settings.backgroundImage && settings.backgroundImage.trim() !== '') {
      let imagePath = settings.backgroundImage.trim();
      
      console.log('[DEBUG] Original image path:', imagePath);
      
      if (!path.isAbsolute(imagePath)) {
        // 相对路径从 Strange-term 文件夹解析
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

function initializePTYAndIPC() {
  if (ptyProcess && !ptyProcess.killed) {
    console.log('[INFO] Cleaning up existing PTY process');
    ptyProcess.kill();
    ptyProcess = null;
  }

  const shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'] || '/bin/zsh';
  
  console.log('[INFO] Spawning new PTY process');
  
  const env = { ...process.env };
  
  // 🔧 修复：确保 PATH 包含所有标准路径
  const standardPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',  // Apple Silicon Homebrew
    '/usr/local/opt',      // Intel Homebrew
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), 'bin')
  ];
  
  // 合并现有 PATH 和标准路径
  const existingPath = env.PATH || '';
  const pathArray = existingPath.split(':').concat(standardPaths);
  // 去重
  env.PATH = [...new Set(pathArray)].filter(p => p).join(':');
  
  console.log('[DEBUG] PATH:', env.PATH);
  
  env.SHELL_SESSIONS_DISABLE = '1';
  // 强制启用颜色输出
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.CLICOLOR = '1';
  env.CLICOLOR_FORCE = '1';
  env.FORCE_COLOR = '1';
  env.HOME = os.homedir();
  env.USER = os.userInfo().username;
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
  
  ptyProcess = pty.spawn(shell, ['--login'], {  // 🔧 添加 --login 参数
    name: 'xterm-256color',
    cols: 80, 
    rows: 30, 
    cwd: process.env.HOME,
    env: env
  });

  ptyProcess.on('data', function(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-incoming', data);
    }
  });

  if (!isIpcRegistered) {
    ipcMain.on('terminal-keystroke', (event, key) => {
      if (ptyProcess && !ptyProcess.killed) ptyProcess.write(key);
    });

    ipcMain.on('resize-terminal', (event, size) => {
      currentCols = size.cols;
      currentRows = size.rows;
      if (ptyProcess && !ptyProcess.killed) {
        try {
          ptyProcess.resize(currentCols, currentRows);
        } catch (error) {
          console.error('[ERROR] Failed to resize PTY:', error.message);
        }
      }
    });
    
    ipcMain.on('request-prompt-redraw', () => {
      if (ptyProcess && !ptyProcess.killed) {
        ptyProcess.write('\x0C');
      }
    });

    isIpcRegistered = true;
  }
}

function createWindow() {
  initializePTYAndIPC(); 

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  const settings = readSettings(); 

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: true,         
    transparent: false,
    backgroundColor: settings.backgroundColor,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: false,
      zoomFactor: 1.0
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1.0);
    mainWindow.webContents.send('apply-settings', settings);
    
    let firstPromptReceived = false;
    let loginMsgSent = false;
    
    const dataListener = (data) => {
      if (!firstPromptReceived && (data.includes('%') || data.includes('$'))) {
        firstPromptReceived = true;
        
        setTimeout(() => {
          if (!loginMsgSent && mainWindow && !mainWindow.isDestroyed()) {
            loginMsgSent = true;
            
            mainWindow.webContents.send('terminal-incoming', '\x1b[2J\x1b[H');
            
            const now = new Date();
            const dateStr = now.toDateString() + ' ' + now.toTimeString().split(' ')[0];
            const ttyName = 'ttys' + Math.floor(Math.random() * 900 + 100);
            const loginMsg = `Last login: ${dateStr} on ${ttyName}\r`;
            mainWindow.webContents.send('terminal-incoming', loginMsg);
            
            if (ptyProcess && !ptyProcess.killed) {
              ptyProcess.write('\r');
            }
          }
        }, 100);
      }
    };
    
    if (ptyProcess && !ptyProcess.killed) {
      ptyProcess.on('data', dataListener);
      
      setTimeout(() => {
        if (ptyProcess && !ptyProcess.killed) {
          ptyProcess.removeListener('data', dataListener);
        }
      }, 5000);
    }
  });

  if (process.platform === 'darwin') {
    try {
      systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
    } catch (e) {
      console.error('Failed to set key repeat preference:', e);
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    
    if (ptyProcess && !ptyProcess.killed) {
      ptyProcess.kill();
      ptyProcess = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  if (ptyProcess) {
    ptyProcess.kill();
    ptyProcess = null;
  }
});