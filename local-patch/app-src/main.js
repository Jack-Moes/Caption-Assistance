// main.js -- Electron main process
// Creates the frameless window and runs a persistent PowerShell helper that
// reads Windows Live Captions text via UI Automation and streams it here.
const { app, BrowserWindow, ipcMain, dialog, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const http = require('http');
const OPACITY_FILE = path.join(os.tmpdir(), 'captionassistance-lcopacity.txt');
const CA_DBG = path.join(os.tmpdir(), 'ca-debug.log');   // unbuffered debug log (appendFileSync flushes immediately)
function dbg(m) { try { fs.appendFileSync(CA_DBG, m + '\n'); } catch (e) {} }
// PowerShell helpers must live on the real filesystem (external powershell.exe
// cannot read inside app.asar); packaged builds ship them as extraResources.
const scriptsDir = app.isPackaged ? process.resourcesPath : __dirname;
const scriptPath = (name) => path.join(scriptsDir, name);

// cloud transcription API keys live in local text files next to the app (never bundled). Read on demand
// so pasting a key doesn't need a restart. A placeholder value counts as "no key".
function readKeyFile(name) {
  const dirs = [];
  try { dirs.push(app.getPath('userData')); } catch (e) {}   // where save-key writes (writable + persistent when packaged)
  dirs.push(__dirname, scriptsDir);
  try { dirs.push(path.dirname(app.getPath('exe'))); } catch (e) {}
  for (const d of dirs) { try { const v = fs.readFileSync(path.join(d, name), 'utf8').trim(); if (v) return v; } catch (e) {} }
  return '';
}
function transcribeKeys() {
  const clean = (v) => (v && v.indexOf('PASTE_') !== 0) ? v : '';   // a placeholder file counts as no key
  return {
    openai: clean(readKeyFile('openai-key.txt')),
    deepgram: clean(readKeyFile('deepgram-key.txt')),
    elevenlabs: clean(readKeyFile('elevenlabs-key.txt')),
    speechmatics: clean(readKeyFile('speechmatics-key.txt')),
  };
}
// per-source engines, set independently. speaker: system(LiveCaptions) | local(Vosk) | deepgram | elevenlabs | speechmatics.
// mic: browser(Chrome speech, works with NewCoo) | local(Vosk) | deepgram | elevenlabs | speechmatics.
let speakerEngine = 'system';
let micEngine = 'browser';
let micReaderPaused = false;  // WinRT mic-reader runs only when micEngine === 'browser' (fallback next to Chrome speech)
let readerPaused = false;     // Live Captions reader paused when a non-system engine is active
let localStt = { mic: null, speaker: null };   // local GPU (RealtimeSTT) subprocesses, one per source

// Local deployment: only run on the requested LAN subnet (192.168.5.*).
function networkAllowed() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
      for (const a of (ifaces[name] || [])) {
        if (a && a.family === 'IPv4' && /^192\.168\.5\./.test(a.address)) return true;
      }
    }
  } catch (e) {}
  return false;
}

// Distribution telemetry is intentionally disabled in this local build.
// No build ID, hostname, Windows username, or local IP addresses are sent at startup.

let win = null;
let reader = null;
let restartTimer = null;
let quitting = false;
let alwaysOnTopState = false;   // mirrors the ↑ toggle; starts OFF. Gates the raise-on-click re-stamp.
let stealthOn = false;   // stealth (hide from screen capture/sharing) is OFF by default; toggle it on in Settings
// ---- in-app debug console: mirror main-process console output (incl. errors) to the renderer so logs
// are catchable on machines without DevTools. A ring buffer serves the initial dump on window load.
const _dbgBuf = [];
function _dbgPush(level, args) {
  try {
    const msg = '[main] ' + Array.prototype.map.call(args, (x) => (typeof x === 'string' ? x : (function () { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
    _dbgBuf.push({ level: level, msg: msg }); if (_dbgBuf.length > 700) _dbgBuf.shift();
    if (win && !win.isDestroyed()) win.webContents.send('debug-log', { level: level, msg: msg });
  } catch (e) {}
}
['log', 'warn', 'error'].forEach(function (lvl) { var _o = console[lvl].bind(console); console[lvl] = function () { _o.apply(console, arguments); _dbgPush(lvl, arguments); }; });
ipcMain.handle('get-debug-log', function () { return _dbgBuf; });
// never let a background spawn/IPC error take down the whole app
process.on('uncaughtException', (err) => { try { console.error('uncaught:', err && (err.stack || err.message)); } catch (e) {} });
process.on('unhandledRejection', (r) => { try { console.error('unhandledRejection:', (r && (r.stack || r.message)) || r); } catch (e) {} });

// a splash (images/splash.html -> splash.png + a bouncing-dots loader) that paints instantly, so the
// user sees branding while the heavier main window + renderer load -- instead of a white blank on start.
let splash = null, splashAt = 0, revealScheduled = false;
function createSplash() {
  try {
    splash = new BrowserWindow({
      width: 720, height: 405, frame: false, resizable: false, movable: false, center: true,   // 16:9 to match splash.mp4
      alwaysOnTop: true, skipTaskbar: true, hasShadow: true, backgroundColor: '#05141a', show: true,
      webPreferences: { autoplayPolicy: 'no-user-gesture-required' }   // let the muted splash video autoplay
    });
    try { splash.setContentProtection(stealthOn); } catch (e) {}
    splash.loadFile(path.join(__dirname, 'images', 'splash.html'));
    splash.webContents.on('did-finish-load', () => { try { splash.webContents.executeJavaScript('var _v=document.getElementById("ver"); if(_v) _v.textContent=' + JSON.stringify('v' + app.getVersion()) + ';'); } catch (e) {} });
    splash.on('closed', () => { splash = null; });
    splashAt = Date.now();
  } catch (e) { splash = null; }
}
function closeSplash() { if (splash && !splash.isDestroyed()) { try { splash.close(); } catch (e) {} } splash = null; }
// Keep the branded start video visible for five seconds before revealing the app.
function revealMain() {
  if (revealScheduled) return;
  revealScheduled = true;
  const wait = Math.max(0, 5000 - (Date.now() - (splashAt || Date.now())));  // play the 5s start video
  setTimeout(() => {
    try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (e) {}
    closeSplash();
  }, wait);
}
function createWindow() {
  createSplash();   // show instant feedback first
  win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 480,
    minHeight: 320,
    icon: path.join(__dirname, 'images', 'icon.png'),
    frame: false,               // custom teal title bars
    transparent: false,         // opaque -> Win11 DWM rounds the corners; resize works
    backgroundColor: '#ffffff',
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,          // off by default; user pins with the ↑ header button
    show: false,                 // revealed on ready-to-show so the splash shows first, not a white blank
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'   // let session-replay audio load/seek/play without a gesture (fixes MediaRecorder webm duration probe)
    }
  });
  win.once('ready-to-show', revealMain);   // reveals after the five-second minimum above
  setTimeout(revealMain, 12000);           // fallback: never leave the window hidden if ready-to-show is missed
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
  // Re-assert topmost whenever we regain focus, so we surface above another
  // WS_EX_TOPMOST window (e.g. a browser forced on-top by WindowsTop.exe). Covers
  // Alt+Tab / taskbar activation; mouse clicks are also covered by 'win-raise'.
  win.on('focus', raiseWindow);
  // stealth: exclude this window from screen capture / screen-sharing (WDA_EXCLUDEFROMCAPTURE
  // on Win10 2004+). It stays fully visible to the user but records/streams as blank.
  try { win.setContentProtection(stealthOn); } catch (e) {}
  setLcOpacity(0);          // hidden by default until the user changes it
  ensureLiveCaptions();
  startReader();
}

// turn on Windows Live Captions automatically when the app starts
function ensureLiveCaptions() {
  try {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('start-livecaptions.ps1')], { windowsHide: true });
    ps.on('error', () => {});   // e.g. AV/EDR blocks the child powershell -> don't crash
  } catch (e) {}
}

function startReader() {
  if (quitting || readerPaused || !win || win.isDestroyed()) return;
  try { if (reader) reader.kill(); } catch (e) {}   // never run two Live Captions readers at once
  let ps;
  try {
    ps = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('caption-reader.ps1'), String(process.pid)],
      { windowsHide: true });
  } catch (e) { return; }
  reader = ps;
  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      // drop Windows Live Captions' own placeholder/status lines -- they are not speech
      if (obj && obj.status === 'live' && typeof obj.text === 'string'
          && /^\s*(ready to show live captions|live captions? (are on|will appear|is (on|starting))|turn on live captions|caption settings)/i.test(obj.text)) return;
      if (win && !win.isDestroyed()) win.webContents.send('caption', obj);
    } catch (e) { /* ignore malformed lines */ }
  });
  const restart = () => { if (!quitting && !readerPaused && win && !win.isDestroyed()) { restartTimer = setTimeout(startReader, 1000); } };
  ps.on('exit', restart);     // reader died -> back off and restart while the app is open
  ps.on('error', restart);    // spawn failed asynchronously (no listener would crash the app)
}

// only allow one instance so windows don't stack up
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(async () => {
    const pass = networkAllowed();
    if (!pass) {
      console.error('[CA-main] unauthorized network -> exiting (requires 192.168.5.*)');
      try { app.quit(); } catch (e) {} process.exit(1); return;   // exit BEFORE createWindow -> the splash never shows on an unauthorized machine
    }
    createWindow();
    // allow the renderer's getUserMedia (mic) + getDisplayMedia (system-audio loopback) without a prompt
    try {
      const { session, desktopCapturer } = require('electron');
      session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || perm === 'audioCapture' || perm === 'microphone' || perm === 'display-capture'));
      // getDisplayMedia -> return a screen source + system audio loopback, so speaker capture resolves with no picker
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] })
          .then((sources) => callback(sources && sources.length ? { video: sources[0], audio: 'loopback' } : {}))
          .catch(() => { try { callback({}); } catch (e) {} });
      }, { useSystemPicker: false });
    } catch (e) {}
    startBridge();
    startMicReader();    // mic capture (2nd caption source + teleprompter)
    startMuteServer();   // warm up the persistent mute server so the first mute click is instant
    registerHotkeys();   // F1 send / F2 aa / F3 bb (all user-configurable)
  });
}
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} stopBridge(); try { if (muteSrv) muteSrv.kill(); } catch (e) {} });
app.on('window-all-closed', () => {
  quitting = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (reader) { try { reader.kill(); } catch (e) {} reader = null; }   // kill the reader FIRST so it can't restore LC on-screen
  if (micReader) { try { micReader.kill(); } catch (e) {} }
  // Turn OFF Live Captions on exit (user request). It's parked OFF-SCREEN right now, so
  // force-killing it there closes it with NO on-screen blink; /F skips LC's graceful save,
  // so it won't persist the off-screen rect (a later manual LC launch still opens on-screen).
  // The next app start relaunches LC and start-livecaptions.ps1 re-parks it off-screen fast.
  try { spawnSync('taskkill', ['/IM', 'LiveCaptions.exe', '/F'], { windowsHide: true, timeout: 4000 }); } catch (e) {}
  app.quit();
});

// window controls
ipcMain.on('win-min', () => { if (win) win.minimize(); });
ipcMain.on('win-close', () => { if (win) win.close(); });
ipcMain.on('win-top', (e, val) => { alwaysOnTopState = !!val; if (win) win.setAlwaysOnTop(!!val); });
ipcMain.on('win-raise', () => raiseWindow());
// Rise above any OTHER always-on-top window. Both share the single WS_EX_TOPMOST
// z-band, where a plain HWND_TOP reorder isn't reliable and setAlwaysOnTop(true)
// is a no-op once the flag is set. Toggling the flag forces Electron to re-issue
// SetWindowPos(HWND_TOPMOST), re-stamping us at the TOP of the band. The
// false->true transition is synchronous (no repaint between) so there's no flicker.
function raiseWindow() {
  if (!win || win.isDestroyed() || !alwaysOnTopState) return;
  try { win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch (e) {}
}
ipcMain.on('set-stealth', (e, on) => { if (process.env.CAPTIONASSISTANCE_NOSTEALTH) return; stealthOn = !!on; if (win && !win.isDestroyed()) { try { win.setContentProtection(stealthOn); } catch (err) {} } });
ipcMain.on('clip', (e, text) => clipboard.writeText(text || ''));

// ---- Send the caption selection to ChatGPT via the Chrome-extension bridge ----
// doSendChatGPT queues a command; the "Caption assistance Bridge" extension long-polls the
// local server below, then types the text into the chatgpt.com tab and submits it.
function doSendChatGPT(text, actionId, submit, focus) {
  text = (text || '').toString().trim();
  console.log('[CA-main] doSendChatGPT len', text.length, '| extConnected', extConnected());
  dbg('doSend textlen=' + text.length);
  if (!text) { console.log('[CA-main] empty selection -> nothing queued'); dbg('  EMPTY -> not queued'); return; }
  enqueueCommand({ type: 'send', text: text, submit: submit !== false, focus: focus !== false, ts: Date.now() });
  if (win && !win.isDestroyed()) win.webContents.send('gpt-status', { connected: extConnected(), justSent: true, action: actionId || 'send' });
}
// grant foreground rights (while THIS app is foreground on the click) so the bound
// browser tab can raise above this window when the extension focuses it
function allowForeground() {
  try {
    const psCode = "Add-Type -Namespace CA -Name FG -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool AllowSetForegroundWindow(int pid);'; [void][CA.FG]::AllowSetForegroundWindow(-1)";
    const enc = Buffer.from(psCode, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    ps.on('error', () => {});
  } catch (e) {}
}
ipcMain.on('send-chatgpt', (e, text) => doSendChatGPT(text));
// Read the live caption selection straight from the renderer (the DOM selection
// survives the window losing focus).
async function getSelectionText() {
  if (!win || win.isDestroyed()) return '';
  // read via the renderer helper that strips .pt timestamps (not raw selection.toString())
  try { return await win.webContents.executeJavaScript('(window.__captionSelText ? window.__captionSelText() : "")'); } catch (e) { return ''; }
}
// Configurable actions. Hotkeys start UNBOUND ('') -- the user assigns them in Settings, so a fresh
// launch never captures F1/F2/F3 etc. The renderer sends its saved bindings on load.
//   send : the raw selection (the interviewer's words)
//   aa   : an "aa" line, then the selection      (your pre-set "aa" instruction + context)
//   bb   : just the literal "bb"                  (your pre-set "bb" instruction, no context)
let actions = {
  send:    { key: '' },
  aa:      { key: '', label: 'aa' },
  bb:      { key: '', text: 'zz' },
  simple:  { key: '', label: 'ss' },   // sends the "ss" keyword + context; the primed session's [ss] mode = a simple 3-4 sentence answer
  compact: { key: '', url: '' },  // open a fresh ChatGPT window at this URL + move the history there
  micmute: { key: '' }              // toggle system mic mute (handled in the renderer so it uses the chosen device)
};
async function sendAction(id) {
  console.log('[CA-main] sendAction:', id);
  dbg('sendAction ' + id);
  if (id !== 'bb') allowForeground();   // grant foreground so the bound tab can raise (not for bb/zz)
  if (id === 'compact') {
    enqueueCommand({ type: 'compact', url: (actions.compact.url || ''), ts: Date.now() });
    if (win && !win.isDestroyed()) { win.webContents.send('gpt-status', { connected: extConnected(), justSent: true, action: 'compact' }); win.webContents.send('advance-selection', 'compact'); }
    return;
  }
  let text = '', submit = true;
  if (id === 'send') { text = await getSelectionText(); }
  else if (id === 'paste') { text = await getSelectionText(); submit = false; }   // edit-before-send: paste only, no submit
  else if (id === 'aa') { const sel = await getSelectionText(); const label = (actions.aa.label || 'aa'); text = sel ? (label + '\n' + sel) : label; }
  else if (id === 'simple') { const sel = await getSelectionText(); const label = (actions.simple.label || 'ss'); text = sel ? (label + '\n' + sel) : label; }
  else if (id === 'bb') { text = (actions.bb.text || 'bb'); }
  console.log('[CA-main] action', id, '-> text length', text.length, 'submit', submit);
  dbg('  ' + id + ' built textlen=' + text.length);
  doSendChatGPT(text, id, submit, id !== 'bb');   // bb/zz: don't bring the browser forward
  // bb/zz sends a fixed keyword (not the selection) -> leave the selection untouched
  if (id !== 'bb' && win && !win.isDestroyed()) win.webContents.send('advance-selection', id);
}
ipcMain.on('send-action', (e, id) => sendAction(id));

// default prompts page: read the bundled prompts/*.txt (resources/prompts when packaged, ./prompts in dev)
function promptsDir() { return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'prompts'); }
ipcMain.handle('get-version', () => app.getVersion());
// session audio recordings (speaker+mic mix) live in userData\recordings\<id>.webm
function recPath(id) { return path.join(app.getPath('userData'), 'recordings', String(id).replace(/[^0-9a-zA-Z_-]/g, '') + '.webm'); }
ipcMain.handle('save-audio', (e, id, data) => {
  try {
    const p = recPath(id);
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (er) {}
    fs.writeFileSync(p, Buffer.from(data));
    return { ok: true, file: path.basename(p) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('get-audio', (e, id) => {
  try { const p = recPath(id); return fs.existsSync(p) ? fs.readFileSync(p) : null; } catch (err) { return null; }
});
ipcMain.handle('delete-audio', (e, id) => {
  try {
    const p = recPath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('get-prompts', () => {
  try {
    return fs.readdirSync(promptsDir()).filter((f) => /\.txt$/i.test(f)).sort()
      .map((f) => ({ name: f.replace(/\.txt$/i, ''), text: fs.readFileSync(path.join(promptsDir(), f), 'utf8') }));
  } catch (e) { return []; }
});

// ---- user-configurable global hotkeys (defaults F1/F2/F3) ----
let codingMode = false;   // Live Coding interview mode: F1..F5 become the coding-prompt commands
// send a plain keyword (e.g. "1".."5") to the bound ChatGPT tab, keyword-only, and submit
function sendKeyword(text) { allowForeground(); doSendChatGPT(String(text == null ? '' : text), 'code', true, true); }
function registerHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  const reg = (key, fn) => { if (!key) return true; try { return globalShortcut.register(key, fn); } catch (e) { return false; } };
  const results = {};
  if (codingMode) {
    // Live Coding ONLY: F1..F5 -> commands 1..5 (explain/code/improve/edge/time). Standard mode is untouched.
    ['1', '2', '3', '4', '5'].forEach((c, i) => { results['code' + c] = reg('F' + (i + 1), () => sendKeyword(c)); });
  } else {
    results.send = reg(actions.send.key, () => sendAction('send'));
    results.aa = reg(actions.aa.key, () => sendAction('aa'));
    results.bb = reg(actions.bb.key, () => sendAction('bb'));
    results.compact = reg(actions.compact.key, () => sendAction('compact'));
  }
  results.micmute = reg(actions.micmute.key, () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey-mute'); });
  console.log('[CA-main] registered hotkeys (coding=' + codingMode + ') -> ok:', JSON.stringify(results));
  return results;
}
ipcMain.on('send-keyword', (e, text) => sendKeyword(text));
ipcMain.on('set-mode', (e, m) => { const cm = (m === 'Live Coding'); if (cm !== codingMode) { codingMode = cm; registerHotkeys(); } });
ipcMain.handle('set-hotkeys', (e, cfg) => {
  cfg = cfg || {};
  if (cfg.send && typeof cfg.send.key === 'string') actions.send.key = cfg.send.key;
  if (cfg.aa)      { if (typeof cfg.aa.key === 'string') actions.aa.key = cfg.aa.key; if (typeof cfg.aa.label === 'string') actions.aa.label = cfg.aa.label; }
  if (cfg.bb)      { if (typeof cfg.bb.key === 'string') actions.bb.key = cfg.bb.key; if (typeof cfg.bb.text === 'string') actions.bb.text = cfg.bb.text; }
  if (cfg.compact) { if (typeof cfg.compact.key === 'string') actions.compact.key = cfg.compact.key; if (typeof cfg.compact.url === 'string') actions.compact.url = cfg.compact.url; }
  if (cfg.micmute && typeof cfg.micmute.key === 'string') actions.micmute.key = cfg.micmute.key;
  const results = registerHotkeys();
  return { ok: true, results: results, actions: actions };
});

// ---------- Chrome-extension bridge (localhost HTTP long-poll) ----------
const BRIDGE_PORT = 17632;
const BRIDGE_TOKEN = 'captionassistance-bridge-7f3a';   // shared secret; must match the extension
let bridgeServer = null;
let extLastSeen = 0;
const cmdQueue = [];
const pollWaiters = [];
let boundClient = null;   // which browser (extension instance) holds the binding; ONLY it receives commands
function extConnected() { return (Date.now() - extLastSeen) < 40000; }
function bridgeSend(res, code, obj) {
  const body = JSON.stringify(obj || {});
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(body);
}
function enqueueCommand(cmd) {
  cmdQueue.push(cmd);   // the bound extension short-polls every ~500ms and picks it up
  console.log('[CA-main] queued', cmd.type, 'queueLen', cmdQueue.length, 'boundClient', boundClient);
  dbg('ENQUEUE ' + cmd.type + ' qlen=' + cmdQueue.length + ' boundClient=' + boundClient);
  const cutoff = Date.now() - 30000;   // drop stale sends so a briefly-absent extension can't replay them
  while (cmdQueue.length && cmdQueue[0].ts < cutoff) cmdQueue.shift();
}
function startBridge() {
  try {
    bridgeServer = http.createServer((req, res) => {
      let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { bridgeSend(res, 400, {}); return; }
      if (req.method === 'OPTIONS') { bridgeSend(res, 204, {}); return; }
      if (u.searchParams.get('token') !== BRIDGE_TOKEN) { bridgeSend(res, 403, { error: 'bad token' }); return; }
      extLastSeen = Date.now();
      if (u.pathname === '/poll') {
        const client = u.searchParams.get('client') || '';
        const isBound = boundClient && client === boundClient;
        // "linked" == the server holds a binding. Same source as the extension icon (boundClient/cid), so
        // the two indicators always AGREE. The extension unbinds the moment its bound tab closes (backstop
        // below), so boundClient staying set already means a live bound tab.
        if (win && !win.isDestroyed()) win.webContents.send('gpt-status', { connected: true, bound: boundClient != null });
        const qBefore = cmdQueue.length;
        const cmds = (isBound && cmdQueue.length) ? [cmdQueue.shift()] : [];   // short poll: return immediately
        dbg('POLL client=' + client + ' boundClient=' + boundClient + ' isBound=' + !!isBound + ' qBefore=' + qBefore + ' deliver=' + cmds.length);
        if (cmds.length) console.log('[CA-main] /poll -> DELIVERING', cmds[0].type, 'to', client, '(boundClient', boundClient + ')');
        bridgeSend(res, 200, { commands: cmds, boundClient: boundClient, teleOn: teleOn, mic: teleCap, consoleOn: consoleOn, micSource: (micEngine === 'browser' ? 'system' : 'app'), engine: micEngine, speakerEngine: speakerEngine, scrollTrigger: scrollParams.trigger, scrollTarget: scrollParams.target, scrollSpeed: scrollParams.speed });
        return;
      }
      if (u.pathname === '/bind') {
        const client = u.searchParams.get('client') || '';
        const bound = u.searchParams.get('bound') === '1';
        if (bound) boundClient = client; else if (boundClient === client) boundClient = null;
        console.log('[CA-main] /bind client', client, 'bound', bound, '-> boundClient', boundClient);
        bridgeSend(res, 200, { ok: true, boundClient: boundClient });
        return;
      }
      if (u.pathname === '/result') {
        let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        req.on('end', () => { let obj = {}; try { obj = JSON.parse(body || '{}'); } catch (e) {} console.log('[CA-main] /result', JSON.stringify(obj)); dbg('RESULT ' + JSON.stringify(obj)); if (win && !win.isDestroyed()) win.webContents.send('gpt-result', obj); bridgeSend(res, 200, { ok: true }); });
        return;
      }
      if (u.pathname === '/from-ext') {   // reverse channel: the extension pushes browser mic / Chrome caption / console state
        let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => { let o = {}; try { o = JSON.parse(body || '{}'); } catch (e) {} handleFromExt(o); bridgeSend(res, 200, { ok: true }); });
        return;
      }
      if (u.pathname === '/ping') { bridgeSend(res, 200, { ok: true, app: 'caption.assistance', boundClient: boundClient }); return; }
      bridgeSend(res, 404, { error: 'not found' });
    });
    bridgeServer.on('error', (err) => { try { console.error('bridge:', err && err.message); } catch (e) {} });
    bridgeServer.listen(BRIDGE_PORT, '127.0.0.1');
  } catch (e) {}
}
function stopBridge() {
  try { while (pollWaiters.length) { const w = pollWaiters.shift(); clearTimeout(w.timer); try { bridgeSend(w.res, 200, { commands: [] }); } catch (e) {} } } catch (e) {}
  try { bridgeServer && bridgeServer.close(); } catch (e) {}
}

// The reader process continuously enforces this alpha on the Live Captions
// window (it keeps resetting itself on redraw), so the user's value sticks.
function setLcOpacity(alpha) {
  try { fs.writeFileSync(OPACITY_FILE, String(Math.max(0, Math.min(255, Math.round(alpha))))); } catch (e) {}
}
ipcMain.on('lc-opacity', (e, alpha) => setLcOpacity(alpha));
ipcMain.on('ensure-lc', () => ensureLiveCaptions());
// resize window between the large setup view and the compact caption view
ipcMain.on('resize', (e, w, h) => { if (win && !win.isDestroyed()) { try { win.setSize(Math.round(w), Math.round(h), true); } catch (err) {} } });
// this app window's own opacity — floor at 0.3 so the frameless window can't
// become unrecoverably invisible (the slider min is 20% but be safe)
ipcMain.on('app-opacity', (e, v) => { if (win && !win.isDestroyed()) { try { win.setOpacity(Math.max(0.3, Math.min(1, v))); } catch (err) {} } });

// save transcript to a file the user chooses
// ---- persistent mic-mute server (mute-server.ps1): loads the Core Audio interop ONCE, so each
// mute/unmute is instant. The old approach recompiled C# on every click (seconds) -> the button spun
// and the next click was dropped. We keep the one-shot script as a fallback if the server isn't up.
let muteSrv = null, muteRdy = false, mutePending = null;
function startMuteServer() {
  if (muteSrv || quitting) return;
  try { muteSrv = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('mute-server.ps1')], { windowsHide: true }); }
  catch (e) { console.error('[mic-mute] server spawn failed:', e && e.message); muteSrv = null; return; }
  console.log('[mic-mute] server spawned (pid ' + (muteSrv.pid || '?') + ')');
  const rl = readline.createInterface({ input: muteSrv.stdout });
  rl.on('line', (line) => {
    line = String(line || '').trim();
    if (line === 'ready') { muteRdy = true; console.log('[mic-mute] server READY (Core Audio loaded)'); return; }
    if (mutePending) { const p = mutePending; mutePending = null; clearTimeout(p.to); p.resolve(line); }   // reply to the in-flight command
  });
  let errbuf = ''; muteSrv.stderr.on('data', (d) => { errbuf += d.toString(); const i = errbuf.lastIndexOf('\n'); if (i >= 0) { console.error('[mic-mute] server stderr:', errbuf.slice(0, i).trim()); errbuf = errbuf.slice(i + 1); } });
  const die = (why) => { console.warn('[mic-mute] server exited (' + (why || '') + ') -> respawn in 1.5s'); const p = mutePending; muteSrv = null; muteRdy = false; mutePending = null; if (p) { clearTimeout(p.to); p.resolve(null); } if (!quitting) setTimeout(startMuteServer, 1500); };
  muteSrv.on('exit', (code) => die('exit ' + code)); muteSrv.on('error', (e) => die('error ' + (e && e.message)));
}
// one command at a time; returns 'muted'|'unmuted' or null (server unavailable/timeout -> caller falls back)
function muteViaServer(state, device) {
  return new Promise((resolve) => {
    if (!muteSrv || !muteRdy || mutePending) { console.log('[mic-mute] server not usable (srv=' + !!muteSrv + ' ready=' + muteRdy + ' busy=' + !!mutePending + ') -> fallback'); resolve(null); return; }
    const to = setTimeout(() => {   // hung on a bad device -> kill + respawn so it can't wedge the button
      if (mutePending) { console.warn('[mic-mute] server TIMED OUT (>3.5s) -> kill + fallback'); mutePending = null; try { muteSrv.kill(); } catch (e) {} muteSrv = null; muteRdy = false; resolve(null); }
    }, 3500);
    mutePending = { resolve, to };
    try { muteSrv.stdin.write(state + '|' + (device || '') + '\n'); } catch (e) { console.error('[mic-mute] stdin write failed:', e && e.message); clearTimeout(to); mutePending = null; resolve(null); }
  });
}
// mute/unmute at the Core Audio endpoint level (seen by every app). device='' targets ALL active mics.
ipcMain.handle('mic-mute', async (e, state, device) => {
  const st = ['on', 'off', 'toggle', 'query'].includes(state) ? state : 'toggle';
  const dev = typeof device === 'string' ? device : '';
  const t0 = Date.now();
  const fast = await muteViaServer(st, dev);
  if (fast === 'muted' || fast === 'unmuted') { console.log('[mic-mute] ' + st + ' device="' + dev + '" -> ' + fast + ' (server, ' + (Date.now() - t0) + 'ms)'); return { ok: true, muted: fast === 'muted', raw: fast }; }
  // fallback: one-shot script (recompiles C#, slower) if the server is down
  console.warn('[mic-mute] ' + st + ' device="' + dev + '" -> using one-shot fallback (server unavailable)');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('set-mic-mute.ps1'), '-State', st];
  if (dev) args.push('-Device', dev);
  return await new Promise((resolve) => {
    try {
      require('child_process').execFile('powershell.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        const out = String(stdout || '').trim().split(/\r?\n/).pop().trim();   // last line is muted|unmuted|unknown
        console.log('[mic-mute] fallback ' + st + ' -> ' + out + (err ? ' (err: ' + err.message + ')' : '') + ' (' + (Date.now() - t0) + 'ms)');
        resolve({ ok: out === 'muted' || out === 'unmuted', muted: out === 'muted', raw: out });
      });
    } catch (ex) { console.error('[mic-mute] fallback threw:', String(ex)); resolve({ ok: false, error: String(ex) }); }
  });
});
// ---- Mic caption inspector: a child window (mic-test/index.html) driven by mic-reader.exe ----
let inspectorWin = null, inspectorMic = null;
function startInspectorMic() {
  try { inspectorMic = spawn(scriptPath('mic-reader.exe'), [String(process.pid)], { windowsHide: true }); }
  catch (e) { return; }
  let buf = '';
  inspectorMic.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const o = JSON.parse(line); if (inspectorWin && !inspectorWin.isDestroyed()) inspectorWin.webContents.send('mic', o); } catch (e) {}
    }
  });
  inspectorMic.on('exit', () => { if (inspectorWin && !inspectorWin.isDestroyed()) setTimeout(startInspectorMic, 800); });   // restart the lane
}
function stopInspectorMic() { try { if (inspectorMic) inspectorMic.kill(); } catch (e) {} inspectorMic = null; }
function openInspector() {
  if (inspectorWin && !inspectorWin.isDestroyed()) { inspectorWin.focus(); return; }
  inspectorWin = new BrowserWindow({
    width: 1180, height: 800, backgroundColor: '#0f1720', title: 'Mic Read-Along Inspector',
    webPreferences: { preload: path.join(__dirname, 'mic-test', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  inspectorWin.setMenuBarVisibility(false);
  inspectorWin.loadFile(path.join(__dirname, 'mic-test', 'index.html'));
  inspectorWin.on('closed', () => { inspectorWin = null; stopInspectorMic(); if (win && !win.isDestroyed()) win.webContents.send('inspector-closed'); });
  startInspectorMic();
}
function closeInspector() { if (inspectorWin && !inspectorWin.isDestroyed()) inspectorWin.close(); }
ipcMain.on('toggle-inspector', (e, on) => { if (on) openInspector(); else closeInspector(); });

// ---- Microphone source: ONE WinRT recognizer feeds BOTH (1) the live 'mic' caption source shown in
// the caption window, AND (2) the clean teleprompter accumulation (when GPT auto scroll is on). Runs
// for the whole app session so "capture both" is always available; the caption window filters the view. ----
let teleOn = false, micReader = null, teleCommitted = '', telePartial = '', teleLastEmit = 0;
let teleCap = { text: '', status: 'partial', seq: 0 };
let consoleOn = false;   // show the on-page read-along test console in the bound ChatGPT tab (off by default)
function startMicReader() {
  if (micReader || quitting) return;
  try { micReader = spawn(scriptPath('mic-reader.exe'), [String(process.pid)], { windowsHide: true }); }
  catch (e) { return; }
  let buf = '';
  micReader.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || o.text == null) continue;
      if (micEngine !== 'browser') continue;   // WinRT reader is only the browser-mode fallback; local/cloud drive their own
      // (1) live 'mic' caption source -> the caption window (tagged so it can be filtered / merged)
      if (win && !win.isDestroyed() && (o.status === 'partial' || o.status === 'final')) {
        win.webContents.send('caption', { src: 'mic', status: o.status, text: o.text });
      }
      // (2) teleprompter clean accumulation (only while GPT auto scroll is on)
      if (teleOn) feedTele(o.text, o.status);
    }
  });
  micReader.on('exit', () => { micReader = null; if (!quitting && !micReaderPaused) setTimeout(startMicReader, 800); });
  micReader.on('error', () => { micReader = null; });
}
// shared teleprompter accumulation: complete utterances append, partials replace the tail, a >2.5s gap
// starts a fresh reading window. Fed by the WinRT reader (system mode) OR the renderer (cloud modes).
function feedTele(text, status) {
  if (!teleOn) return;
  const now = Date.now();
  if (teleLastEmit && now - teleLastEmit > 2500) { teleCommitted = ''; telePartial = ''; }
  teleLastEmit = now;
  if (status === 'final') { const t = String(text || '').trim(); if (t) teleCommitted += (teleCommitted ? ' ' : '') + t; telePartial = ''; }
  else telePartial = String(text || '').trim();
  if (teleCommitted.length > 2000) teleCommitted = teleCommitted.slice(-2000);
  teleCap = { text: (teleCommitted + ' ' + telePartial).trim(), status: 'partial', seq: teleCap.seq + 1 };
}
ipcMain.on('set-teleprompter', (e, on) => {
  teleOn = !!on;
  if (!teleOn) { teleCommitted = ''; telePartial = ''; }
  console.log('[CA-main] teleprompter', teleOn ? 'ON' : 'off');
});
ipcMain.handle('get-keys', () => transcribeKeys());
ipcMain.handle('save-key', (e, engine, key) => {   // save a pasted API key to its local file (app writes it, so no restart needed)
  const files = { openai: 'openai-key.txt', deepgram: 'deepgram-key.txt', elevenlabs: 'elevenlabs-key.txt', speechmatics: 'speechmatics-key.txt' };
  const f = files[engine]; if (!f || !key) return { ok: false };
  let dir = __dirname; try { dir = app.getPath('userData'); } catch (er) {}   // writable + persistent (the asar is read-only when packaged)
  try { fs.writeFileSync(path.join(dir, f), String(key).trim() + '\n'); return { ok: true }; } catch (err) { return { ok: false, error: String(err) }; }
});
// ---- Local GPU STT (RealtimeSTT / faster-whisper on CUDA) via a Python subprocess per source ----
function pythonExe() {
  for (const p of ['C:\\Python\\Python312\\python.exe', 'python']) { if (p === 'python' || fs.existsSync(p)) return p; }
  return 'python';
}
let localFail = { mic: 0, speaker: 0 };   // consecutive fast-crash counter (prevents an infinite respawn -> OOM)
function spawnLocalStt(src, deviceName) {
  const args = ['-u', scriptPath('stt-local.py'), '--src', src];
  if (src === 'mic' && deviceName) args.push('--device', deviceName);
  let ps; try { ps = spawn(pythonExe(), args, { windowsHide: true, cwd: __dirname }); } catch (e) { console.error('[CA-main] local STT spawn failed', e && e.message); return null; }
  const startedAt = Date.now(); let gotReady = false, buf = '';
  ps.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || o.status == null) continue;
      if (o.status === 'error') { console.error('[CA-main] local STT ' + src + ' error:', o.text); if (win && !win.isDestroyed()) win.webContents.send('engine-status', { engine: 'local', src: src, state: 'error', detail: o.text }); continue; }
      if (o.status === 'ready') { gotReady = true; localFail[src] = 0; if (win && !win.isDestroyed()) win.webContents.send('engine-status', { engine: 'local', src: src, state: 'live' }); continue; }
      if (o.status === 'partial' || o.status === 'final') {
        if (win && !win.isDestroyed()) win.webContents.send('caption', { src: src, status: o.status, text: o.text });
        if (src === 'mic' && teleOn) feedTele(o.text, o.status);
      }
    }
  });
  ps.stderr.on('data', () => {});
  ps.on('exit', () => {
    // CRITICAL guard: only respawn if THIS process is still the tracked one. When we kill a process on
    // purpose (engine switch / mic change) localStt[src] is set to null or a new proc first, so this is
    // false and we DON'T respawn -> prevents the duplicate-process bug (two Vosk instances transcribing
    // the same audio, which looked like "captions from multiple models").
    if (localStt[src] !== ps) return;
    localStt[src] = null;
    const wantLocal = (src === 'mic') ? (micEngine === 'local') : (speakerEngine === 'local');
    if (!wantLocal || quitting) return;
    if (!gotReady && Date.now() - startedAt < 12000) {   // crashed before it ever went live (e.g. ctranslate2 illegal-instruction)
      localFail[src] = (localFail[src] || 0) + 1;
      if (localFail[src] >= 3) {   // STOP -> never loop-respawn a crashing process
        if (win && !win.isDestroyed()) win.webContents.send('engine-status', { engine: 'local', src: src, state: 'error', detail: 'local model keeps crashing on this machine — use Chrome speech or a cloud engine instead' });
        return;
      }
    } else { localFail[src] = 0; }
    setTimeout(() => { const w = (src === 'mic') ? (micEngine === 'local') : (speakerEngine === 'local'); if (w && localStt[src] == null) localStt[src] = spawnLocalStt(src, deviceName); }, 2500);
  });
  ps.on('error', (e) => console.error('[CA-main] local STT ' + src + ' proc error', e && e.message));
  return ps;
}
// null the reference BEFORE killing so the exit handler's guard sees it's intentional and won't respawn
function killLocal(src) { const ps = localStt[src]; localStt[src] = null; try { if (ps) ps.kill(); } catch (e) {} }
function stopLocalStt() { killLocal('mic'); killLocal('speaker'); }
// spawn a Vosk process ONLY for the sources set to 'local' (idempotent: never double-spawns)
function reconcileLocalStt() {
  if (micEngine === 'local') { if (!localStt.mic) localStt.mic = spawnLocalStt('mic', currentMicName); } else killLocal('mic');
  if (speakerEngine === 'local') { if (!localStt.speaker) localStt.speaker = spawnLocalStt('speaker', ''); } else killLocal('speaker');
}
let currentMicName = '';   // last mic name the renderer picked (so local STT captures the right device)
// only RESTART THE MIC (not the speaker) and only when the device actually changed -> no needless respawns
ipcMain.on('set-mic-name', (e, name) => { name = name || ''; if (name === currentMicName) return; currentMicName = name; if (micEngine === 'local') { killLocal('mic'); localStt.mic = spawnLocalStt('mic', currentMicName); } });
// reconcile everything to the current (speakerEngine, micEngine). LC reader runs in every mode (opacity +
// the speaker=system caption source); WinRT mic-reader is the browser-mode fallback; Vosk per local source.
function applyEngines() {
  console.log('[CA-main] engines  speaker=' + speakerEngine + '  mic=' + micEngine);
  readerPaused = false;
  startReader();
  micReaderPaused = (micEngine !== 'browser');
  if (micReaderPaused) { try { if (micReader) micReader.kill(); } catch (err) {} } else startMicReader();
  reconcileLocalStt();
}
ipcMain.on('set-engines', (e, cfg) => {
  cfg = cfg || {};
  speakerEngine = ['system', 'local', 'deepgram', 'elevenlabs', 'speechmatics'].includes(cfg.speaker) ? cfg.speaker : 'system';
  micEngine = ['browser', 'local', 'deepgram', 'elevenlabs', 'speechmatics'].includes(cfg.mic) ? cfg.mic : 'browser';
  applyEngines();
});
// cloud MIC transcript from the renderer -> same teleprompter accumulation the WinRT reader uses
ipcMain.on('tele-feed', (e, text, status) => feedTele(text, status));
// reverse channel from the extension (Chrome speech mic, browser mic name, console close)
function handleFromExt(o) {
  if (!o || !o.type || !win || win.isDestroyed()) return;
  if (o.type === 'mic-caption') win.webContents.send('caption', { src: 'mic', status: o.status || 'partial', text: String(o.text || ''), from: 'chrome' });
  else if (o.type === 'browser-mic') win.webContents.send('browser-mic', { label: String(o.label || '') });
  else if (o.type === 'console-closed') { consoleOn = false; win.webContents.send('console-closed'); }
  else if (o.type === 'toggle-autoscroll') { win.webContents.send('toggle-autoscroll'); }
}
// one-click setup for the Local GPU engine (torch + RealtimeSTT + faster-whisper), streaming progress
ipcMain.handle('install-local', () => new Promise((resolve) => {
  let ps; try { ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('install-local.ps1')], { windowsHide: true }); }
  catch (err) { resolve({ ok: false, error: String(err) }); return; }
  const send = (l) => { const t = (l || '').trim(); if (t && win && !win.isDestroyed()) win.webContents.send('install-progress', t); };
  readline.createInterface({ input: ps.stdout }).on('line', send);
  readline.createInterface({ input: ps.stderr }).on('line', send);
  ps.on('exit', (code) => resolve({ ok: code === 0 }));
  ps.on('error', (err) => resolve({ ok: false, error: String(err) }));
}));
ipcMain.on('set-console', (e, on) => { consoleOn = !!on; console.log('[CA-main] read-along test console', consoleOn ? 'ON' : 'off'); });
// auto-scroll tuning (fractions of the viewport): trigger a scroll when the read line is >= trigger down,
// then scroll it to `target`. Forwarded to the bound tab via the poll -> SmartScroller.
let scrollParams = { trigger: 0.57, target: 0.35, speed: 1.5 };   // speed = read-along scroll animation multiplier (1 = base, 1.5 = 50% faster)
ipcMain.on('set-scroll-params', (e, p) => {
  p = p || {};
  const clamp = (v, d) => (typeof v === 'number' && v > 0.05 && v < 0.98) ? v : d;
  scrollParams.trigger = clamp(p.trigger, scrollParams.trigger);
  scrollParams.target = clamp(p.target, scrollParams.target);
  if (scrollParams.target > scrollParams.trigger) scrollParams.target = scrollParams.trigger;   // target must be above the trigger
  if (typeof p.speed === 'number' && p.speed >= 0.3 && p.speed <= 4) scrollParams.speed = p.speed;
  console.log('[CA-main] auto-scroll params trigger=' + scrollParams.trigger + ' target=' + scrollParams.target + ' speed=' + scrollParams.speed);
});
// make the chosen mic the Windows DEFAULT recording device so the WinRT recognizer captures IT (not a
// room/camera mic that only hears the speakers), then restart the reader to pick up the new default.
function restartMicReader() { try { if (micReader) micReader.kill(); } catch (e) {} }   // exit handler auto-restarts it
ipcMain.handle('set-default-mic', async (e, id) => {
  if (!id) return { ok: false };
  return await new Promise((resolve) => {
    try {
      require('child_process').execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('set-default-mic.ps1'), '-Id', String(id)],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => { const ok = String(stdout || '').trim().split(/\r?\n/).pop().trim() === 'ok'; if (ok) restartMicReader(); resolve({ ok: ok }); });
    } catch (ex) { resolve({ ok: false, error: String(ex) }); }
  });
});

// enumerate active capture devices (Core Audio friendly names -> authoritative for muting)
ipcMain.handle('mic-list', async () => {
  return await new Promise((resolve) => {
    try {
      require('child_process').execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('set-mic-mute.ps1'), '-State', 'list'],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          let arr = [];
          try { const p = JSON.parse(String(stdout || '').trim() || '[]'); arr = Array.isArray(p) ? p : (p ? [p] : []); } catch (e) {}
          resolve(arr);
        });
    } catch (ex) { resolve([]); }
  });
});
ipcMain.handle('save-file', async (e, text) => {
  let filePath, canceled;
  try { ({ canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: 'live-captions.txt', filters: [{ name: 'Text file', extensions: ['txt'] }] })); }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  if (canceled || !filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(filePath, text, 'utf8'); return { ok: true }; }
  catch (err) { try { dialog.showErrorBox('Save failed', String(err && err.message || err)); } catch (e2) {} return { ok: false, error: String(err && err.message || err) }; }
});
