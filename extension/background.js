// Caption assistance Bridge -- background service worker.
// Long-polls the Caption assistance local server for commands and runs them against the
// ChatGPT tab: 'send' types text + submits; 'compact' scrapes the current chat,
// opens a fresh window at a chosen URL, and pastes the history there.
const PORT = 17632;
const TOKEN = 'captionassistance-bridge-7f3a';           // must match main.js BRIDGE_TOKEN
const BASE = `http://127.0.0.1:${PORT}`;
function postToBridge(payload) {
  try { return fetch(`${BASE}/from-ext?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store' }).catch(() => null); }
  catch (e) { return Promise.resolve(null); }
}
const CHAT_MATCH = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

function log(...a) { console.log('%c[CA-bg]', 'color:#138886;font-weight:bold', ...a); }
function warn(...a) { console.warn('[CA-bg]', ...a); }
function err(...a) { console.error('[CA-bg]', ...a); }

let connectedOnce = false;
let boundTabId = null;   // the ChatGPT tab explicitly bound to Caption assistance; commands ONLY go here
let clientId = null;     // stable id for THIS browser/extension instance (server binds to one client)
let lastMicSeq = -1, teleWasOn = false;   // read-along teleprompter: dedupe forwarded mic captions
let commandWaitLooping = false;
let commandChain = Promise.resolve();
const handledRequestIds = new Set();
const handledReady = (async () => {
  try {
    const o = await chrome.storage.session.get(['handledRequestIds']);
    for (const id of (o.handledRequestIds || [])) handledRequestIds.add(String(id));
  } catch (e) {}
})();
async function rememberHandled(requestId) {
  if (!requestId) return;
  handledRequestIds.add(String(requestId));
  const ids = Array.from(handledRequestIds).slice(-40);
  try { await chrome.storage.session.set({ handledRequestIds: ids }); } catch (e) {}
}
function dispatchCommand(cmd) {
  commandChain = commandChain.then(async () => {
    try { await handleCommand(cmd); }
    catch (e) { await postResult({ ok: false, error: String(e), requestId: cmd && cmd.requestId, returnToApp: !!(cmd && cmd.returnToApp), actionId: cmd && cmd.actionId }); }
  }).catch((e) => warn('command chain recovered:', e));
  return commandChain;
}
function saveBound() { try { chrome.storage.local.set({ boundTabId: boundTabId }); } catch (e) {} }
async function getClientId() {
  // chrome.runtime.id is stable per extension and identical across service-worker
  // restarts AND content scripts. The old storage-based id churned (the SW was killed
  // before storage.set persisted), spawning multiple ids so the polling client no
  // longer matched the server's boundClient -> commands were never delivered.
  return chrome.runtime.id;
}
async function postBind() {
  try { const cid = await getClientId(); await fetch(`${BASE}/bind?token=${TOKEN}&client=${cid}&bound=${boundTabId != null ? 1 : 0}`, { method: 'POST', cache: 'no-store' }); log('posted bind =', boundTabId != null); } catch (e) { warn('postBind failed:', e); }
}
try { chrome.storage.local.get(['boundTabId']).then((o) => { if (o && typeof o.boundTabId === 'number') { boundTabId = o.boundTabId; log('restored boundTabId', boundTabId); try { chrome.tabs.update(boundTabId, { autoDiscardable: false }); } catch (e) {} postBind(); } }); } catch (e) {}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// A pending localhost request keeps command delivery alive when Chrome heavily throttles an inactive
// ChatGPT tab. The old design depended on that tab's 80 ms timer, so commands only arrived after the
// user clicked the tab. Each request ends within 2.5 s, then reconnects; queued commands wake it immediately.
async function commandWaitLoop() {
  if (commandWaitLooping) return;
  commandWaitLooping = true;
  while (true) {
    try {
      const cid = await getClientId();
      const r = await fetch(`${BASE}/wait?token=${TOKEN}&client=${cid}`, { method: 'GET', cache: 'no-store' });
      if (!r.ok) throw new Error('wait HTTP ' + r.status);
      const data = await r.json();
      connectedOnce = true;
      if (boundTabId != null) {
        if (!data.boundClient) postBind();
        else if (data.boundClient !== cid) { boundTabId = null; saveBound(); broadcastRefresh(); }
      }
      const cmds = (data && data.commands) || [];
      for (const cmd of cmds) await dispatchCommand(cmd);
    } catch (e) {
      connectedOnce = false;
      await sleep(800);
    }
  }
}

// ONE short poll (driven by the content-script tick every ~500ms + alarms). Short polls
// don't depend on the MV3 service worker staying alive across a 25s long-poll.
let lastPoll = 0, pollInFlight = false;
async function doPoll() {
  const now = Date.now();
  if (pollInFlight || now - lastPoll < 200) return;
  lastPoll = now;
  pollInFlight = true;
  const cid = await getClientId();
  // Backstop for onRemoved (which can be missed while the MV3 worker sleeps): if the bound tab is GONE,
  // unbind so Caption assistance's "linked" clears in step with the icon. (A navigated-away page keeps binding.)
  if (boundTabId != null) {
    try { await chrome.tabs.get(boundTabId); }
    catch (e) { log('bound tab', boundTabId, 'gone -> unbinding'); boundTabId = null; saveBound(); postBind(); broadcastRefresh(); }
  }
  let data;
  try {
    const r = await fetch(`${BASE}/poll?token=${TOKEN}&client=${cid}`, { method: 'GET', cache: 'no-store' });
    if (!r.ok) { connectedOnce = false; return; }
    data = await r.json();
    if (!connectedOnce) { connectedOnce = true; log('CONNECTED to Caption assistance ✓'); }
  } catch (e) { connectedOnce = false; return; }
  finally { pollInFlight = false; }
  // keep the binding consistent with the server: re-register if it forgot (app restarted);
  // release ours if another browser has taken over.
  if (boundTabId != null) {
    if (!data.boundClient) postBind();
    else if (data.boundClient !== cid) { log('binding taken over by another browser -> releasing'); boundTabId = null; saveBound(); broadcastRefresh(); }
  }
  // read-along teleprompter: tell the bound tab the on/off state (it captures the mic itself via
  // Chrome speech), and also forward Caption assistance's clean mic caption as a fallback for tabs that
  // can't run Chrome speech.
  if (boundTabId != null) {
    const on = !!(data && data.teleOn);
    if (on !== teleWasOn) log('GPT auto scroll -> ' + (on ? 'ON' : 'off') + ' (tab ' + boundTabId + ')');
    // send every poll (content side is idempotent) so a freshly (re)loaded tab always learns the state
    try { await chrome.tabs.sendMessage(boundTabId, { action: 'teleState', teleOn: on, consoleOn: !!(data && data.consoleOn), micSource: (data && data.micSource) || 'system', scrollTrigger: data && data.scrollTrigger, scrollTarget: data && data.scrollTarget, scrollSpeed: data && data.scrollSpeed }); } catch (e) {}
    if (on && data.mic && data.mic.seq !== lastMicSeq) {
      lastMicSeq = data.mic.seq;
      log('forward mic caption seq=' + data.mic.seq + ' -> tab ' + boundTabId + ' [' + String(data.mic.text || '').length + ' ch]');
      try { await chrome.tabs.sendMessage(boundTabId, { action: 'teleMic', teleOn: true, mic: data.mic }); } catch (e) { warn('forward teleMic failed:', e && e.message); }
    } else if (!on && teleWasOn) {
      try { await chrome.tabs.sendMessage(boundTabId, { action: 'teleMic', teleOn: false }); } catch (e) {}
    }
    teleWasOn = on;
  }
}

async function postResult(obj) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${BASE}/result?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj), cache: 'no-store'
      });
      if (response.ok) { log('posted result:', JSON.stringify(obj)); return true; }
    } catch (e) { if (attempt === 3) warn('postResult failed:', e); }
    await sleep(150 * attempt);
  }
  return false;
}

async function findChatTab() {
  // ONLY act on the explicitly bound tab -- no bind, no action.
  if (boundTabId == null) { warn('no tab bound -> ignoring (click the bind icon next to + on a ChatGPT tab)'); return null; }
  const tabs = await chrome.tabs.query({ url: CHAT_MATCH });
  let bound = tabs.find((t) => t.id === boundTabId);
  if (!bound) { warn('bound tab', boundTabId, 'not found (closed?) -> ignoring'); return null; }
  try { await chrome.tabs.update(bound.id, { autoDiscardable: false }); } catch (e) {}
  try { bound = await chrome.tabs.get(bound.id); } catch (e) {}
  log('using BOUND tab', bound.id);
  return bound;
}
async function wakeSleepingTabOnce(tab) {
  if (!tab || (!tab.frozen && !tab.discarded)) return tab;
  let previous = null;
  try { previous = (await chrome.tabs.query({ windowId: tab.windowId, active: true }))[0] || null; } catch (e) {}
  await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false });
  if (tab.discarded) await waitTabComplete(tab.id, 20000);
  else await sleep(250);
  if (previous && previous.id !== tab.id) { try { await chrome.tabs.update(previous.id, { active: true }); } catch (e) {} }
  await sleep(80);
  return await chrome.tabs.get(tab.id);
}
async function focusTab(tab) {
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
  await sleep(20);
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}   // 2nd attempt once the grant settles
}
async function sendToTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (e) {
    warn('sendMessage failed (injecting content.js and retrying):', e && e.message ? e.message : e);
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
    catch (e2) { err('inject content.js failed:', e2); }
    return await chrome.tabs.sendMessage(tabId, message);
  }
}
const answerQueue = [];
const answerActivity = new Map();
let answerPosting = false, answerHealthToken = 0;
function relayAnswer(payload) {
  const body = Object.assign({}, payload, { type: 'gpt-answer' });
  if (body.requestId) answerActivity.set(String(body.requestId), { at: Date.now(), phase: body.phase || '', text: body.text || '' });
  if (body.phase === 'stream') {
    const old = answerQueue.find((item) => item.body.requestId === body.requestId && item.body.phase === 'stream');
    if (old) old.body = body; else answerQueue.push({ body, attempts: 0 });
  } else {
    for (let i = answerQueue.length - 1; i >= 0; i--) if (answerQueue[i].body.requestId === body.requestId && answerQueue[i].body.phase === 'stream') answerQueue.splice(i, 1);
    answerQueue.push({ body, attempts: 0 });
  }
  pumpAnswers();
}
async function pumpAnswers() {
  if (answerPosting) return;
  answerPosting = true;
  while (answerQueue.length) {
    const item = answerQueue.shift();
    const response = await postToBridge(item.body);
    if (!response || !response.ok) {
      item.attempts++;
      if (item.body.phase !== 'stream' && item.attempts < 10) answerQueue.unshift(item);
      await sleep(Math.min(2000, 200 * item.attempts));
      if (item.body.phase === 'stream') continue;
    }
  }
  answerPosting = false;
}
async function monitorTabHealth(tabId, requestId) {
  const token = ++answerHealthToken;
  while (token === answerHealthToken) {
    await sleep(1000);
    const state = answerActivity.get(String(requestId));
    if (state && (state.phase === 'final' || state.phase === 'error')) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch (e) { relayAnswer({ requestId, phase: 'error', text: state && state.text || '', error: 'The bound ChatGPT tab was closed.', code: 'tab-closed', seq: Date.now() * 1000 }); return; }
    if (tab.frozen || tab.discarded) {
      relayAnswer({ requestId, phase: 'error', text: state && state.text || '', error: 'The ChatGPT tab was suspended or unloaded by Chrome. Click Refresh to wake it once and reconnect safely.', code: tab.discarded ? 'tab-discarded' : 'tab-frozen', seq: Date.now() * 1000 });
      return;
    }
  }
}
async function waitTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const t = await chrome.tabs.get(tabId); if (t && t.status === 'complete') return true; }
    catch (e) { return false; }
    await sleep(300);
  }
  return false;
}

async function handleCommand(cmd) {
  if (!cmd) return;
  log('handleCommand:', cmd.type);

  if (cmd.type === 'send') {
    await handledReady;
    const tab = await findChatTab();
    if (!tab) { await postResult({ ok: false, error: 'No bound ChatGPT tab. Click the bind icon on the ChatGPT tab you want.', code: 'no-bound-tab', requestId: cmd.requestId || '', returnToApp: !!cmd.returnToApp, actionId: cmd.actionId || 'send' }); return; }
    if (cmd.returnToApp && (tab.frozen || tab.discarded)) {
      await postResult({ ok: false, error: 'The ChatGPT tab is suspended or unloaded by Chrome. Click Refresh to wake it once and send safely.', code: tab.discarded ? 'tab-discarded' : 'tab-frozen', requestId: cmd.requestId || '', returnToApp: true, actionId: cmd.actionId || 'send' });
      return;
    }
    if (cmd.requestId && handledRequestIds.has(String(cmd.requestId))) {
      const recovered = await sendToTab(tab.id, { action: 'recoverAnswer', requestId: cmd.requestId, expectedText: cmd.text });
      await postResult({ ok: !!(recovered && recovered.ok), recovered: true, duplicateBlocked: true, detail: recovered, requestId: cmd.requestId, returnToApp: !!cmd.returnToApp, actionId: cmd.actionId || 'send' });
      if (cmd.returnToApp && recovered && recovered.ok) monitorTabHealth(tab.id, cmd.requestId).catch(() => {});
      return;
    }
    // Foreground mode may focus ChatGPT; Answer-in-app remains in the current app window.
    if (cmd.focus !== false) {
      await focusTab(tab);
      if (tab.discarded) { await waitTabComplete(tab.id, 20000); await sleep(300); }
    }
    log('sending', (cmd.text || '').length, 'chars to tab', tab.id);
    const message = { action: 'insertAndSend', text: cmd.text, submit: cmd.submit, returnToApp: !!cmd.returnToApp, requestId: cmd.requestId || '', actionId: cmd.actionId || 'send' };
    const resp = await sendToTab(tab.id, message);
    log('insertAndSend result:', JSON.stringify(resp));
    await postResult({ ok: !!(resp && resp.ok), type: 'send', detail: resp, requestId: cmd.requestId || '', returnToApp: !!cmd.returnToApp, actionId: cmd.actionId || 'send' });
    if (resp && resp.ok && cmd.requestId) await rememberHandled(cmd.requestId);
    if (cmd.returnToApp && resp && resp.ok) monitorTabHealth(tab.id, cmd.requestId || '').catch(() => {});
    return;
  }

  if (cmd.type === 'recover') {
    await handledReady;
    let tab = await findChatTab();
    if (!tab) { await postResult({ ok: false, error: 'The bound ChatGPT tab is no longer available.', code: 'no-bound-tab', requestId: cmd.requestId || '', returnToApp: true, actionId: cmd.actionId || 'send' }); return; }
    if (tab.frozen || tab.discarded) {
      try { tab = await wakeSleepingTabOnce(tab); }
      catch (e) { await postResult({ ok: false, error: 'Chrome could not wake the suspended ChatGPT tab. Open it once, then press Refresh again.', code: 'wake-failed', requestId: cmd.requestId || '', returnToApp: true, actionId: cmd.actionId || 'send' }); return; }
    }
    const recovered = await sendToTab(tab.id, { action: 'recoverAnswer', requestId: cmd.requestId || '', expectedText: cmd.text || '' });
    if (recovered && recovered.ok && recovered.found) {
      await postResult({ ok: true, type: 'recover', recovered: true, resent: false, detail: recovered, requestId: cmd.requestId || '', returnToApp: true, actionId: cmd.actionId || 'send' });
      monitorTabHealth(tab.id, cmd.requestId || '').catch(() => {});
      return;
    }
    if (cmd.requestId && handledRequestIds.has(String(cmd.requestId))) {
      await postResult({ ok: false, error: 'The original question could not be identified in this chat, so it was not resent to prevent a duplicate. Open the bound ChatGPT tab and verify the conversation.', code: 'request-ambiguous', requestId: cmd.requestId, returnToApp: true, actionId: cmd.actionId || 'send' });
      return;
    }
    const resp = await sendToTab(tab.id, { action: 'insertAndSend', text: cmd.text || '', submit: true, returnToApp: true, requestId: cmd.requestId || '', actionId: cmd.actionId || 'send' });
    await postResult({ ok: !!(resp && resp.ok), type: 'recover', recovered: true, resent: !!(resp && resp.ok), detail: resp, requestId: cmd.requestId || '', returnToApp: true, actionId: cmd.actionId || 'send' });
    if (resp && resp.ok && cmd.requestId) await rememberHandled(cmd.requestId);
    if (resp && resp.ok) monitorTabHealth(tab.id, cmd.requestId || '').catch(() => {});
    return;
  }

  if (cmd.type === 'compact') {
    const src = await findChatTab();
    if (!src) { await postResult({ ok: false, error: 'no bound ChatGPT tab to compact — bind a tab first' }); return; }
    const scraped = await sendToTab(src.id, { action: 'scrape' });
    const history = (scraped && scraped.text) || '';
    log('scraped', history.length, 'chars');
    if (!history) { await postResult({ ok: false, error: 'nothing to compact (empty scrape)' }); return; }
    const url = (cmd.url && /^https?:\/\//i.test(cmd.url)) ? cmd.url : 'https://chatgpt.com/';
    log('opening new tab at', url);
    let newTabId = null;
    try {
      const t = await chrome.tabs.create({ url: url, active: true });
      newTabId = t ? t.id : null;
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
    } catch (e) { err('tabs.create failed:', e); await postResult({ ok: false, error: 'could not open tab: ' + e }); return; }
    if (!newTabId) { await postResult({ ok: false, error: 'no new tab id' }); return; }
    await waitTabComplete(newTabId, 20000);
    await sleep(1500);
    log('pasting history into new tab', newTabId);
    const resp = await sendToTab(newTabId, { action: 'insertAndSend', text: history });
    log('compact insertAndSend result:', JSON.stringify(resp));
    await postResult({ ok: !!(resp && resp.ok), type: 'compact', detail: resp });
    return;
  }

  warn('unknown command type:', cmd.type);
}

// server reachability probe (content scripts on https can't reach localhost, so we do it here)
async function pingServer() {
  try {
    const r = await fetch(`${BASE}/ping?token=${TOKEN}`, { method: 'GET', cache: 'no-store' });
    if (!r.ok) return { up: false };
    const d = await r.json().catch(() => ({}));
    return { up: true, boundClient: d.boundClient };
  } catch (e) { return { up: false }; }
}
async function tabExists(tid) { try { await chrome.tabs.get(tid); return true; } catch (e) { return false; } }
// the TRUE state of the bind icon: blue only if the server is reachable AND this tab is the
// bound tab AND the server currently has THIS client bound (so sends will actually arrive).
async function computeBindState(tid) {
  const cid = await getClientId();
  const p = await pingServer();
  // SELF-HEAL: the server says WE (cid) are the bound client, but our boundTabId is null or points
  // at a tab that no longer exists (the bound tab was closed/replaced). That left the icon grey on
  // the user's live tab while Caption assistance still showed "linked". Adopt the tab that's asking.
  if (p.up && p.boundClient === cid && tid != null && boundTabId !== tid) {
    if (boundTabId == null || !(await tabExists(boundTabId))) { boundTabId = tid; saveBound(); log('healed stale boundTabId ->', tid); }
  }
  const bound = !!(p.up && tid != null && boundTabId === tid && p.boundClient === cid);
  log('bindState tid=' + tid + ' boundTabId=' + boundTabId + ' boundClient=' + p.boundClient + ' cid=' + cid + ' up=' + p.up + ' -> bound=' + bound);
  return { bound: bound, hasBinding: boundTabId != null, serverUp: p.up };
}
// bind: content scripts toggle/query which tab is locked to Caption assistance
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  doPoll();   // any SW wake (bind click / 5s content-script heartbeat) -> ensure we're polling
  commandWaitLoop();
  const tid = sender.tab && sender.tab.id;
  // reverse channel: push things from the bound tab to Caption assistance
  if (msg.action === 'micToApp') { postToBridge({ type: 'mic-caption', text: msg.text, status: msg.status }); return; }
  if (msg.action === 'browserMic') { postToBridge({ type: 'browser-mic', label: msg.label }); return; }
  if (msg.action === 'consoleClosed') { postToBridge({ type: 'console-closed' }); return; }
  if (msg.action === 'toggleAutoscroll') { postToBridge({ type: 'toggle-autoscroll' }); return; }
  if (msg.action === 'gptAnswer') {
    if (tid !== boundTabId || !msg.payload) return;   // only the explicitly bound ChatGPT tab may return answers
    relayAnswer(msg.payload);
    return;
  }
  if (msg.action === 'toggleBind') {
    const was = boundTabId;
    boundTabId = (boundTabId === tid) ? null : tid;
    try { if (boundTabId != null) chrome.tabs.update(boundTabId, { autoDiscardable: false }); else if (was != null) chrome.tabs.update(was, { autoDiscardable: true }); } catch (e) {}
    saveBound();
    log('toggleBind tid=' + tid + ' was=' + was + ' -> boundTabId=' + boundTabId);
    broadcastRefresh();
    postBind().then(() => computeBindState(tid)).then((st) => sendResponse(st));   // register with server, then report the real state
    return true;   // async sendResponse
  }
  if (msg.action === 'getBindState') {
    computeBindState(tid).then((st) => sendResponse(st));
    return true;   // async sendResponse
  }
});
async function broadcastRefresh() {
  try { const tabs = await chrome.tabs.query({ url: CHAT_MATCH }); for (const t of tabs) { try { await chrome.tabs.sendMessage(t.id, { action: 'refreshBind' }); } catch (e) {} } } catch (e) {}
}
chrome.tabs.onRemoved.addListener((tid) => { if (tid === boundTabId) { boundTabId = null; saveBound(); postBind(); log('bound tab closed -> cleared binding'); } });

chrome.runtime.onInstalled.addListener(() => { log('onInstalled'); try { chrome.alarms.create('poll', { periodInMinutes: 0.5 }); } catch (e) {} doPoll(); commandWaitLoop(); });
chrome.runtime.onStartup.addListener(() => { log('onStartup'); doPoll(); commandWaitLoop(); });
chrome.alarms.onAlarm.addListener((a) => { log('alarm', a && a.name, '-> ensure polling'); doPoll(); commandWaitLoop(); });
log('service worker loaded');
doPoll();
commandWaitLoop();
