const { contextBridge, ipcRenderer } = require('electron');
const Convert = require('ansi-to-html');

const convert = new Convert({
  newline: false,
  escapeXML: true,
  fg: '#000',
  bg: '#fff',
  colors: {
    0: '#000000',
    1: '#ff0000',
    2: '#00ff00',
    3: '#ffff00',
    4: '#0000ff',
    5: '#ff00ff',
    6: '#00ffff',
    7: '#ffffff',
    8: '#808080',
    9: '#ff0000',
    10: '#00ff00',
    11: '#ffff00',
    12: '#0000ff',
    13: '#ff00ff',
    14: '#00ffff',
    15: '#ffffff'
  }
});

contextBridge.exposeInMainWorld('terminalAPI', {
  sendKeystroke: (key) => ipcRenderer.send('terminal-keystroke', key),
  forceExitTui: () => ipcRenderer.send('force-exit-tui'),
  resizeTerminal: (size) => ipcRenderer.send('resize-terminal', size),
  requestNewWindow: () => ipcRenderer.send('new-window'),
  ansiToHtml: (text) => convert.toHtml(text),
  onTerminalIncoming: (callback) => {
    ipcRenderer.on('terminal-incoming', (_event, data) => callback(data));
  },
  onApplySettings: (callback) => {
    ipcRenderer.on('apply-settings', (_event, settings) => callback(settings));
  },
  onAppCommand: (callback) => {
    ipcRenderer.on('app-command', (_event, command) => callback(command));
  }
});
