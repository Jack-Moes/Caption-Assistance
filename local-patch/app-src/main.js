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
// mic: windows(WinRT speech, free+offline) | browser(Chrome speech, works with NewCoo) | local(Vosk) | deepgram | elevenlabs | speechmatics.
let speakerEngine = 'system';
let micEngine = 'windows';
// The WinRT mic-reader is a first-class engine ('windows'), not just the browser-mode fallback: it needs no
// Python, no key and no network, and it reads the mic through the same Windows audio stack Core Audio uses --
// so it works on machines where PyAudio (Vosk) cannot even see the capture device.
let micReaderPaused = false;
let readerPaused = false;     // Live Captions reader paused when a non-system engine is active
let localStt = { mic: null, speaker: null };   // local GPU (RealtimeSTT) subprocesses, one per source

// The LAN subnet gate (192.168.5.*) was removed: it exited before createWindow, so on any other
// network the app just died silently with no window and no error. This is a local-only build.

// Distribution telemetry is intentionally disabled in this local build.
// No build ID, hostname, Windows username, or local IP addresses are sent at startup.

let win = null;
let reader = null;
let restartTimer = null;
let quitting = false;
let userAlwaysOnTopState = false;   // controlled only by the eye panel's Keep window on top switch
let alwaysOnTopState = false;       // effective top-most state used by raiseWindow()

// Privacy mode deliberately uses only documented Electron/Windows window controls.
// Click-through is runtime-only and never persisted, so a restart always recovers mouse control.
const PRIVACY_DEFAULTS = Object.freeze({
  enabled: false,
  captureProtected: true,
  clickHotkey: 'CommandOrControl+Shift+X'
});
let privacyConfig = Object.assign({}, PRIVACY_DEFAULTS);
let privacyRuntime = { clickThrough: false };
let privacyHotkeyResults = { click: false };
let privacyForcedOff = !!process.env.CAPTIONASSISTANCE_NOSTEALTH || process.argv.includes('--privacy-off');
let taskbarPolicyTimer = null;

function cleanPrivacyConfig(value) {
  value = value && typeof value === 'object' ? value : {};
  const key = (name) => {
    const v = typeof value[name] === 'string' ? value[name].trim() : '';
    return v && v.length <= 80 ? v : PRIVACY_DEFAULTS[name];
  };
  return {
    enabled: privacyForcedOff ? false : value.enabled === true,
    captureProtected: value.captureProtected !== false,
    clickHotkey: key('clickHotkey')
  };
}
function privacyConfigPath() { return path.join(app.getPath('userData'), 'privacy.json'); }
function loadPrivacyConfig() {
  try { privacyConfig = cleanPrivacyConfig(JSON.parse(fs.readFileSync(privacyConfigPath(), 'utf8'))); }
  catch (e) { privacyConfig = cleanPrivacyConfig(PRIVACY_DEFAULTS); }
}
function savePrivacyConfig() {
  try {
    const p = privacyConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(privacyConfig, null, 2), 'utf8');
  } catch (e) { console.error('[CA-main] privacy settings save failed:', e && e.message); }
}
function privacyActive() { return privacyConfig.enabled && !privacyForcedOff; }
function privacyState() {
  return {
    config: Object.assign({}, privacyConfig, { enabled: privacyActive() }),
    runtime: Object.assign({}, privacyRuntime),
    hotkeys: Object.assign({}, privacyHotkeyResults),
    forcedOff: privacyForcedOff
  };
}
function sendPrivacyState() {
  if (win && !win.isDestroyed()) { try { win.webContents.send('privacy-state', privacyState()); } catch (e) {} }
}
function applyTopPolicy() {
  alwaysOnTopState = !!userAlwaysOnTopState;
  if (!win || win.isDestroyed()) return;
  try { win.setAlwaysOnTop(alwaysOnTopState, alwaysOnTopState ? 'screen-saver' : 'normal'); } catch (e) {}
}
function enforceTaskbarPolicy() {
  if (!win || win.isDestroyed()) return;
  try { win.setSkipTaskbar(privacyActive()); } catch (e) {}
}
function scheduleTaskbarPolicy() {
  enforceTaskbarPolicy();
  if (taskbarPolicyTimer) clearTimeout(taskbarPolicyTimer);
  // Windows can rebuild the taskbar entry after show/restore/focus has completed.
  // Re-assert once after that native window-style transition settles.
  taskbarPolicyTimer = setTimeout(() => {
    taskbarPolicyTimer = null;
    enforceTaskbarPolicy();
  }, 160);
}
function showPrivacyAwareWindow(focus) {
  if (!win || win.isDestroyed()) return;
  enforceTaskbarPolicy();
  try { if (win.isMinimized()) win.restore(); } catch (e) {}
  try { win.show(); } catch (e) {}
  if (focus && !privacyRuntime.clickThrough) { try { win.focus(); } catch (e) {} }
  scheduleTaskbarPolicy();
}
function applyPrivacyWindows() {
  const active = privacyActive();
  const capture = active && privacyConfig.captureProtected;
  if (splash && !splash.isDestroyed()) { try { splash.setContentProtection(capture); } catch (e) {} }
  if (!win || win.isDestroyed()) return;
  if (!active) {
    privacyRuntime.clickThrough = false;
    try { win.setIgnoreMouseEvents(false); } catch (e) {}
    try { win.setFocusable(true); } catch (e) {}
    try { win.setContentProtection(false); } catch (e) {}
  } else {
    try { win.setContentProtection(capture); } catch (e) {}
    try {
      if (privacyRuntime.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    } catch (e) {}
    try { win.setFocusable(!privacyRuntime.clickThrough); } catch (e) {}
  }
  applyTopPolicy();
  // Apply this LAST: setFocusable/setAlwaysOnTop can update native extended styles.
  scheduleTaskbarPolicy();
  sendPrivacyState();
}
function setPrivacyClickThrough(on) {
  if (!privacyActive() || !privacyHotkeyResults.click) return false;
  privacyRuntime.clickThrough = !!on;
  console.log('[CA-main] privacy click-through ->', privacyRuntime.clickThrough);
  applyPrivacyWindows();
  return true;
}
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
    try { splash.setContentProtection(privacyActive() && privacyConfig.captureProtected); } catch (e) {}
    splash.loadFile(path.join(__dirname, 'images', 'splash.html'));
    splash.webContents.on('did-finish-load', () => { try { splash.webContents.executeJavaScript('var _v=document.getElementById("ver"); if(_v) _v.textContent=' + JSON.stringify('v' + app.getVersion()) + ';'); } catch (e) {} });
    splash.on('closed', () => { splash = null; });
    splashAt = Date.now();
  } catch (e) { splash = null; }
}
function closeSplash() { if (splash && !splash.isDestroyed()) { try { splash.close(); } catch (e) {} } splash = null; }
// Show the branded splash only until the main window is actually ready. The old fixed 5 s hold added
// five seconds of dead time to every launch; 700 ms is enough to avoid a bare flash on a fast machine.
function revealMain() {
  if (revealScheduled) return;
  revealScheduled = true;
  const wait = Math.max(0, 700 - (Date.now() - (splashAt || Date.now())));
  setTimeout(() => {
    try { if (win && !win.isDestroyed() && !win.isVisible()) showPrivacyAwareWindow(false); } catch (e) {}
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
    alwaysOnTop: false,
    skipTaskbar: privacyActive(),
    show: false,                 // revealed on ready-to-show so the splash shows first, not a white blank
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'   // let session-replay audio load/seek/play without a gesture (fixes MediaRecorder webm duration probe)
    }
  });
  win.once('ready-to-show', revealMain);   // reveals after the short minimum above
  setTimeout(revealMain, 6000);            // fallback: never leave the window hidden if ready-to-show is missed
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { if (taskbarPolicyTimer) { clearTimeout(taskbarPolicyTimer); taskbarPolicyTimer = null; } win = null; });
  // Re-assert topmost whenever we regain focus, so we surface above another
  // WS_EX_TOPMOST window (e.g. a browser forced on-top by WindowsTop.exe). Covers
  // Alt+Tab / taskbar activation; mouse clicks are also covered by 'win-raise'.
  win.on('show', scheduleTaskbarPolicy);
  win.on('restore', scheduleTaskbarPolicy);
  win.on('focus', () => { raiseWindow(); scheduleTaskbarPolicy(); });
  applyPrivacyWindows();
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
  // Drop the handle BEFORE killing. The old process's exit handler checks whether it is still the
  // tracked reader, so an intentional kill can no longer schedule its own restart -- that is how two
  // readers ended up fighting over the same Live Captions window. Same guard spawnLocalStt() uses.
  const previous = reader; reader = null;
  try { if (previous) previous.kill(); } catch (e) {}
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
  const restart = () => {
    if (reader !== ps) return;   // superseded on purpose -> this exit is expected, do not respawn
    reader = null;
    if (!quitting && !readerPaused && win && !win.isDestroyed()) { clearTimeout(restartTimer); restartTimer = setTimeout(startReader, 1000); }
  };
  ps.on('exit', restart);     // reader died -> back off and restart while the app is open
  ps.on('error', restart);    // spawn failed asynchronously (no listener would crash the app)
}

// only allow one instance so windows don't stack up
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const explicitRecovery = (argv || []).includes('--show') || (argv || []).includes('--privacy-off');
    if (explicitRecovery) {
      if ((argv || []).includes('--privacy-off')) privacyForcedOff = true;
      privacyRuntime.clickThrough = false;
      applyPrivacyWindows();
    }
    if (win) showPrivacyAwareWindow(true);
  });
  app.whenReady().then(async () => {
    loadPrivacyConfig();
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
ipcMain.on('win-top', (e, val) => { userAlwaysOnTopState = !!val; applyTopPolicy(); });
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
// Backward-compatible bridge for older renderer builds. New builds use set-privacy below.
ipcMain.on('set-stealth', (e, on) => {
  privacyConfig.enabled = !privacyForcedOff && !!on;
  privacyConfig.captureProtected = true;
  if (!privacyConfig.enabled) privacyRuntime.clickThrough = false;
  savePrivacyConfig();
  registerHotkeys();
  applyPrivacyWindows();
});
ipcMain.handle('get-privacy', () => privacyState());
ipcMain.handle('set-privacy', (e, cfg) => {
  // Always leave click-through before changing/re-registering its recovery key.
  privacyRuntime.clickThrough = false;
  privacyConfig = cleanPrivacyConfig(Object.assign({}, privacyConfig, cfg || {}));
  if (!privacyActive()) privacyRuntime.clickThrough = false;
  savePrivacyConfig();
  registerHotkeys();
  applyPrivacyWindows();
  return privacyState();
});
ipcMain.handle('privacy-action', (e, action) => {
  let ok = false;
  if (action === 'toggle-click') ok = setPrivacyClickThrough(!privacyRuntime.clickThrough);
  else if (action === 'click-off') ok = setPrivacyClickThrough(false);
  return { ok: ok, state: privacyState() };
});
ipcMain.on('clip', (e, text) => clipboard.writeText(text || ''));

// ---- Send the caption selection to ChatGPT via the Chrome-extension bridge ----
// doSendChatGPT queues a command; the "Caption assistance Bridge" extension long-polls the
// local server below, then types the text into the chatgpt.com tab and submits it.
let answerInApp = false;
let gptRequestSeq = 0;
let currentGptRequest = null;   // authoritative in-flight request; survives extension service-worker restarts while the app is open
function emitGptStatus(status) {
  if (win && !win.isDestroyed()) win.webContents.send('gpt-status', status || {});
}
function emitGptResult(result) {
  if (win && !win.isDestroyed()) win.webContents.send('gpt-result', result || {});
}
function doSendChatGPT(text, actionId, submit, focus) {
  text = (text || '').toString().trim();
  console.log('[CA-main] doSendChatGPT len', text.length, '| extConnected', extConnected());
  dbg('doSend textlen=' + text.length);
  if (!text) { console.log('[CA-main] empty selection -> nothing queued'); dbg('  EMPTY -> not queued'); return; }
  const wantsAnswer = !!answerInApp && submit !== false;
  const shouldFocus = (focus == null) ? !wantsAnswer : focus !== false;
  const requestId = Date.now().toString(36) + '-' + (++gptRequestSeq).toString(36);
  if (wantsAnswer && currentGptRequest && ['queued', 'delivered', 'submitted', 'generating', 'recovering'].includes(currentGptRequest.state)) {
    console.log('[CA-main] ignored duplicate send while request is active:', currentGptRequest.requestId);
    dbg('SEND BLOCKED active=' + currentGptRequest.requestId);
    return;
  }
  if (wantsAnswer && currentGptRequest && currentGptRequest.sent && currentGptRequest.text === text && Date.now() - currentGptRequest.ts < 60000) {
    emitGptResult({ ok: false, error: 'This same question may already have been sent. Use Refresh instead of sending it again.', code: 'duplicate-risk', requestId: currentGptRequest.requestId, returnToApp: true, actionId: currentGptRequest.actionId });
    return;
  }
  if (wantsAnswer) currentGptRequest = { requestId, text, actionId: actionId || 'send', state: 'queued', ts: Date.now(), recoveries: 0 };
  emitGptStatus({ connected: extConnected(), bound: boundClient != null, justSent: true, action: actionId || 'send', requestId, returnToApp: wantsAnswer, phase: 'queued' });
  if (!extConnected() || !boundClient) {
    const error = !extConnected() ? 'Caption assistance Bridge is not connected.' : 'No ChatGPT tab is bound. Bind one ChatGPT tab first.';
    if (currentGptRequest && currentGptRequest.requestId === requestId) currentGptRequest.state = 'error';
    emitGptResult({ ok: false, error, code: !extConnected() ? 'bridge-offline' : 'no-bound-tab', requestId, returnToApp: wantsAnswer, actionId: actionId || 'send' });
    return;
  }
  if (shouldFocus) allowForeground();
  // 5 s was too tight: a sleeping MV3 service worker can take longer than that to reconnect its /wait,
  // and the command then expired instead of being delivered. Delivery itself is still instant.
  enqueueCommand({ type: 'send', text: text, submit: submit !== false, focus: shouldFocus, returnToApp: wantsAnswer, requestId: requestId, actionId: actionId || 'send', ts: Date.now(), expiresAt: Date.now() + 15000 });
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
ipcMain.on('set-answer-in-app', (e, on) => { answerInApp = !!on; });
ipcMain.on('reset-gpt-session', () => { currentGptRequest = null; });
ipcMain.on('recover-gpt', () => {
  const r = currentGptRequest;
  if (!r || !r.requestId || !r.text) {
    emitGptResult({ ok: false, error: 'There is no recent ChatGPT request to recover.', code: 'no-request', requestId: '', returnToApp: true });
    return;
  }
  if (!extConnected() || !boundClient) {
    emitGptResult({ ok: false, error: !extConnected() ? 'Caption assistance Bridge is not connected.' : 'No ChatGPT tab is bound.', code: !extConnected() ? 'bridge-offline' : 'no-bound-tab', requestId: r.requestId, returnToApp: true });
    return;
  }
  if (r.state === 'recovering') return;
  r.state = 'recovering'; r.recoveries = (r.recoveries || 0) + 1;
  emitGptStatus({ connected: true, bound: true, requestId: r.requestId, returnToApp: true, phase: 'recovering' });
  enqueueCommand({ type: 'recover', text: r.text, submit: true, focus: false, returnToApp: true, requestId: r.requestId, actionId: r.actionId, recovery: r.recoveries, ts: Date.now(), expiresAt: Date.now() + 8000 });
});
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
  latest:  { key: '' },                // select the latest transcript sentence in the app; never sends it
  compact: { key: '', url: '' },  // open a fresh ChatGPT window at this URL + move the history there
  micmute: { key: '' },             // toggle system mic mute (handled in the renderer so it uses the chosen device)
  clip:    { key: '' },             // send whatever is on the clipboard (a pasted problem statement, a chat message)
  ocr:     { key: '' }              // read the foreground window with the Windows OCR engine and send that
};
async function sendAction(id, suppliedSelection) {
  console.log('[CA-main] sendAction:', id);
  dbg('sendAction ' + id);
  if (id === 'compact') {
    if (!extConnected() || !boundClient) {
      emitGptResult({ ok: false, error: !extConnected() ? 'Caption assistance Bridge is not connected.' : 'No ChatGPT tab is bound.', code: !extConnected() ? 'bridge-offline' : 'no-bound-tab', returnToApp: false, actionId: 'compact' });
      return;
    }
    enqueueCommand({ type: 'compact', url: (actions.compact.url || ''), ts: Date.now() });
    if (win && !win.isDestroyed()) { win.webContents.send('gpt-status', { connected: extConnected(), justSent: true, action: 'compact' }); win.webContents.send('advance-selection', 'compact'); }
    return;
  }
  if (id === 'ocr') {
    // A coding problem is on screen, never in the audio, so no transcript selection can ever contain it.
    // Read whatever window the user is looking at. Windows' own OCR engine: no install, key or network.
    if (win && !win.isDestroyed() && win.isFocused()) {
      emitGptResult({ ok: false, error: 'Bring the window you want to read to the front first - Caption assistance itself is focused.', code: 'ocr-self', returnToApp: false, actionId: 'ocr' });
      return;
    }
    const out = await readScreenText();
    if (!out.ok) {
      emitGptResult({ ok: false, error: 'Could not read the screen: ' + out.error, code: 'ocr-failed', returnToApp: false, actionId: 'ocr' });
      return;
    }
    doSendChatGPT(out.text, 'ocr', true);
    return;
  }
  if (id === 'clip') {
    // Not every question is spoken: coding problems and chat messages are read off the screen. The
    // clipboard is the cheapest way in, and it needs no selection in the transcript.
    const clipText = (clipboard.readText() || '').trim();
    if (!clipText) {
      emitGptResult({ ok: false, error: 'The clipboard is empty - copy the question or problem statement first.', code: 'clipboard-empty', returnToApp: false, actionId: 'clip' });
      return;
    }
    doSendChatGPT(withContext(clipText), 'clip', true);
    return;
  }
  let text = '', submit = true;
  const selectionRequired = id === 'send' || id === 'paste' || id === 'aa' || id === 'simple';
  const sel = selectionRequired
    ? (typeof suppliedSelection === 'string' ? suppliedSelection.trim() : (await getSelectionText()).trim())
    : '';
  if (selectionRequired && !sel) {
    emitGptResult({ ok: false, error: 'Select a question first, or press Latest.', code: 'selection-required', returnToApp: false, actionId: id });
    return;
  }
  if (id === 'send') { text = withContext(sel); }
  else if (id === 'paste') { text = sel; submit = false; }   // edit-before-send: paste only, no submit
  else if (id === 'aa') { const label = (actions.aa.label || 'aa'); text = withContext(label + '\n' + sel); }
  else if (id === 'simple') { const label = (actions.simple.label || 'ss'); text = withContext(label + '\n' + sel); }
  else if (id === 'bb') { text = (actions.bb.text || 'bb'); }
  console.log('[CA-main] action', id, '-> text length', text.length, 'submit', submit);
  dbg('  ' + id + ' built textlen=' + text.length);
  doSendChatGPT(text, id, submit);   // Answer-in-app decides whether the bound ChatGPT tab may take focus.
  // bb/zz sends a fixed keyword (not the selection) -> leave the selection untouched
  if (id !== 'bb' && win && !win.isDestroyed()) win.webContents.send('advance-selection', id);
}
ipcMain.on('send-action', (e, id, selectedText) => sendAction(id, selectedText));
// Run the bundled OCR reader over the foreground window. Resolves { ok, text } or { ok:false, error }.
const OCR_MAX_CHARS = 4000;   // a full window can carry a lot of chrome; keep the prompt sane
function readScreenText() {
  return new Promise((resolve) => {
    let ps;
    try { ps = spawn(scriptPath('ocr-reader.exe'), [], { windowsHide: true, cwd: scriptsDir }); }
    catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); return; }
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) {} finish({ ok: false, error: 'the screen reader timed out' }); }, 15000);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: String((e && e.message) || e) }); });
    ps.on('close', () => {
      clearTimeout(timer);
      let o = null;
      const raw = String(out);
      const brace = raw.lastIndexOf('{');
      try { if (brace >= 0) o = JSON.parse(raw.slice(brace)); } catch (e) {}
      if (!o) { finish({ ok: false, error: 'the screen reader returned nothing' }); return; }
      if (!o.ok) { finish({ ok: false, error: String(o.error || 'unknown') }); return; }
      const text = String(o.text || '').trim();
      if (!text) { finish({ ok: false, error: 'no text was found in that window' }); return; }
      finish({ ok: true, text: text.length > OCR_MAX_CHARS ? text.slice(0, OCR_MAX_CHARS) : text });
    });
  });
}

// default prompts page: read the bundled prompts/*.txt (resources/prompts when packaged, ./prompts in dev)

// ---- Local context: resume / job description / round notes, kept as plain files ----
// The bundled prompt used to carry the candidate's background inline, so changing CV meant editing the
// prompt. Keep it as data in userData\context instead and attach only the parts a given question needs.
// Pure keyword scoring: no embeddings, no vector store, no network -- these documents are tens of KB.
const CONTEXT_MAX_CHUNKS = 4;
const CONTEXT_MAX_CHARS = 1800;
let contextEnabled = true;
let contextCache = { at: 0, chunks: [] };
function contextDir() { return path.join(app.getPath('userData'), 'context'); }
const CTX_STOP = new Set(('a an the and or but if then than that this these those of in on at to for with by from as is are was were be been being do does did have has had i me my we our you your it its they them their he she his her not no so very can could would should will just about into over under more most other some such only own same too what which who whom when where why how all any both each few').split(' '));
function ctxTokens(text) {
  const out = [];
  const parts = String(text || '').toLowerCase().split(/[^a-z0-9+#.]+/);
  for (const w of parts) {
    const t = w.replace(/^[.]+|[.]+$/g, '');
    if (t.length > 1 && !CTX_STOP.has(t)) out.push(t);
  }
  return out;
}
function loadContextChunks() {
  const now = Date.now();
  if (contextCache.chunks.length && now - contextCache.at < 5000) return contextCache.chunks;
  const dir = contextDir();
  const chunks = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).sort(); } catch (e) { files = []; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    // Strip CR first: files written on Windows (Notepad, most editors) separate paragraphs with CRLF,
    // so splitting on bare newlines matched nothing and the whole document collapsed into one chunk.
    const NLC = String.fromCharCode(10);
    const flat = text.split(String.fromCharCode(13)).join('');
    for (const para of flat.split(NLC + NLC)) {
      const t = para.trim();
      if (t.length < 24) continue;                 // headings and stray lines carry no answerable detail
      chunks.push({ file: f, text: t.length > 600 ? t.slice(0, 600) : t, tokens: ctxTokens(t) });
    }
  }
  // Rare terms identify a relevant paragraph; words repeated across the whole CV do not.
  const df = Object.create(null);
  for (const c of chunks) for (const t of new Set(c.tokens)) df[t] = (df[t] || 0) + 1;
  const N = chunks.length || 1;
  for (const c of chunks) {
    c.weight = Object.create(null);
    for (const t of new Set(c.tokens)) c.weight[t] = Math.log(1 + N / (df[t] || 1));
  }
  contextCache = { at: now, chunks: chunks };
  return chunks;
}
function pickContext(question) {
  const chunks = loadContextChunks();
  if (!chunks.length) return { chunks: [], text: '' };
  const q = new Set(ctxTokens(question));
  if (!q.size) return { chunks: [], text: '' };
  const scored = [];
  for (const c of chunks) {
    let score = 0, hits = 0;
    for (const t of q) if (c.weight[t] != null) { score += c.weight[t]; hits++; }
    if (hits) scored.push({ file: c.file, text: c.text, score: score / Math.sqrt(c.tokens.length || 1), hits: hits });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let chars = 0;
  for (const c of scored) {
    if (picked.length >= CONTEXT_MAX_CHUNKS || chars + c.text.length > CONTEXT_MAX_CHARS) break;
    picked.push(c);
    chars += c.text.length;
  }
  const NLC = String.fromCharCode(10);
  const body = picked.map((c) => c.text).join(NLC + NLC);
  return { chunks: picked, text: body };
}
// Attach AFTER the question: the prompts key off a leading keyword line, so nothing may precede it.
function withContext(text) {
  if (!contextEnabled) return text;
  let picked;
  try { picked = pickContext(text); } catch (e) { return text; }
  if (!picked.text) return text;
  const NLC = String.fromCharCode(10);
  return text + NLC + NLC + '--- my background (context, do not quote verbatim) ---' + NLC + picked.text;
}
ipcMain.handle('get-context', () => {
  const dir = contextDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).sort().map((f) => {
      let chars = 0;
      try { chars = fs.readFileSync(path.join(dir, f), 'utf8').length; } catch (e) {}
      return { name: f, chars: chars };
    });
  } catch (e) {}
  return { dir: dir, enabled: contextEnabled, files: files, chunks: loadContextChunks().length };
});
ipcMain.handle('set-context-enabled', (e, on) => { contextEnabled = !!on; return contextEnabled; });
ipcMain.handle('preview-context', (e, question) => {
  contextCache = { at: 0, chunks: [] };   // a preview should never show a stale read of the folder
  const r = pickContext(String(question || ''));
  return { chunks: r.chunks.map((c) => ({ file: c.file, score: c.score, hits: c.hits, text: c.text.slice(0, 200) })), chars: r.text.length };
});
// Terms worth repairing are the ones the user actually works with, so mine them from the same
// documents the context feature already reads: anything that looks like a product or API name
// (internal capital, digit, dot, or an all-caps acronym) rather than ordinary prose.
ipcMain.handle('get-term-vocab', () => {
  const seen = Object.create(null);
  const out = [];
  for (const c of loadContextChunks()) {
    const words = String(c.text || '').split(/[^A-Za-z0-9+#.]+/);
    for (const w of words) {
      const t = w.replace(/^[.]+|[.]+$/g, '');
      if (t.length < 2 || t.length > 32) continue;
      const technical = /[A-Za-z][A-Z]/.test(t) || /[0-9]/.test(t) || /[.]/.test(t) || (/^[A-Z]{2,}$/.test(t));
      if (!technical) continue;
      const k = t.toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(t);
    }
  }
  return out;
});
ipcMain.handle('open-context-dir', () => {
  const dir = contextDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try { require('electron').shell.openPath(dir); } catch (e) {}
  return dir;
});
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
// Live Coding: send command 1..5 plus the selected problem/code. With no selection,
// the primed ChatGPT conversation applies the command to its most recent coding context.
async function sendKeyword(text) {
  const cmd = String(text == null ? '' : text).trim();
  const sel = await getSelectionText();
  doSendChatGPT(sel ? (cmd + '\n' + sel) : cmd, 'code' + cmd, true);
  if (sel && win && !win.isDestroyed()) win.webContents.send('advance-selection', 'code' + cmd);
}
function registerHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  const reg = (key, fn) => { if (!key) return true; try { return globalShortcut.register(key, fn); } catch (e) { return false; } };
  const results = {};
  // Register the click-through recovery key first. If another action uses the same
  // key, the ordinary action loses the collision; mouse recovery must always win.
  if (privacyActive()) {
    privacyHotkeyResults.click = reg(privacyConfig.clickHotkey, () => setPrivacyClickThrough(!privacyRuntime.clickThrough));
  } else {
    privacyHotkeyResults.click = false;
  }
  results.privacyClick = privacyHotkeyResults.click;
  if (codingMode) {
    // Live Coding ONLY: F1..F5 -> commands 1..5 (explain/code/improve/edge/time). Standard mode is untouched.
    ['1', '2', '3', '4', '5'].forEach((c, i) => { results['code' + c] = reg('F' + (i + 1), () => sendKeyword(c)); });
  } else {
    results.send = reg(actions.send.key, () => sendAction('send'));
    results.aa = reg(actions.aa.key, () => sendAction('aa'));
    results.bb = reg(actions.bb.key, () => sendAction('bb'));
    results.compact = reg(actions.compact.key, () => sendAction('compact'));
  }
  // Available in every interview mode. In Live Coding, F1-F5 remain reserved and a
  // conflicting Latest binding is visibly marked as unavailable in Settings.
  results.clip = reg(actions.clip.key, () => sendAction('clip'));
  results.ocr = reg(actions.ocr.key, () => sendAction('ocr'));
  results.latest = reg(actions.latest.key, () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey-latest'); });
  results.micmute = reg(actions.micmute.key, () => { if (win && !win.isDestroyed()) win.webContents.send('hotkey-mute'); });
  console.log('[CA-main] registered hotkeys (coding=' + codingMode + ') -> ok:', JSON.stringify(results));
  sendPrivacyState();
  return results;
}
ipcMain.on('send-keyword', (e, text) => sendKeyword(text));
ipcMain.on('set-mode', (e, m) => { const cm = (m === 'Live Coding'); if (cm !== codingMode) { codingMode = cm; registerHotkeys(); } });
ipcMain.handle('set-hotkeys', (e, cfg) => {
  cfg = cfg || {};
  if (cfg.send && typeof cfg.send.key === 'string') actions.send.key = cfg.send.key;
  if (cfg.aa)      { if (typeof cfg.aa.key === 'string') actions.aa.key = cfg.aa.key; if (typeof cfg.aa.label === 'string') actions.aa.label = cfg.aa.label; }
  if (cfg.bb)      { if (typeof cfg.bb.key === 'string') actions.bb.key = cfg.bb.key; if (typeof cfg.bb.text === 'string') actions.bb.text = cfg.bb.text; }
  if (cfg.latest && typeof cfg.latest.key === 'string') actions.latest.key = cfg.latest.key;
  if (cfg.compact) { if (typeof cfg.compact.key === 'string') actions.compact.key = cfg.compact.key; if (typeof cfg.compact.url === 'string') actions.compact.url = cfg.compact.url; }
  if (cfg.micmute && typeof cfg.micmute.key === 'string') actions.micmute.key = cfg.micmute.key;
  if (cfg.clip && typeof cfg.clip.key === 'string') actions.clip.key = cfg.clip.key;
  if (cfg.ocr && typeof cfg.ocr.key === 'string') actions.ocr.key = cfg.ocr.key;
  const results = registerHotkeys();
  return { ok: true, results: results, actions: actions };
});

// ---------- Chrome-extension bridge (localhost HTTP long-poll) ----------
// The bridge used to bind one hard-coded port and, if anything already held it, log a line and stay
// silently dead -- the extension then looked 'not connected' with nothing explaining why. Try a short
// range instead; the extension probes the same list.
const BRIDGE_PORTS = [17632, 17633, 17634, 17635, 17636];
let bridgePort = 0;
const BRIDGE_TOKEN = 'captionassistance-bridge-7f3a';   // shared secret; must match the extension
let bridgeServer = null;
let extLastSeen = 0;
const cmdQueue = [];
const pollWaiters = [];
const queuedCommandKeys = new Set();
let boundClient = null;   // which browser (extension instance) holds the binding; ONLY it receives commands
function extConnected() { return (Date.now() - extLastSeen) < 7000; }
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
  const key = String(cmd.type || '') + ':' + String(cmd.requestId || cmd.ts || '');
  if (queuedCommandKeys.has(key)) return false;
  pruneCommandQueue();
  queuedCommandKeys.add(key);
  cmd._queueKey = key;
  cmdQueue.push(cmd);   // the bound extension short-polls every ~500ms and picks it up
  console.log('[CA-main] queued', cmd.type, 'queueLen', cmdQueue.length, 'boundClient', boundClient);
  dbg('ENQUEUE ' + cmd.type + ' qlen=' + cmdQueue.length + ' boundClient=' + boundClient);
  flushCommandWaiter();   // wake the bound extension immediately, even when its ChatGPT tab is inactive
  return true;
}
function expireCommand(cmd) {
  if (!cmd) return;
  if (cmd._queueKey) queuedCommandKeys.delete(cmd._queueKey);
  emitGptResult({ ok: false, error: 'The ChatGPT request expired before the extension received it. Please try again.', code: 'command-expired', requestId: cmd.requestId || '', returnToApp: !!cmd.returnToApp, actionId: cmd.actionId || '' });
  if (currentGptRequest && currentGptRequest.requestId === cmd.requestId) currentGptRequest.state = 'error';
}
function pruneCommandQueue() {
  const now = Date.now();
  for (let i = cmdQueue.length - 1; i >= 0; i--) {
    const cmd = cmdQueue[i];
    const expires = Number(cmd.expiresAt || ((cmd.ts || now) + 30000));
    if (expires <= now) { cmdQueue.splice(i, 1); expireCommand(cmd); }
  }
}
function takeCommand() {
  pruneCommandQueue();
  const cmd = cmdQueue.shift() || null;
  if (cmd && cmd._queueKey) queuedCommandKeys.delete(cmd._queueKey);
  if (cmd && currentGptRequest && currentGptRequest.requestId === cmd.requestId) {
    currentGptRequest.state = cmd.type === 'recover' ? 'recovering' : 'delivered';
    emitGptStatus({ connected: true, bound: true, requestId: cmd.requestId, returnToApp: !!cmd.returnToApp, phase: 'delivered' });
  }
  return cmd;
}
function finishCommandWaiter(waiter, commands) {
  const i = pollWaiters.indexOf(waiter); if (i >= 0) pollWaiters.splice(i, 1);
  clearTimeout(waiter.timer);
  if (!waiter.res.writableEnded) bridgeSend(waiter.res, 200, { commands: commands || [], boundClient: boundClient });
}
function flushCommandWaiter() {
  if (!boundClient || !cmdQueue.length) return false;
  const waiter = pollWaiters.find((w) => w.client === boundClient);
  if (!waiter) return false;
  const cmd = takeCommand();
  if (!cmd) return false;
  dbg('WAIT -> DELIVERING ' + cmd.type + ' to ' + waiter.client);
  finishCommandWaiter(waiter, [cmd]);
  return true;
}
function startBridge() {
  try {
    bridgeServer = http.createServer((req, res) => {
      let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { bridgeSend(res, 400, {}); return; }
      if (req.method === 'OPTIONS') { bridgeSend(res, 204, {}); return; }
      if (u.searchParams.get('token') !== BRIDGE_TOKEN) { bridgeSend(res, 403, { error: 'bad token' }); return; }
      extLastSeen = Date.now();
      if (u.pathname === '/poll') {
        pruneCommandQueue();
        const client = u.searchParams.get('client') || '';
        const isBound = boundClient && client === boundClient;
        // "linked" == the server holds a binding. Same source as the extension icon (boundClient/cid), so
        // the two indicators always AGREE. The extension unbinds the moment its bound tab closes (backstop
        // below), so boundClient staying set already means a live bound tab.
        if (win && !win.isDestroyed()) win.webContents.send('gpt-status', { connected: true, bound: boundClient != null });
        dbg('POLL state-only client=' + client + ' boundClient=' + boundClient + ' isBound=' + !!isBound);
        bridgeSend(res, 200, { commands: [], boundClient: boundClient, teleOn: teleOn, mic: teleCap, consoleOn: consoleOn, micSource: (micEngine === 'browser' ? 'system' : 'app'), engine: micEngine, speakerEngine: speakerEngine, scrollTrigger: scrollParams.trigger, scrollTarget: scrollParams.target, scrollSpeed: scrollParams.speed });
        return;
      }
      if (u.pathname === '/wait') {
        const client = u.searchParams.get('client') || '';
        if (win && !win.isDestroyed()) win.webContents.send('gpt-status', { connected: true, bound: boundClient != null });
        if (boundClient && client === boundClient && cmdQueue.length) {
          const cmd = takeCommand();
          if (!cmd) { bridgeSend(res, 200, { commands: [], boundClient: boundClient }); return; }
          dbg('WAIT immediate -> ' + cmd.type + ' to ' + client);
          bridgeSend(res, 200, { commands: [cmd], boundClient: boundClient });
          return;
        }
        const waiter = { client: client, res: res, timer: null };
        waiter.timer = setTimeout(() => finishCommandWaiter(waiter, []), 2500);   // also refreshes the UI's bridge indicator before its 3.5 s freshness window expires
        pollWaiters.push(waiter);
        res.on('close', () => {
          const i = pollWaiters.indexOf(waiter);
          if (i >= 0) { pollWaiters.splice(i, 1); clearTimeout(waiter.timer); }
        });
        return;
      }
      if (u.pathname === '/bind') {
        const client = u.searchParams.get('client') || '';
        const bound = u.searchParams.get('bound') === '1';
        if (bound) boundClient = client; else if (boundClient === client) boundClient = null;
        console.log('[CA-main] /bind client', client, 'bound', bound, '-> boundClient', boundClient);
        flushCommandWaiter();
        bridgeSend(res, 200, { ok: true, boundClient: boundClient });
        return;
      }
      if (u.pathname === '/result') {
        let body = ''; req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        req.on('end', () => {
          let obj = {}; try { obj = JSON.parse(body || '{}'); } catch (e) {}
          console.log('[CA-main] /result', JSON.stringify(obj)); dbg('RESULT ' + JSON.stringify(obj));
          if (currentGptRequest && obj.requestId === currentGptRequest.requestId) { currentGptRequest.state = obj.ok ? 'submitted' : 'error'; if (obj.ok) currentGptRequest.sent = true; }
          if (obj.ok && obj.requestId) emitGptStatus({ connected: true, bound: true, requestId: obj.requestId, returnToApp: !!obj.returnToApp, phase: obj.recovered ? 'recovering' : 'submitted' });
          emitGptResult(obj); bridgeSend(res, 200, { ok: true });
        });
        return;
      }
      if (u.pathname === '/from-ext') {   // reverse channel: the extension pushes browser mic / Chrome caption / console state
        let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => { let o = {}; try { o = JSON.parse(body || '{}'); } catch (e) {} handleFromExt(o); bridgeSend(res, 200, { ok: true }); });
        return;
      }
      if (u.pathname === '/ping') { bridgeSend(res, 200, { ok: true, app: 'caption.assistance', port: bridgePort, boundClient: boundClient }); return; }
      bridgeSend(res, 404, { error: 'not found' });
    });
    let portIndex = 0;
    bridgeServer.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && portIndex + 1 < BRIDGE_PORTS.length) {
        portIndex++;
        console.warn('[CA-main] bridge port ' + BRIDGE_PORTS[portIndex - 1] + ' in use -> trying ' + BRIDGE_PORTS[portIndex]);
        try { bridgeServer.listen(BRIDGE_PORTS[portIndex], '127.0.0.1'); } catch (e) {}
        return;
      }
      try { console.error('bridge:', err && err.message); } catch (e) {}
    });
    bridgeServer.on('listening', () => { bridgePort = BRIDGE_PORTS[portIndex]; console.log('[CA-main] bridge listening on 127.0.0.1:' + bridgePort); });
    bridgeServer.listen(BRIDGE_PORTS[portIndex], '127.0.0.1');
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
  const ps = micReader;   // stable handle so the lifecycle guards below can tell 'died' from 'replaced'
  let buf = '';
  micReader.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o) continue;
      if (micEngine !== 'browser' && micEngine !== 'windows') continue;   // local/cloud engines drive their own captions
      // The reader reports its own failures (blocked OS setting, unusable device). These used to be dropped
      // here because only partial/final were handled, so a dead mic engine looked exactly like silence.
      if (o.status === 'error') { sendEngineErrorThrottled('mic', micReaderHint(o.text), 'windows'); continue; }
      // The reader says 'ready' once Windows has actually armed the recognizer. Pass it on: without it
      // a working engine and a blocked one looked identical in the UI until someone spoke.
      if (o.status === 'ready') {
        _engErrSeen.mic = null;
        if (win && !win.isDestroyed()) win.webContents.send('engine-status', { engine: 'windows', src: 'mic', state: 'live' });
        continue;
      }
      if (o.text == null) continue;
      // (1) live 'mic' caption source -> the caption window (tagged so it can be filtered / merged)
      if (win && !win.isDestroyed() && (o.status === 'partial' || o.status === 'final')) {
        win.webContents.send('caption', { src: 'mic', status: o.status, text: o.text });
      }
      // (2) teleprompter clean accumulation (only while GPT auto scroll is on)
      if (teleOn) feedTele(o.text, o.status);
    }
  });
  ps.on('exit', () => { if (micReader !== ps) return; micReader = null; if (!quitting && !micReaderPaused) setTimeout(startMicReader, 800); });
  ps.on('error', () => { if (micReader === ps) micReader = null; });
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
// Resolve a REAL interpreter path. Spawning the bare name 'python' looked fine but failed with ENOENT on
// machines where the only thing on PATH is the WindowsApps alias stub, which child_process cannot exec --
// so local transcription silently never started. Probe the usual install roots, then ask py/python where
// they actually live. Cached: this runs at most once per app start.
let _pythonExe;
function pythonExe() {
  if (_pythonExe !== undefined) return _pythonExe;
  const cands = ['C:\\Python\\Python312\\python.exe'];
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Python'),
    'C:\\Python'
  ].filter(Boolean);
  for (const root of roots) {
    try { for (const d of fs.readdirSync(root)) if (/^Python3/i.test(d)) cands.push(path.join(root, d, 'python.exe')); }
    catch (e) {}
  }
  _pythonExe = '';
  for (const p of cands) { try { if (fs.existsSync(p)) { _pythonExe = p; break; } } catch (e) {} }
  if (!_pythonExe) {
    for (const probe of [['py', ['-3', '-c', 'import sys;print(sys.executable)']], ['python', ['-c', 'import sys;print(sys.executable)']]]) {
      try {
        const r = spawnSync(probe[0], probe[1], { windowsHide: true, encoding: 'utf8', timeout: 6000 });
        const out = String((r && r.stdout) || '').trim().split(/\r?\n/).pop().trim();
        if (r && r.status === 0 && out && fs.existsSync(out)) { _pythonExe = out; break; }
      } catch (e) {}
    }
  }
  console.log('[CA-main] python ->', _pythonExe || '(NOT FOUND)');
  return _pythonExe;
}
// Surface an engine failure in the UI. A spawn error used to go to console only, so the settings panel
// kept showing "Local (Vosk)" while nothing was transcribing.
function sendEngineError(src, detail, engine) {
  engine = engine || 'local';
  console.error('[CA-main] ' + engine + ' STT ' + src + ': ' + detail);
  if (win && !win.isDestroyed()) win.webContents.send('engine-status', { engine: engine, src: src, state: 'error', detail: detail });
}
// The WinRT recognizer repeats the same failure several times a second. Report a given message once, and
// only re-report it after a pause, so one bad state cannot flood the UI or the log.
const _engErrSeen = {};
function sendEngineErrorThrottled(src, detail, engine) {
  const key = src + '|' + detail;
  const now = Date.now();
  if (_engErrSeen[src] && _engErrSeen[src].key === key && now - _engErrSeen[src].at < 15000) return;
  _engErrSeen[src] = { key: key, at: now };
  sendEngineError(src, detail, engine);
}
// Turn the raw WinRT failure into something the user can act on. The privacy-policy error is by far the
// most common: Windows blocks speech recognition entirely until the OS toggle is accepted.
function micReaderHint(raw) {
  const t = String(raw || '');
  const lastLine = t.split(/[\r\n]+/).filter(Boolean).pop() || t;
  if (/privacy policy/i.test(t)) return 'Windows speech is blocked by an OS setting - open Settings > Privacy & security > Speech and turn ON "Online speech recognition", then pick the engine again.';
  if (/UserCanceled|not supported|no audio|device/i.test(t)) return 'Windows speech could not use this microphone (' + lastLine.trim().slice(0, 120) + '). Try another mic, or switch the Mic engine to Browser.';
  return 'Windows speech error: ' + lastLine.trim().slice(0, 160);
}
let localFail = { mic: 0, speaker: 0 };   // consecutive fast-crash counter (prevents an infinite respawn -> OOM)
function spawnLocalStt(src, deviceName) {
  const py = pythonExe();
  if (!py) { sendEngineError(src, 'Python was not found — install Python 3.10-3.12 from python.org (tick "Add to PATH"), then click "Set up local model"'); return null; }
  const args = ['-u', scriptPath('stt-local.py'), '--src', src];
  if (src === 'mic' && deviceName) args.push('--device', deviceName);
  // cwd MUST be a real directory. When packaged, __dirname points inside app.asar, which does not exist on
  // disk -- spawn then fails with ENOENT and blames the executable, which is why this looked like a missing
  // Python for so long. scriptsDir is process.resourcesPath when packaged, __dirname in dev.
  let ps; try { ps = spawn(py, args, { windowsHide: true, cwd: scriptsDir }); } catch (e) { sendEngineError(src, 'could not start local transcription: ' + (e && e.message)); return null; }
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
  // ENOENT and friends fire 'error', NOT 'exit' -- the respawn path below never saw them, so a failed
  // start was invisible AND unretried. Clear the slot so the exit guard stays consistent, and tell the UI.
  ps.on('error', (e) => {
    if (localStt[src] === ps) localStt[src] = null;
    sendEngineError(src, 'local transcription could not start (' + ((e && e.message) || 'unknown') + ')');
  });
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
  // The Live Captions reader is engine-independent (it also enforces LC opacity), so a mic-engine
  // change must not restart it: every restart dropped captions for a second or more.
  if (!reader) startReader();
  micReaderPaused = !(micEngine === 'browser' || micEngine === 'windows');
  if (micReaderPaused) { const old = micReader; micReader = null; try { if (old) old.kill(); } catch (err) {} } else startMicReader();
  reconcileLocalStt();
}
ipcMain.on('set-engines', (e, cfg) => {
  cfg = cfg || {};
  speakerEngine = ['system', 'local', 'deepgram', 'elevenlabs', 'speechmatics'].includes(cfg.speaker) ? cfg.speaker : 'system';
  micEngine = ['windows', 'browser', 'local', 'deepgram', 'elevenlabs', 'speechmatics'].includes(cfg.mic) ? cfg.mic : 'windows';
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
  // The bound page reports which selectors its adapter actually resolved. Ride the existing gpt-status
  // channel so a stale site layout shows up in the UI instead of failing silently on the next send.
  else if (o.type === 'adapter-check') emitGptStatus({ connected: true, bound: boundClient != null, adapter: o.payload || {} });
  else if (o.type === 'toggle-autoscroll') { win.webContents.send('toggle-autoscroll'); }
  else if (o.type === 'gpt-answer') {
    if (currentGptRequest && String(o.requestId || '') === currentGptRequest.requestId) {
      currentGptRequest.state = o.phase === 'final' ? 'complete' : (o.phase === 'error' ? 'error' : 'generating');
      if (o.phase !== 'error') currentGptRequest.sent = true;
    }
    win.webContents.send('gpt-answer', {
      requestId: String(o.requestId || ''), phase: String(o.phase || ''),
      text: String(o.text || ''), error: String(o.error || ''),
      code: String(o.code || ''), seq: Number.isFinite(+o.seq) ? +o.seq : 0
    });
  }
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
