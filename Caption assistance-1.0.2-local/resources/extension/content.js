// Caption assistance Bridge -- content script (runs inside chatgpt.com).
// Types text into the composer, submits, scrapes history, and shows a "Bind" button
// so the user can lock Caption assistance to THIS exact tab (when several ChatGPT tabs are open).
function log(...a) { console.log('%c[CA-content]', 'color:#595bff;font-weight:bold', ...a); }
function warn(...a) { console.warn('[CA-content]', ...a); }
log('loaded on', location.href);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  log('message:', msg.action);
  if (msg.action === 'insertAndSend') {
    insertAndSend(msg.text, msg.submit, msg).then((ok) => sendResponse({ ok: ok })).catch((e) => {
      warn('insertAndSend error:', e);
      if (msg.returnToApp && msg.requestId) reportAnswer({ requestId: msg.requestId, phase: 'error', text: '', error: String((e && e.message) || e), seq: 999999 });
      sendResponse({ ok: false, error: String(e) });
    });
    return true;   // async response
  }
  if (msg.action === 'scrape') {
    try { const t = scrapeConversation(); log('scrape ->', t.length, 'chars'); sendResponse({ ok: true, text: t }); }
    catch (e) { warn('scrape error:', e); sendResponse({ ok: false, error: String(e) }); }
    return;
  }
  if (msg.action === 'answerSnapshot') {
    try {
      const b = answerBaseline();
      sendResponse({ ok: true, count: b.count, text: b.text, generating: generationActive() });
    } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  if (msg.action === 'recoverAnswer') {
    recoverAnswer(msg.requestId, msg.expectedText).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.action === 'refreshBind') { refreshBindState(); return; }
  if (msg.action === 'teleMic') { if (caMicSource === 'app' || !haveWebSpeech()) { try { teleMic(msg); } catch (e) { log('teleMic error', e); } } return; }   // use the bridge mic when the app streams cloud transcription, else fall back to Chrome speech
  if (msg.action === 'teleState') {
    log('teleState teleOn=' + msg.teleOn + ' consoleOn=' + msg.consoleOn + ' mic=' + msg.micSource);
    try {
      caMicSource = msg.micSource || 'system'; caTeleOn = !!msg.teleOn; caSetEnabled(!!msg.consoleOn);
      if (typeof msg.scrollTrigger === 'number' && msg.scrollTrigger > 0) caScrollTrig = msg.scrollTrigger;
      if (typeof msg.scrollTarget === 'number' && msg.scrollTarget > 0) caScrollTarget = msg.scrollTarget;
      if (typeof msg.scrollSpeed === 'number' && msg.scrollSpeed > 0) caScrollSpeed = msg.scrollSpeed;
      if (TP.scroller && TP.scroller.o) { TP.scroller.o.TRIGGER_P = caScrollTrig; TP.scroller.o.TARGET_P = caScrollTarget; TP.scroller.o.SPEED = caScrollSpeed; }   // apply live
      setSpeechWant((caMicSource === 'system') || (caTeleOn && caMicSource !== 'app'));
    }
    catch (e) { warn('teleState handler error:', e); }
    return;   // run Chrome speech whenever the app wants the mic (System) OR read-along is on
  }
  if (msg.action === 'ping') { sendResponse({ ok: true }); return; }
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function findComposer() {
  return document.querySelector('#prompt-textarea')
    || document.querySelector('div.ProseMirror[contenteditable="true"]')
    || document.querySelector('form [contenteditable="true"]')
    || document.querySelector('form textarea')
    || document.querySelector('textarea');
}
function findSendButton() {
  return document.querySelector('button[data-testid="send-button"]')
    || document.querySelector('button[aria-label*="Send" i]')
    || document.querySelector('form button[type="submit"]');
}
async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await sleep(25); }
  return null;
}

let caAnswerWatchToken = 0, caAnswerWatchCleanup = null;
function assistantNodes() { return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')); }
function answerTextOf(node) {
  if (!node) return '';
  const body = node.querySelector('.markdown') || node;
  return (body.innerText || body.textContent || '').trim();
}
function answerBaseline() {
  const nodes = assistantNodes();
  return { count: nodes.length, node: nodes.length ? nodes[nodes.length - 1] : null, text: nodes.length ? answerTextOf(nodes[nodes.length - 1]) : '' };
}
function generationActive() {
  return !!(document.querySelector('button[data-testid="stop-button"]')
    || document.querySelector('button[aria-label*="Stop generating" i]')
    || document.querySelector('button[aria-label*="Stop streaming" i]'));
}
function reportAnswer(payload) {
  try {
    const p = chrome.runtime.sendMessage({ action: 'gptAnswer', payload: payload });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function messageNodes() { return Array.from(document.querySelectorAll('[data-message-author-role]')); }
function normalizePromptText(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function findMatchingUserNode(expectedText) {
  const expected = normalizePromptText(expectedText);
  if (!expected) return null;
  const nodes = messageNodes();
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].getAttribute('data-message-author-role') !== 'user') continue;
    if (normalizePromptText(nodes[i].innerText || nodes[i].textContent) === expected) return nodes[i];
  }
  return null;
}
function assistantAfterUser(userNode) {
  if (!userNode) return null;
  const nodes = messageNodes();
  const idx = nodes.indexOf(userNode);
  if (idx < 0) return null;
  for (let i = idx + 1; i < nodes.length; i++) if (nodes[i].getAttribute('data-message-author-role') === 'assistant') return nodes[i];
  return null;
}
function startAssistantAnswerWatch(requestId, baseline, userNode, recovered) {
  if (caAnswerWatchCleanup) caAnswerWatchCleanup();
  const token = ++caAnswerWatchToken;
  const seqBase = Date.now() * 1000;
  let seq = 0, lastText = '', lastSent = '', lastChangeAt = Date.now(), lastPostAt = 0;
  let inspectTimer = null, settleTimer = null, closed = false;
  const startedAt = Date.now();
  const nextSeq = () => seqBase + (seq++);
  const finish = (phase, text, error) => {
    if (closed || token !== caAnswerWatchToken) return;
    closed = true; cleanup();
    reportAnswer({ requestId, phase, text: text || '', error: error || '', seq: nextSeq() });
  };
  const cleanup = () => {
    if (observer) observer.disconnect();
    if (inspectTimer) clearTimeout(inspectTimer);
    if (settleTimer) clearTimeout(settleTimer);
    clearTimeout(noAnswerTimer); clearTimeout(limitTimer);
    if (caAnswerWatchCleanup === cleanup) caAnswerWatchCleanup = null;
  };
  const inspect = () => {
    inspectTimer = null;
    if (closed || token !== caAnswerWatchToken) return;
    const nodes = assistantNodes();
    const node = userNode ? assistantAfterUser(userNode) : (nodes.length ? nodes[nodes.length - 1] : null);
    const text = answerTextOf(node);
    const isNew = !!node && (userNode || nodes.length > baseline.count || node !== baseline.node || text !== baseline.text);
    const active = generationActive();
    const now = Date.now();
    const changed = !!(isNew && text && text !== lastText);
    if (changed) {
      lastText = text; lastChangeAt = now;
      if (now - lastPostAt >= 120) {
        lastPostAt = now; lastSent = text;
        reportAnswer({ requestId, phase: 'stream', text, error: '', seq: nextSeq() });
      }
    }
    if ((changed || active) && settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (isNew && lastText && !active && !settleTimer) {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const current = answerTextOf(userNode ? assistantAfterUser(userNode) : (assistantNodes().slice(-1)[0] || null));
        if (!generationActive() && current && current === lastText && Date.now() - lastChangeAt >= 1800) {
          if (current !== lastSent) reportAnswer({ requestId, phase: 'stream', text: current, error: '', seq: nextSeq() });
          finish('final', current, '');
        } else scheduleInspect(80);
      }, 1900);
    }
  };
  const scheduleInspect = (delay) => {
    if (closed || inspectTimer) return;
    inspectTimer = setTimeout(inspect, delay == null ? 60 : delay);
  };
  const observer = new MutationObserver(() => scheduleInspect(60));
  const noAnswerTimer = setTimeout(() => {
    if (!lastText && !generationActive()) finish('error', '', 'No ChatGPT response was detected. Use Refresh to safely reconnect this request.');
  }, 45000);
  const limitTimer = setTimeout(() => {
    if (lastText) finish('final', lastText, 'Response monitoring reached its time limit.');
    else finish('error', '', 'Timed out while waiting for ChatGPT.');
  }, 180000);
  caAnswerWatchCleanup = cleanup;
  observer.observe(document.documentElement || document.body, { subtree: true, childList: true, characterData: true });
  reportAnswer({ requestId, phase: recovered ? 'recovered' : 'start', text: '', error: '', seq: nextSeq() });
  inspect();
}
async function recoverAnswer(requestId, expectedText) {
  let userNode = findMatchingUserNode(expectedText);
  const until = Date.now() + 2000;
  while (!userNode && Date.now() < until) { await sleep(100); userNode = findMatchingUserNode(expectedText); }
  if (!userNode) return { ok: true, found: false };
  const baseline = { count: 0, node: null, text: '' };
  startAssistantAnswerWatch(requestId, baseline, userNode, true);
  return { ok: true, found: true, hasAnswer: !!answerTextOf(assistantAfterUser(userNode)), generating: generationActive() };
}

async function insertAndSend(text, submit, meta) {
  log('insertAndSend', (text || '').length, 'chars', 'submit', submit !== false);
  const baseline = (submit !== false && meta && meta.returnToApp && meta.requestId) ? answerBaseline() : null;
  const userCountBefore = document.querySelectorAll('[data-message-author-role="user"]').length;
  if (baseline && generationActive()) throw new Error('ChatGPT is already generating a response. Wait for it to finish, then try again.');
  if (submit !== false && !baseline) caAnswerWatchToken++;   // a normal foreground send supersedes any older background watcher
  const el = await waitFor(findComposer, 8000);
  if (!el) { warn('composer NOT found (selectors may be stale)'); throw new Error('composer not found'); }
  log('composer found:', el.tagName, el.id || el.className);
  const ins = (submit === false) ? (text + '\n') : text;   // edit-before-send: leave the caret on a fresh line
  el.focus();
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ins);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    el.focus();
    try { document.execCommand('selectAll', false, null); } catch (e) {}
    const ok = document.execCommand('insertText', false, ins);
    log('execCommand insertText ->', ok);
    if (!ok) {
      el.textContent = ins;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ins, inputType: 'insertText' }));
    }
  }
  if (submit === false) {
    log('inserted only (edit before send)');
    try {
      el.focus();
      // drop the caret to the very end (after the trailing newline) so the user types on a fresh line
      const s = window.getSelection();
      if (s && el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
      el.scrollTop = el.scrollHeight;                        // scroll the grown composer to its end
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });   // bring the input form into view
    } catch (e) {}
    return true;
  }
  // React normally enables Send on the next render; a short yield is enough and avoids a fixed 250 ms delay.
  await sleep(35);
  const btn = await waitFor(() => { const b = findSendButton(); return (b && !b.disabled) ? b : null; }, 5000);
  if (btn) {
    log('clicking send button'); btn.click();
    const confirmed = await waitFor(() => document.querySelectorAll('[data-message-author-role="user"]').length > userCountBefore || generationActive(), 3500);
    if (!confirmed) throw new Error('ChatGPT did not confirm that the question was submitted. Use Refresh; do not press Send repeatedly.');
    if (baseline) startAssistantAnswerWatch(meta.requestId, baseline, null, false);
    return true;
  }
  warn('send button not found/enabled — falling back to Enter key');
  const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  const confirmed = await waitFor(() => document.querySelectorAll('[data-message-author-role="user"]').length > userCountBefore || generationActive(), 3500);
  if (!confirmed) throw new Error('ChatGPT did not confirm that the question was submitted. Use Refresh; do not press Send repeatedly.');
  if (baseline) startAssistantAnswerWatch(meta.requestId, baseline, null, false);
  return true;
}

function scrapeConversation() {
  const nodes = document.querySelectorAll('[data-message-author-role]');
  log('scrape: found', nodes.length, 'message nodes');
  if (nodes.length) {
    const parts = [];
    nodes.forEach((n) => {
      const role = n.getAttribute('data-message-author-role');
      const txt = (n.innerText || '').trim();
      if (txt) parts.push((role === 'user' ? 'User: ' : 'Assistant: ') + txt);
    });
    if (parts.length) return parts.join('\n\n');
  }
  const main = document.querySelector('main');
  return main ? (main.innerText || '').trim() : '';
}

// ---------- Bind button: a floating icon pinned next to the composer "+" ----------
// Rendered OUTSIDE React's DOM (position:fixed, appended to <body>) and moved to track the
// "+" button, so it never triggers React hydration errors (#418) or gets reconciled away.
// grey = not bound, blue = bound, orange = Caption assistance server unreachable.
const CA_BIND_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const CA_COPY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CA_CHECK_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
// VAR (not let): these are read by the icon render loop + message handlers at load time. `var` is
// hoisted + initialized to undefined (falsy), so an early read can NEVER throw a fatal TDZ that would
// halt the script mid-load (which previously left the module half-initialized + the tab stuck forever).
var caBound = false, caServerUp = true, caTick = 0;   // visible by default; hidden only once a poll confirms the app is DOWN
var caMicSource = 'system', caTeleOn = false, caLastAppSend = 0;
var caScrollTrig = 0.57, caScrollTarget = 0.35;   // auto-scroll: trigger when the read line is this far down, then scroll it to here (fractions of the viewport; set in Caption assistance)
var caScrollSpeed = 1.5;   // read-along scroll animation speed multiplier (1 = base, 1.5 = 50% faster); set in Caption assistance options
var caStale = false;   // extension was reloaded/updated -> this page's content script is orphaned
function ctxValid() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
// When the extension is reloaded/updated, THIS injected content script is orphaned (its chrome.* APIs
// throw "Extension context invalidated"). Auto-refresh the tab ONCE to load the fresh script, guarded
// with a short window so we never loop if the extension is actually gone.
let caReloaded = false;
function maybeAutoReload() {
  if (caReloaded) return; caReloaded = true;
  try { const k = 'caAutoReloadAt'; if (Date.now() - (+sessionStorage.getItem(k) || 0) < 6000) return; sessionStorage.setItem(k, String(Date.now())); } catch (e) {}
  location.reload();
}
function isStaleErr(e) { const m = String((e && e.message) || e); return /context invalidated|Receiving end does not exist|message (channel|port) closed/i.test(m); }
function markStale() {
  caStale = true;
  const btn = document.getElementById('ca-bind-btn');
  if (btn) { btn.style.color = '#b45309'; btn.title = 'Caption assistance extension was updated — reload this page (F5) to reconnect'; }
  log('content script orphaned -> reload the page to reconnect');
}
async function sendMsg(msg, tries) {
  tries = (tries == null) ? 2 : tries;
  for (let i = 0; i <= tries; i++) {
    if (!ctxValid()) throw new Error('context invalidated');
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) {
      const m = String((e && e.message) || e);
      if (/context invalidated/i.test(m)) throw e;
      if (i < tries && /Receiving end does not exist|message (channel|port) closed/i.test(m)) { await sleep(250); continue; }   // SW waking up -> retry
      throw e;
    }
  }
}
function applyBindColor(bound, serverUp) {
  if (typeof bound === 'boolean') caBound = bound;
  if (typeof serverUp === 'boolean') caServerUp = serverUp;
  const btn = document.getElementById('ca-bind-btn'); if (!btn || caStale) return;
  if (caServerUp === false) { btn.style.color = '#ea580c'; btn.title = 'Caption assistance not reachable — is the app running?'; return; }
  btn.style.color = caBound ? '#2f80ed' : '#8a8f98';
  btn.title = caBound ? 'Bound to Caption assistance — click to unbind' : 'Bind this ChatGPT tab to Caption assistance';
}
async function onBindClick(e) {
  e.preventDefault(); e.stopPropagation();
  if (caStale) { markStale(); return; }
  try { const r = await sendMsg({ action: 'toggleBind' }); log('toggleBind ->', r); applyBindColor(r && r.bound, r && r.serverUp); }
  catch (err) { if (isStaleErr(err)) markStale(); else warn('toggleBind failed:', err); }
}
async function refreshBindState() {
  if (caStale) return;
  try { const r = await sendMsg({ action: 'getBindState' }); applyBindColor(r && r.bound, r && r.serverUp); }
  catch (e) { if (isStaleErr(e)) markStale(); }
}
function ensureBindButton() {
  if (!ctxValid()) { const b = document.getElementById('ca-bind-btn'); if (b) b.remove(); return; }   // orphaned after extension reload
  const plus = document.querySelector('[data-testid="composer-plus-btn"]');
  let btn = document.getElementById('ca-bind-btn');
  if (!plus) { if (btn) btn.style.display = 'none'; return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ca-bind-btn'; btn.type = 'button';
    btn.setAttribute('aria-label', 'Bind to Caption assistance');
    btn.innerHTML = CA_BIND_ICON;
    Object.assign(btn.style, {
      position: 'fixed', zIndex: '2147483646', width: '34px', height: '34px', padding: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: '50%', background: 'transparent', cursor: 'pointer', color: '#8a8f98'
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(140,143,152,0.16)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', onBindClick);
    document.body.appendChild(btn);
    log('bind button created (floating)');
    applyBindColor(caBound, caServerUp);
    refreshBindState();
  }
  const xy = caIconXY(plus, 0);
  if (!xy || caServerUp === false) { btn.style.display = 'none'; return; }   // hide unless Caption assistance is alive
  btn.style.display = 'flex'; btn.style.left = xy.left + 'px'; btn.style.top = xy.top + 'px';
}
// Position: multi-line composer -> next to the "+" (bottom row is clear); one-line -> above the box
// top-right (next-to-"+" would sit on the "Ask ChatGPT" placeholder).
function caIconXY(plus, idx) {   // idx: 0=bind, 1=copy, 2=auto-scroll
  const box = plus.closest('form') || plus;
  const br = box.getBoundingClientRect(), pr = plus.getBoundingClientRect();
  if (!pr.width) return null;
  if (br.height >= 78) return { left: pr.right + 4 + idx * 34, top: pr.top + (pr.height - 34) / 2 };   // next to the "+", stacked rightward
  return { left: br.right - 42 - idx * 38, top: br.top - 40 };                                          // above the box, stacked leftward
}
// ---------- Copy button: copies the LAST ChatGPT answer; blinks a check for 0.5s ----------
function lastAnswerText() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) return '';
  const last = msgs[msgs.length - 1];
  const md = last.querySelector('.markdown') || last;
  return (md.innerText || md.textContent || '').trim();
}
async function onCopyClick(e) {
  e.preventDefault(); e.stopPropagation();
  const txt = lastAnswerText(); if (!txt) return;
  try { await navigator.clipboard.writeText(txt); }
  catch (err) { const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) {} ta.remove(); }
  const btn = document.getElementById('ca-copy-btn');
  if (btn) { btn.innerHTML = CA_CHECK_ICON; btn.style.color = '#2f80ed'; setTimeout(() => { btn.innerHTML = CA_COPY_ICON; btn.style.color = '#8a8f98'; }, 500); }   // 0.5s "checked" blink (blue, matching bind/scroll)
}
function ensureCopyButton() {
  if (!ctxValid()) { const b = document.getElementById('ca-copy-btn'); if (b) b.remove(); return; }
  const plus = document.querySelector('[data-testid="composer-plus-btn"]');
  let btn = document.getElementById('ca-copy-btn');
  if (!plus) { if (btn) btn.style.display = 'none'; return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ca-copy-btn'; btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy last ChatGPT answer'); btn.title = 'Copy the last answer';
    btn.innerHTML = CA_COPY_ICON;
    Object.assign(btn.style, {
      position: 'fixed', zIndex: '2147483646', width: '34px', height: '34px', padding: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: '50%', background: 'transparent', cursor: 'pointer', color: '#8a8f98'
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(140,143,152,0.16)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', onCopyClick);
    document.body.appendChild(btn);
  }
  const xy = caIconXY(plus, 2);   // copy is 3rd (after bind + auto-scroll)
  if (!xy || caServerUp === false) { btn.style.display = 'none'; return; }   // hide unless Caption assistance is alive
  btn.style.display = 'flex'; btn.style.left = xy.left + 'px'; btn.style.top = xy.top + 'px';
}
// ---------- Auto-scroll toggle: a floating icon that reflects + toggles GPT auto scroll ----------
const CA_SCROLL_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="15" y2="10"/><line x1="4" y1="14" x2="18" y2="14"/><polyline points="9 18 12 21 15 18"/><line x1="12" y1="21" x2="12" y2="15"/></svg>';
async function onScrollClick(e) {
  e.preventDefault(); e.stopPropagation();
  try { chrome.runtime.sendMessage({ action: 'toggleAutoscroll' }); } catch (err) {}
}
function ensureScrollButton() {
  if (!ctxValid()) { const b = document.getElementById('ca-scroll-btn'); if (b) b.remove(); return; }
  const plus = document.querySelector('[data-testid="composer-plus-btn"]');
  let btn = document.getElementById('ca-scroll-btn');
  if (!plus) { if (btn) btn.style.display = 'none'; return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ca-scroll-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Toggle GPT auto scroll');
    btn.innerHTML = CA_SCROLL_ICON;
    Object.assign(btn.style, { position: 'fixed', zIndex: '2147483646', width: '34px', height: '34px', padding: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: '50%', background: 'transparent', cursor: 'pointer', color: '#8a8f98' });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(140,143,152,0.16)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', onScrollClick);
    document.body.appendChild(btn);
  }
  const xy = caIconXY(plus, 1);   // auto-scroll is 2nd (right after bind)
  if (!xy || caServerUp === false) { btn.style.display = 'none'; return; }
  btn.style.display = 'flex'; btn.style.left = xy.left + 'px'; btn.style.top = xy.top + 'px';
  btn.style.color = caTeleOn ? '#2f80ed' : '#8a8f98';   // blue when ON (same as the bind icon), grey when off
  btn.title = caTeleOn ? 'GPT auto scroll: ON — click to turn off' : 'GPT auto scroll: off — click to turn on';
}
// Position: multi-line composer -> next to the "+" (bottom row is clear); one-line -> above the box
ensureBindButton(); ensureCopyButton(); ensureScrollButton();
setInterval(() => { ensureBindButton(); ensureCopyButton(); ensureScrollButton(); if ((caTick++ % 8) === 0) refreshBindState(); }, 600);   // reposition ~0.6s, refresh state ~5s
// Command delivery uses the service worker's pending /wait request. This adaptive heartbeat is now
// state-only: fast enough for read-along while it is active, quiet while idle.
(function bridgeHeartbeat() {
  const delay = caBound && caTeleOn ? 250 : (caBound ? 1200 : 3000);
  setTimeout(() => {
    if (ctxValid()) { try { const p = chrome.runtime.sendMessage({ action: 'tick' }); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    else maybeAutoReload();
    bridgeHeartbeat();
  }, delay);
})();

// ================= read-along teleprompter =================
// Runs the PhonoDTW engine (match-engine.js, loaded before this script) against the LAST assistant
// answer and marks + smart-scrolls the line the user is currently reading aloud. The mic caption is
// the CLEAN accumulated transcript pushed from Caption assistance (deduped there).
const TP = { on: false, eng: null, scroller: null, sents: [], hash: '' };
function tpStyle() {
  if (document.getElementById('ca-tp-style')) return;
  const s = document.createElement('style'); s.id = 'ca-tp-style';
  s.textContent = '::highlight(ca-read){ background-color: rgba(180,186,194,.20); }';
  (document.head || document.documentElement).appendChild(s);
}
function tpScrollContainer(el) {
  let n = el && el.parentElement;
  while (n && n !== document.body) {
    const st = getComputedStyle(n);
    if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
// split ONE block into sentences, each mapped to precise (textNode, offset) start/end so we can build
// an exact Range even when a sentence spans <strong>/<code> children.
function tpSentencesOf(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let full = '';
  let node; while ((node = walker.nextNode())) { const t = node.textContent; if (!t) continue; nodes.push({ node: node, start: full.length }); full += t; }
  if (!full.trim() || !nodes.length) return [];
  const locate = (off) => {
    for (let i = nodes.length - 1; i >= 0; i--) { if (off >= nodes[i].start) { const nd = nodes[i]; return { node: nd.node, offset: Math.min(off - nd.start, nd.node.textContent.length) }; } }
    return { node: nodes[0].node, offset: 0 };
  };
  const out = []; const re = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g; let m;
  while ((m = re.exec(full)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    let s = m.index, e = m.index + m[0].length;
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    if (e <= s) continue;
    const a = locate(s), b = locate(e);
    out.push({ text: full.slice(s, e), block: block, sNode: a.node, sOff: a.offset, eNode: b.node, eOff: b.offset });
  }
  return out;
}
function tpExtract() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) return null;
  const md = msgs[msgs.length - 1].querySelector('.markdown') || msgs[msgs.length - 1];
  const blocks = [];
  md.querySelectorAll(':scope > *').forEach((ch) => {
    const tag = ch.tagName ? ch.tagName.toLowerCase() : '';
    if (tag === 'ul' || tag === 'ol') ch.querySelectorAll(':scope > li').forEach((li) => blocks.push(li));
    else if (ch.textContent && ch.textContent.trim()) blocks.push(ch);
  });
  if (!blocks.length) blocks.push(md);
  let sents = []; blocks.forEach((b) => { sents = sents.concat(tpSentencesOf(b)); });
  return sents.filter((s) => s.text && s.text.trim());
}
function tpRange(s) {
  const rg = document.createRange();
  rg.setStart(s.sNode, Math.min(s.sOff, s.sNode.textContent.length));
  rg.setEnd(s.eNode, Math.min(s.eOff, s.eNode.textContent.length));
  return rg;
}
// which sentences of the tracked answer are currently ON SCREEN -> fed to the matcher's viewport prior
// so ambiguous/duplicate sentences resolve to the one the reader is actually looking at.
var caVisT = 0, caVisCache = null;
function caVisibleRange() {
  var now = Date.now();
  if (caVisCache !== undefined && now - caVisT < 250) return caVisCache;   // throttle getBoundingClientRect reads
  caVisT = now;
  if (!TP.sents || !TP.sents.length) { caVisCache = null; return null; }
  var vh = window.innerHeight || document.documentElement.clientHeight || 0, lo = null, hi = null;
  for (var i = 0; i < TP.sents.length; i++) {
    var rb; try { rb = tpRange(TP.sents[i]).getBoundingClientRect(); } catch (e) { continue; }
    if (!rb || (!rb.height && !rb.width)) continue;
    if (rb.bottom > 0 && rb.top < vh) { if (lo === null) lo = i; hi = i; }   // overlaps the viewport
  }
  caVisCache = (lo === null) ? null : { lo: lo, hi: hi };
  return caVisCache;
}
function tpClearHl() { try { if (window.CSS && CSS.highlights) CSS.highlights.delete('ca-read'); } catch (e) {} }
function tpEnsure() {
  const ME = window.MatchEngine; if (!ME) { log('teleprompter: match-engine.js not loaded'); return false; }
  const sents = tpExtract(); if (!sents || !sents.length) return false;
  const lines = sents.map((s) => s.text.replace(/\s+/g, ' ').trim());
  const hash = lines.join('');
  if (hash !== TP.hash) {
    tpClearHl();
    TP.sents = sents; TP.hash = hash;
    caMarkedLine = -1;     // new answer -> start marking fresh from the top
    caBuildVocab(lines);   // refresh the answer-vocabulary used to rescore Chrome's hypotheses
    // FREE navigation: the reader jumps forward/back between sentences; detect the position globally + fast
    // paragraph index per sentence (sentences share a .block within one paragraph/li) -> lets the matcher
    // penalize a jump into the MIDDLE of another paragraph (readers jump to a paragraph START, not mid-way)
    var pI = 0; var paraOf = sents.map(function (s, i) { if (i > 0 && s.block !== sents[i - 1].block) pI++; return pI; });
    TP.eng = new ME.PhonoDTW(lines, { FREE: true, FREE_SIGMA: 50, MIN_WINDOW: 2, CONFIRM_PARTIAL: 1, CONFIRM_FINAL: 1, VIEW_BONUS: true, VIEW_MARGIN: 1, paraOf: paraOf });   // VIEW_BONUS = hard-gate to on-screen sentences; paraOf = mid-paragraph jump penalty
    TP.scroller = new ME.SmartScroller(tpScrollContainer(sents[0].block), { CONF_MIN: 0.25, TRIGGER_P: caScrollTrig, TARGET_P: caScrollTarget, SPEED: caScrollSpeed, USE_VIEWPORT: true, FORWARD_ONLY: false });
    log('teleprompter: tracking', lines.length, 'sentences of the last answer');
  }
  return true;
}
const TELE_CONF_MIN = 0.28;   // confidence needed to move the mark backward / re-confirm
const TELE_CONF_FWD = 0.15;   // reader moves forward, so trust low-confidence forward moves (garbled ASR still scores low even when the line is right)
let caMarkedLine = -1;        // last line we actually highlighted
function teleMic(msg) {
  const wasOn = TP.on;
  TP.on = !!msg.teleOn;
  if (TP.on !== wasOn) log('read-along', TP.on ? 'ENABLED' : 'disabled');
  if (msg.mic && msg.mic.text != null) log('mic caption [' + String(msg.mic.text).length + ' ch]: …' + String(msg.mic.text).slice(-70));   // caption growing
  if (!TP.on) { tpClearHl(); return; }
  tpStyle();
  caPanelShow(true);
  if (msg.mic && msg.mic.text != null) caPanelHeard(msg.mic.text);
  if (!msg.mic || msg.mic.text == null) return;
  if (!window.MatchEngine) { log('read-along: match-engine.js NOT loaded — reload the extension AND this tab'); caPanelNote('match-engine.js not loaded — reload the extension + tab'); return; }
  if (!tpExtract() || !tpExtract().length) { log('read-along: no assistant answer on this page to track yet'); caPanelNote('no ChatGPT answer on this page to track yet'); return; }
  if (!tpEnsure()) return;
  const r = TP.eng.update(msg.mic.text, msg.mic.status || 'partial', caVisibleRange());
  const s = TP.sents[r.lineIndex];
  const conf = (r.confidence || 0);
  // forward moves (reader advancing) only need a low bar; backward moves need the full bar
  const gate = (r.lineIndex >= caMarkedLine) ? TELE_CONF_FWD : TELE_CONF_MIN;
  const marked = conf >= gate;
  const act = marked ? 'MARK' : 'HOLD (low conf)';
  log('read-along L' + r.lineIndex + '/' + TP.sents.length + ' conf=' + conf.toFixed(2) + ' [' + act + ']'
    + (s ? '  line="' + s.text.slice(0, 46) + (s.text.length > 46 ? '…' : '') + '"' : '')
    + '  mic="…' + String(msg.mic.text).slice(-46) + '"');
  caPanelMatch(s ? s.text : '', r.lineIndex, TP.sents.length, conf, marked);
  if (!marked) return;   // not confident enough -> leave the mark where it is
  if (!s) return;
  caMarkedLine = r.lineIndex;
  try {
    const rg = tpRange(s);
    if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('ca-read', new Highlight(rg));   // mark the exact sentence
    if (TP.scroller) { TP.scroller.c = tpScrollContainer(s.block); const rect = rg.getBoundingClientRect(); if (rect.height) TP.scroller.onUpdate({ getBoundingClientRect: () => rect, offsetHeight: rect.height }, conf, r.lineIndex); }
  } catch (e) { log('teleMic mark/scroll error', e); }
}

// ===== Chrome speech read-along =====================================================================
// The Windows speech engine can't caption some mics (e.g. NewCoo -> UserCanceled). Chrome's own
// recognizer captures the mic through the browser and works with those devices, so when GPT auto
// scroll is on we run recognition right here and feed the same PhonoDTW engine — no Caption assistance
// mic-reader needed. Trade-off: audio goes to the browser's speech service (Google) while active.
let sr = null, srWant = false, srCommitted = '', srPartial = '', srLast = 0, srWarnedNoPerm = false;
let srCreatedAt = 0, srAlive = false, srWatch = null, srNetErrs = 0, srRestartPending = false;
// caMicSource / caTeleOn / caLastAppSend are declared near the top (the icon loop reads them at load)
// push the Chrome-speech mic caption to Caption assistance so it records/shows it (independent of auto scroll)
function caPostMicToApp(text, status) {
  var now = Date.now();
  if (status !== 'final' && now - caLastAppSend < 400) return;   // throttle partials
  caLastAppSend = now;
  try { chrome.runtime.sendMessage({ action: 'micToApp', text: text, status: status }); } catch (e) {}
}
// tell the app which mic Chrome is using -- via enumerateDevices (does NOT grab the mic, so it can't
// starve the speech recognizer, which was breaking capture when we used getUserMedia here).
var caLastMicLabel = '';
function caReportBrowserMic(force) {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      var ins = list.filter(function (x) { return x.kind === 'audioinput' && x.label; });
      var d = ins.find(function (x) { return x.deviceId === 'default'; }) || ins[0];
      var label = (d && d.label) || '';
      if (label && (force || label !== caLastMicLabel)) { caLastMicLabel = label; try { chrome.runtime.sendMessage({ action: 'browserMic', label: label }); } catch (e) {} }   // only send when the mic actually changes
    }).catch(function () {});
  } catch (e) {}
}
// re-report when Chrome's device list / default mic changes (so switching mic in the browser updates the app)
try { if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', function () { caReportBrowserMic(); }); } catch (e) {}
const SR_LANG = 'en-US';
function haveWebSpeech() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
// Teleprompter edge: we KNOW the target text (the answer on screen), so when Chrome returns several
// hypotheses we keep the one whose words best match the answer's vocabulary (rarer words weigh more).
// This quietly corrects homophones/mishears ("reception" -> "recursion") before the matcher sees them.
let caVocab = null, caVocabIdf = null;
function caBuildVocab(lines) {
  caVocab = new Set(); const df = {}; const N = lines.length || 1;
  for (const l of lines) { const seen = new Set(String(l).toLowerCase().split(/[^a-z0-9']+/).filter(Boolean)); for (const w of seen) { caVocab.add(w); df[w] = (df[w] || 0) + 1; } }
  caVocabIdf = {}; for (const w of caVocab) caVocabIdf[w] = Math.log(1 + N / (df[w] || 1));
}
function caPickAlt(res) {
  if (!res || res.length <= 1 || !caVocab || !caVocab.size) return res[0].transcript;
  let best = res[0].transcript, bestScore = -Infinity;
  for (let i = 0; i < res.length; i++) {
    const words = res[i].transcript.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    if (!words.length) continue;
    let sc = 0; for (const w of words) if (caVocab.has(w)) sc += (caVocabIdf[w] || 1);
    sc -= i * 0.15;   // tie-break toward Chrome's own ranking when overlap is equal
    if (sc > bestScore) { bestScore = sc; best = res[i].transcript; }
  }
  return best;
}
// merge b onto a, dropping any word overlap between a's tail and b's head. The recognizer restarts on
// every pause and re-recognizes the tail of the audio, which used to APPEND a duplicate ("concrete
// settles slowly ... concrete settles slowly ..."); collapsing the overlap removes it at the source.
function caMergeAppend(a, b) {
  a = String(a || '').trim(); b = String(b || '').trim();
  if (!a) return b; if (!b) return a;
  const aw = a.split(/\s+/), bw = b.split(/\s+/);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  const max = Math.min(aw.length, bw.length, 14);
  let ov = 0;
  for (let k = max; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) if (norm(aw[aw.length - k + i]) !== norm(bw[i])) { ok = false; break; }
    if (ok) { ov = k; break; }
  }
  if (ov >= bw.length) return a;   // b already fully contained in a's tail -> nothing new
  return aw.concat(bw.slice(ov)).join(' ');
}
// ===== single recognizer (Chrome allows only ONE active SpeechRecognition at a time) ================
function scheduleSpeechRestart(delay) { if (srRestartPending || !srWant) return; srRestartPending = true; setTimeout(function () { srRestartPending = false; startSpeech(); }, delay); }
function startSpeech() {
  if (sr || !srWant || !haveWebSpeech()) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  try { sr = new SR(); } catch (e) { log('read-along: cannot create recognizer', e); sr = null; return; }
  srCreatedAt = Date.now(); srAlive = false;
  sr.continuous = true; sr.interimResults = true; sr.lang = SR_LANG; sr.maxAlternatives = 6;
  sr.onstart = () => { srAlive = true; log('read-along: Chrome speech recognition STARTED'); };
  sr.onaudiostart = () => { srAlive = true; };
  sr.onresult = (e) => {
    srAlive = true; srNetErrs = 0;
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = caPickAlt(e.results[i]); if (e.results[i].isFinal) final += t + ' '; else interim += t + ' '; }
    if (srLast && Date.now() - srLast > 2500) { srCommitted = ''; srPartial = ''; }   // long pause -> fresh recognition window (KEEP the full heard log)
    srLast = Date.now();
    if (final.trim()) { srCommitted = caMergeAppend(srCommitted, final.trim()); caFullHeard = caMergeAppend(caFullHeard, final.trim()); if (caFullHeard.length > 40000) caFullHeard = caFullHeard.slice(-40000); srPartial = ''; caSaveHeard(); }
    if (interim.trim()) srPartial = interim.trim();
    if (srCommitted.length > 1800) srCommitted = srCommitted.slice(-1800);
    const full = (srCommitted + ' ' + srPartial).trim();
    if (full) {
      if (caTeleOn) teleMic({ teleOn: true, mic: { text: full, status: final.trim() ? 'final' : 'partial' } });   // read-along (only when auto scroll on)
      caPostMicToApp(full, final.trim() ? 'final' : 'partial');   // ALWAYS record it in Caption assistance
    }
    if (caEnabled) caPanelHeard((caFullHeard + ' ' + srPartial).trim());
  };
  sr.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { if (!srWarnedNoPerm) { log('read-along: microphone permission blocked — Allow it in the address bar, then toggle GPT auto scroll off/on'); srWarnedNoPerm = true; } srWant = false; }
    else if (e.error === 'network') { srNetErrs = Math.min(srNetErrs + 1, 6); }
    else if (e.error !== 'no-speech' && e.error !== 'aborted') { log('read-along: speech ended (' + e.error + '), restarting'); }
  };
  sr.onend = () => { sr = null; srAlive = false; if (srWant) scheduleSpeechRestart(srNetErrs ? Math.min(srNetErrs * 500, 3000) : 150); };   // restart on pause; 150ms keeps blinking lower than 80
  try { sr.start(); } catch (e) { sr = null; scheduleSpeechRestart(300); }
}
function speechWatchdog() {
  if (!srWant || srRestartPending) return;
  caReportBrowserMic();   // cheap; only messages the app when the selected mic actually changed
  if (!sr) { startSpeech(); return; }
  if (!srAlive && Date.now() - srCreatedAt > 3500) { try { sr.onend = null; sr.abort(); } catch (e) {} sr = null; scheduleSpeechRestart(srNetErrs ? 800 : 150); }
}
function stopSpeech() { if (srWatch) { clearInterval(srWatch); srWatch = null; } if (sr) { try { sr.onend = null; sr.stop(); } catch (e) {} sr = null; } srAlive = false; srCommitted = ''; srPartial = ''; tpClearHl(); }
function setSpeechWant(on) {
  if (on === srWant) return;
  srWant = on;
  if (on) { caLastMicLabel = ''; caReportBrowserMic(true); log('read-along: starting Chrome speech capture'); startSpeech(); if (!srWatch) srWatch = setInterval(speechWatchdog, 1500); }
  else { log('read-along: GPT auto scroll off — stopping speech capture'); TP.on = false; stopSpeech(); }
  caPanelDot();   // reflect speech state in the dot only; panel visibility is driven by the console toggle (no blink)
}

// ===== on-page test console: watch your captions + what the engine matches, side by side =========
let caPanel = null, caHeardEl = null, caMatchEl = null, caLogEl = null, caClosed = false, caEnabled = false, caFullHeard = '';
try { caFullHeard = localStorage.getItem('caHeardLog') || ''; } catch (e) {}   // restore the heard log so it survives page reload / console close+reopen
var caHeardSaveT = 0;
function caSaveHeard() { const now = Date.now(); if (now - caHeardSaveT < 1200) return; caHeardSaveT = now; try { localStorage.setItem('caHeardLog', caFullHeard); } catch (e) {} }
let caPanelVis = false;   // tracks the panel's ACTUAL display state so show/hide is idempotent (never thrashes -> no blink)
function caSetEnabled(on) {
  on = !!on;
  if (on && !caEnabled) caClosed = false;   // OFF->ON from the app: forget a previous manual close so it can show again
  caEnabled = on;
  caPanelShow(on);   // visibility follows the console TOGGLE only (not the flapping speech state) -> no blink on bind
}
function caPanelDot() { if (caPanel && caPanelVis) { const d = caPanel.querySelector('#ca-tc-dot'); if (d) d.style.background = srWant ? '#7ee081' : '#f5c518'; } }
function caEsc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function caPanelEnsure() {
  if (caPanel) {
    if (document.documentElement.contains(caPanel)) return;
    try { (document.body || document.documentElement).appendChild(caPanel); return; } catch (e) {}   // re-attach the SAME panel (don't rebuild -> no blink)
  }
  caPanel = document.createElement('div');
  caPanel.id = 'ca-test-console';
  caPanel.style.cssText = 'display:none;position:fixed;left:16px;bottom:16px;width:390px;max-width:46vw;z-index:2147483646;'   // hidden by default -> only caPanelShow(true) reveals it (no create-visible flash on load/refresh)
    + 'background:rgba(17,20,28,.95);color:#e6e9ef;border:1px solid #3a4152;border-radius:11px;'
    + 'font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;max-height:calc(100vh - 32px);';
  caPanel.innerHTML =
      '<div id="ca-tc-head" style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#1b2030;cursor:move;border-bottom:1px solid #3a4152;user-select:none;">'
    +   '<span id="ca-tc-dot" style="width:8px;height:8px;border-radius:50%;background:#f5c518;box-shadow:0 0 7px #f5c518;flex:0 0 auto;"></span>'
    +   '<b style="font-weight:700;letter-spacing:.2px;">Caption assistance &mdash; read-along test</b>'
    +   '<span id="ca-tc-copy" title="copy original answer + full heard transcript" style="margin-left:auto;cursor:pointer;padding:2px 7px;font-size:11px;line-height:1;border:1px solid #46506a;border-radius:6px;opacity:.85;">copy</span>'
    +   '<span id="ca-tc-close" title="hide" style="cursor:pointer;padding:0 4px;font-size:16px;line-height:1;opacity:.65;">&times;</span>'
    + '</div>'
    + '<div style="padding:9px 11px;">'
    +   '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px;"><span style="opacity:.5;font-size:10px;text-transform:uppercase;letter-spacing:.7px;">&#127908; heard (your voice)</span><span id="ca-tc-clear" title="clear" style="margin-left:auto;cursor:pointer;font-size:10px;opacity:.5;">clear</span></div>'
    +   '<div id="ca-tc-heard" style="height:30vh;overflow:auto;color:#9fd0ff;word-break:break-word;white-space:pre-wrap;user-select:text;-webkit-user-select:text;background:rgba(0,0,0,.22);border-radius:6px;padding:7px 9px;font-size:12.5px;line-height:1.5;">waiting for speech&hellip;</div>'
    +   '<div style="opacity:.5;font-size:10px;text-transform:uppercase;letter-spacing:.7px;margin:9px 0 3px;">&#127919; matched answer line</div>'
    +   '<div id="ca-tc-match" style="min-height:20px;">&mdash;</div>'
    +   '<div id="ca-tc-log" style="margin-top:9px;height:66px;overflow:auto;border-top:1px solid #2a3040;padding-top:7px;font-size:11px;opacity:.9;"></div>'
    + '</div>';
  (document.body || document.documentElement).appendChild(caPanel);
  caHeardEl = caPanel.querySelector('#ca-tc-heard');
  caMatchEl = caPanel.querySelector('#ca-tc-match');
  caLogEl = caPanel.querySelector('#ca-tc-log');
  caPanel.querySelector('#ca-tc-close').onclick = () => { caClosed = true; caPanel.style.display = 'none'; try { chrome.runtime.sendMessage({ action: 'consoleClosed' }); } catch (e) {} };   // sync the app toggle off
  caPanel.querySelector('#ca-tc-copy').onclick = () => caPanelCopy();
  caPanel.querySelector('#ca-tc-clear').onclick = () => { caFullHeard = ''; srCommitted = ''; srPartial = ''; caPanelHeard(''); try { localStorage.removeItem('caHeardLog'); } catch (e) {} };
  const head = caPanel.querySelector('#ca-tc-head'); let dx = 0, dy = 0, drag = false;
  head.addEventListener('mousedown', (e) => { drag = true; const r = caPanel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; caPanel.style.left = Math.max(0, e.clientX - dx) + 'px'; caPanel.style.top = Math.max(0, e.clientY - dy) + 'px'; caPanel.style.bottom = 'auto'; });
  window.addEventListener('mouseup', () => { drag = false; });
}
function caPanelShow(on) {
  const want = !!on && caEnabled && !caClosed;
  caPanelEnsure();
  if (want === caPanelVis) { caPanelDot(); return; }   // already in the wanted state -> no display write, no blink
  caPanelVis = want;
  caPanel.style.display = want ? 'block' : 'none';
  if (want) { caPanelDot(); caPanelHeard((caFullHeard + ' ' + srPartial).trim()); }   // reveal history captured while hidden
}
function caPanelHeard(text) {
  caPanelEnsure(); if (!caHeardEl) return;
  const atBottom = caHeardEl.scrollTop + caHeardEl.clientHeight >= caHeardEl.scrollHeight - 24;
  caHeardEl.textContent = text ? String(text) : 'waiting for speech…';
  if (atBottom) caHeardEl.scrollTop = caHeardEl.scrollHeight;   // follow along unless you scrolled up to read
}
function caPanelCopy() {
  const answer = (TP.sents || []).map((s, i) => (i + 1) + '. ' + s.text).join('\n') || '(no answer captured on the page)';
  const heard = (caFullHeard + ' ' + srPartial).trim() || '(nothing heard yet)';
  const dump = '=== ORIGINAL ANSWER (' + (TP.sents ? TP.sents.length : 0) + ' lines) ===\n' + answer
    + '\n\n=== HEARD (Chrome speech, full) ===\n' + heard + '\n';
  const done = (ok) => { const b = caPanel && caPanel.querySelector('#ca-tc-copy'); if (b) { b.textContent = ok ? 'copied' : 'copy failed'; setTimeout(() => { b.textContent = 'copy'; }, 1200); } };
  try { navigator.clipboard.writeText(dump).then(() => done(true), () => done(false)); }
  catch (e) { try { const ta = document.createElement('textarea'); ta.value = dump; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(true); } catch (e2) { done(false); } }
}
function caPanelNote(note) { caPanelEnsure(); if (caMatchEl) caMatchEl.innerHTML = '<span style="color:#c98a1a;">' + caEsc(note) + '</span>'; }
function caPanelMatch(lineText, idx, total, conf, marked) {
  caPanelEnsure(); if (!caMatchEl) return;
  const col = marked ? '#7ee081' : '#c9a24a';
  caMatchEl.innerHTML = '<span style="color:' + col + ';font-weight:700;">L' + idx + '/' + total + '&nbsp;&nbsp;conf ' + conf.toFixed(2) + '&nbsp;&nbsp;' + (marked ? 'MARK' : 'HOLD') + '</span>'
    + (lineText ? '<div style="opacity:.92;margin-top:3px;">' + caEsc(lineText) + '</div>' : '');
  if (caLogEl) {
    const row = document.createElement('div');
    row.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:1px 0;';
    row.innerHTML = '<span style="color:' + col + ';">L' + idx + '&nbsp;' + conf.toFixed(2) + '</span> <span style="opacity:.7;">' + caEsc((lineText || '').slice(0, 46)) + '</span>';
    caLogEl.prepend(row);
    while (caLogEl.childNodes.length > 40) caLogEl.removeChild(caLogEl.lastChild);
  }
}
