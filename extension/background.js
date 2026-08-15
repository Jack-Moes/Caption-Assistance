// Caption assistance Bridge -- background service worker.
// Long-polls the Caption assistance local server for commands and runs them against the
// ChatGPT tab: 'send' types text + submits; 'compact' scrapes the current chat,
// opens a fresh window at a chosen URL, and pastes the history there.
const PORT = 17632;
const TOKEN = 'captionassistance-bridge-7f3a';           // must match main.js BRIDGE_TOKEN
const BASE = `http://127.0.0.1:${PORT}`;
function postToBridge(payload) { try { fetch(`${BASE}/from-ext?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store' }).catch(() => {}); } catch (e) {} }
const CHAT_MATCH = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

function log(...a) { console.log('%c[CA-bg]', 'color:#138886;font-weight:bold', ...a); }
function warn(...a) { console.warn('[CA-bg]', ...a); }
function err(...a) { console.error('[CA-bg]', ...a); }

let looping = false;
let connectedOnce = false;
let boundTabId = null;   // the ChatGPT tab explicitly bound to Caption assistance; commands ONLY go here
let clientId = null;     // stable id for THIS browser/extension instance (server binds to one client)
let lastMicSeq = -1, teleWasOn = false;   // read-along teleprompter: dedupe forwarded mic captions
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
try { chrome.storage.local.get(['boundTabId']).then((o) => { if (o && typeof o.boundTabId === 'number') { boundTabId = o.boundTabId; log('restored boundTabId', boundTabId); postBind(); } }); } catch (e) {}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ONE short poll (driven by the content-script tick every ~500ms + alarms). Short polls
// don't depend on the MV3 service worker staying alive across a 25s long-poll.
let lastPoll = 0;
async function doPoll() {
  const now = Date.now();
  if (now - lastPoll < 50) return;   // low-latency mode: allow fast delivery while still collapsing duplicate-tab bursts
  lastPoll = now;
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
  // keep the binding consistent with the server: re-register if it forgot (app restarted);
  // release ours if another browser has taken over.
  if (boundTabId != null) {
    if (!data.boundClient) postBind();
    else if (data.boundClient !== cid) { log('binding taken over by another browser -> releasing'); boundTabId = null; saveBound(); broadcastRefresh(); }
  }
  const cmds = (data && data.commands) || [];
  if (cmds.length) log('received', cmds.length, 'command(s)');
  for (const cmd of cmds) {
    try { await handleCommand(cmd); }
    catch (e) { err('handleCommand threw:', e); await postResult({ ok: false, error: String(e) }); }
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
  try {
    await fetch(`${BASE}/result?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
    });
    log('posted result:', JSON.stringify(obj));
  } catch (e) { warn('postResult failed:', e); }
}

async function findChatTab() {
  // ONLY act on the explicitly bound tab -- no bind, no action.
  if (boundTabId == null) { warn('no tab bound -> ignoring (click the bind icon next to + on a ChatGPT tab)'); return null; }
  const tabs = await chrome.tabs.query({ url: CHAT_MATCH });
  const bound = tabs.find((t) => t.id === boundTabId);
  if (!bound) { warn('bound tab', boundTabId, 'not found (closed?) -> ignoring'); return null; }
  log('using BOUND tab', bound.id);
  return bound;
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
    const tab = await findChatTab();
    if (!tab) { await postResult({ ok: false, error: 'no bound ChatGPT tab — click the bind icon (next to +) on the tab you want' }); return; }
    // Focus is cosmetic and must not block delivery. Start it in parallel with the DOM insertion.
    if (cmd.focus !== false) focusTab(tab).catch(() => {});   // bb/zz sends without bringing the browser forward
    log('sending', (cmd.text || '').length, 'chars to tab', tab.id);
    const resp = await sendToTab(tab.id, { action: 'insertAndSend', text: cmd.text, submit: cmd.submit });
    log('insertAndSend result:', JSON.stringify(resp));
    await postResult({ ok: !!(resp && resp.ok), type: 'send', detail: resp });
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
  const tid = sender.tab && sender.tab.id;
  // reverse channel: push things from the bound tab to Caption assistance
  if (msg.action === 'micToApp') { postToBridge({ type: 'mic-caption', text: msg.text, status: msg.status }); return; }
  if (msg.action === 'browserMic') { postToBridge({ type: 'browser-mic', label: msg.label }); return; }
  if (msg.action === 'consoleClosed') { postToBridge({ type: 'console-closed' }); return; }
  if (msg.action === 'toggleAutoscroll') { postToBridge({ type: 'toggle-autoscroll' }); return; }
  if (msg.action === 'toggleBind') {
    const was = boundTabId;
    boundTabId = (boundTabId === tid) ? null : tid;
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

chrome.runtime.onInstalled.addListener(() => { log('onInstalled'); try { chrome.alarms.create('poll', { periodInMinutes: 0.5 }); } catch (e) {} doPoll(); });
chrome.runtime.onStartup.addListener(() => { log('onStartup'); doPoll(); });
chrome.alarms.onAlarm.addListener((a) => { log('alarm', a && a.name, '-> ensure polling'); doPoll(); });
log('service worker loaded');
doPoll();
