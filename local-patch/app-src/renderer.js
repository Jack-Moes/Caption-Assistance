// renderer.js -- screen flow, session library, live captions, smart selection
const $ = (id) => document.getElementById(id);

// ===== in-app debug console: capture renderer + main logs/errors so they're catchable on machines
// without DevTools. Toggle from Settings or Ctrl+Shift+D; copy to share for fixing. =====
(function () {
  const BUF = [], MAX = 1200;
  function line(level, msg) {
    const ts = new Date().toTimeString().slice(0, 8);
    const rec = { level: level, text: ts + '  ' + msg };
    BUF.push(rec); if (BUF.length > MAX) BUF.shift();
    const log = document.getElementById('dbgLog');
    if (log && log.offsetParent !== null) {
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      appendRow(log, rec);
      while (log.childNodes.length > MAX) log.removeChild(log.firstChild);
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    const c = document.getElementById('dbgCount'); if (c) c.textContent = BUF.length + ' lines';
  }
  function appendRow(log, rec) { const d = document.createElement('div'); d.className = 'lv-' + rec.level; d.textContent = rec.text; log.appendChild(d); }
  const fmt = function (args) { return Array.prototype.map.call(args, function (x) { return (typeof x === 'string') ? x : (function () { try { return JSON.stringify(x); } catch (e) { return String(x); } })(); }).join(' '); };
  ['log', 'info', 'warn', 'error'].forEach(function (lvl) {
    const orig = console[lvl] ? console[lvl].bind(console) : function () {};
    console[lvl] = function () { orig.apply(null, arguments); try { line(lvl === 'info' ? 'log' : lvl, fmt(arguments)); } catch (e) {} };
  });
  window.addEventListener('error', function (e) { line('error', 'window.onerror: ' + (e.message || '') + '  @ ' + (e.filename || '').split('/').pop() + ':' + (e.lineno || '')); });
  window.addEventListener('unhandledrejection', function (e) { line('error', 'unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason || '')); });
  // main-process logs (arrive via IPC) + the buffered ones from before the window loaded
  try { if (window.cap && window.cap.onDebugLog) window.cap.onDebugLog(function (d) { line(d.level === 'warn' ? 'warn' : d.level === 'error' ? 'error' : 'log', d.msg); }); } catch (e) {}
  try { if (window.cap && window.cap.getDebugLog) window.cap.getDebugLog().then(function (rows) { (rows || []).forEach(function (r) { BUF.unshift({ level: r.level === 'warn' ? 'warn' : r.level === 'error' ? 'error' : 'log', text: r.msg }); }); }).catch(function () {}); } catch (e) {}
  function show(on) {
    const p = document.getElementById('dbgPanel'); if (!p) return;
    p.style.display = on ? 'flex' : 'none';
    const t = document.getElementById('dbgToggle'); if (t) t.checked = on;
    if (on) { const log = document.getElementById('dbgLog'); if (log) { log.innerHTML = ''; BUF.forEach(function (r) { appendRow(log, r); }); log.scrollTop = log.scrollHeight; } const c = document.getElementById('dbgCount'); if (c) c.textContent = BUF.length + ' lines'; }
  }
  window.__caDbgShow = show; window.__caDbg = BUF;
  document.addEventListener('DOMContentLoaded', wire); if (document.readyState !== 'loading') wire();
  function wire() {
    const t = document.getElementById('dbgToggle'); if (t && !t._w) { t._w = 1; t.addEventListener('change', function () { show(t.checked); }); }
    const cl = document.getElementById('dbgClose'); if (cl && !cl._w) { cl._w = 1; cl.onclick = function () { show(false); }; }
    const clr = document.getElementById('dbgClear'); if (clr && !clr._w) { clr._w = 1; clr.onclick = function () { BUF.length = 0; const log = document.getElementById('dbgLog'); if (log) log.innerHTML = ''; const c = document.getElementById('dbgCount'); if (c) c.textContent = '0 lines'; }; }
    const cp = document.getElementById('dbgCopy'); if (cp && !cp._w) { cp._w = 1; cp.onclick = function () { const txt = BUF.map(function (r) { return r.text; }).join('\n'); try { navigator.clipboard.writeText(txt).then(function () { cp.textContent = 'copied'; setTimeout(function () { cp.textContent = 'copy'; }, 1000); }); } catch (e) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) {} ta.remove(); cp.textContent = 'copied'; setTimeout(function () { cp.textContent = 'copy'; }, 1000); } }; }
  }
  window.addEventListener('keydown', function (e) { if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); const p = document.getElementById('dbgPanel'); show(!(p && p.style.display === 'flex')); } });
})();

let screen = 'home';
let review = false;
let accumulate = true;
let autoscroll = true;
let alwaysTop = false;   // on-top OFF by default; toggled by the ↑ header button
let mode = 'Standard';
try { mode = localStorage.getItem('caMode') || 'Standard'; } catch (e) {}
let sessionStart = 0;
let timerInt = null;
let isDragging = false;      // user is actively drag-selecting -> freeze DOM updates
let programmaticScroll = false;
let pendingRender = false;
let captureStopped = false;  // set when END is pressed -> ingestion halts immediately
let frozenElapsed = 0;       // session seconds captured at END (so the saved duration is correct)
let dirtyFrom = Infinity;    // lowest paragraph index changed since last render
let resumeAnchor = null;     // after a send: {paraIdx, offset} to restart select-till-end from
let busy = false, busyTimer = null, busyBtn = null;   // a ChatGPT action is in flight -> spinner on the clicked button, block re-clicks
let sentMarks = [];          // caption positions the user sent from (send/aa/compact/paste) -> visual markers
let followStopped = false;   // "stop snipping": freeze the growing select-till-end selection
let lastConn = 0, connBound = false;   // ChatGPT bridge connection indicator
let answerInApp = false;
try { answerInApp = localStorage.getItem('ca_answer_in_app') === '1'; } catch (e) {}
let answerRequestId = '', answerSeq = -1, answerText = '', answerPhase = 'ready', answerRecovering = false;

const captionEl = $('caption');

// ================= segment model (one paragraph per Live Captions line) =================
// Windows Live Captions puts REAL newlines between its segments. Each newline
// segment becomes a timestamped paragraph. Segments are matched across the
// rolling window so the growing last line updates in place while finished lines
// keep their original timestamp.
let paragraphs = [];        // the CURRENTLY DISPLAYED transcript [{ t, ts, text, src }] (= active source, or merged)
let speakerParas = [];      // Live Captions source (the interviewer / system audio)
let micParas = [];          // microphone source (you) -- captured continuously so the view can switch
let micOpen = false;        // is the current mic utterance still growing (a partial not yet finalised)?
let viewMode = 'speaker';   // 'speaker' | 'mic' | 'both' -- which source(s) the caption window shows
let speakerEngine = 'system', micEngine = 'browser';   // per-source STT backends, chosen independently in Settings
let speakerOpen = false;    // cloud speaker utterance still growing?
let caLastChromeMic = 0;    // last time the extension fed a Chrome-speech mic caption (preferred over WinRT)
const MAX_PARAS = 3000;      // cap retained paragraphs so long sessions stay responsive
function segTokens(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean); }
// Two readings are the SAME Live Captions segment when they overlap heavily. LC
// revises the HEAD (prepends words, fixes homophones) and grows the TAIL of the
// live segment, so an exact leading-word match both mis-splits (duplicates) a
// revised line AND falsely merges distinct short lines. Score by the longest
// common contiguous run of words as a fraction of the shorter segment.
function segSim(a, b) {
  const ta = segTokens(a), tb = segTokens(b);
  if (!ta.length || !tb.length) return 0;
  const short = ta.length <= tb.length ? ta : tb, long = ta.length <= tb.length ? tb : ta;
  let best = 0;
  for (let i = 0; i < long.length && long.length - i > best; i++) {
    for (let j = 0; j < short.length && short.length - j > best; j++) {
      let k = 0;
      while (i + k < long.length && j + k < short.length && long[i + k] === short[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best / short.length;
}
function segEqual(a, b) {
  const na = segTokens(a).length, nb = segTokens(b).length;
  if (!na || !nb) return false;
  // very short lines must match near-exactly so distinct fillers ("OK"/"yeah") don't merge
  return segSim(a, b) >= (Math.min(na, nb) <= 3 ? 0.9 : 0.6);
}
function segOverlap(pTexts, wSegs) {   // align the window's leading segments with the paragraph tail
  const maxK = Math.min(pTexts.length, wSegs.length);
  for (let k = maxK; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) { if (!segEqual(pTexts[pTexts.length - k + i], wSegs[i])) { ok = false; break; } }
    if (ok) return k;
  }
  return 0;
}
function segRunAt(pTexts, wSegs, base) {   // how many window segs line up with paragraphs starting at index `base`
  let k = 0;
  while (base + k < pTexts.length && k < wSegs.length && segEqual(pTexts[base + k], wSegs[k])) k++;
  return k;
}
// Live Captions can re-emit an EARLIER region (its buffer resets, or the reader restarts) so the
// window's head no longer touches the paragraph tail -> the old tail-overlap check returned 0 and
// the whole block got appended AGAIN (the duplication bug). Find where this window actually sits
// in the recent transcript so we replace-in-place instead of re-appending.
function findRewindBase(pTexts, wSegs) {
  const need = Math.min(3, wSegs.length);         // require a few consecutive sentences to agree (avoid matching stray "yeah"/"OK")
  const start = Math.max(0, pTexts.length - 500); // bounded look-back
  let best = -1, bestLen = 0;
  for (let base = pTexts.length - 1; base >= start; base--) {
    const len = segRunAt(pTexts, wSegs, base);
    if (len >= need && len >= bestLen) { bestLen = len; best = base; }   // >= : prefer the MOST RECENT strong match
  }
  return best;   // -1 = genuinely new content
}
// Windows Live Captions status/placeholder lines (shown before/without speech) -- never real captions.
const LC_NOISE = /^(ready to show live captions|live captions? (are on|will appear|is (on|starting))|turn on live captions|caption settings|downloading|preparing)/i;
// Live Captions (speaker) -> speakerParas, with the rolling-window dedup + rewind detection.
function ingestWindow(cur) {
  const segs = cur.split('\n').map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).filter(s => !LC_NOISE.test(s));
  if (!segs.length) return;
  const old = speakerParas, oldLen = old.length;
  const pTexts = old.map(p => p.text);
  const k = segOverlap(pTexts, segs);             // fast path: window head overlaps the paragraph tail by k
  let base;
  if (k > 0) base = oldLen - k;
  else if (oldLen) { const rb = findRewindBase(pTexts, segs); base = (rb >= 0) ? rb : oldLen; }
  else base = 0;
  const merged = old.slice(0, base);
  for (let i = 0; i < segs.length; i++) {
    const idx = base + i, has = (idx >= 0 && idx < oldLen);
    merged.push({ t: has ? old[idx].t : fmt(elapsed()), ts: has ? old[idx].ts : elapsed(), text: segs[i], src: 'speaker' });
  }
  // an INTERIOR rewind (window ends before the retained tail) must NOT truncate newer lines
  for (let idx = base + segs.length; idx < oldLen; idx++) merged.push(old[idx]);
  speakerParas = merged;
  if (viewMode === 'speaker') { paragraphs = speakerParas; dirtyFrom = Math.min(dirtyFrom, Math.max(0, base)); }
}
// Microphone (you) -> micParas, one paragraph per utterance (partials grow it; a final closes it).
// The recognizer (Vosk AND Chrome) re-recognizes overlapping/echoed audio, emitting the SAME phrase as
// several near-identical finals. We collapse those: a long VERBATIM word-run shared with a recent line
// means "same phrase again" -> fold into that line (keep the fullest wording) instead of duplicating.
function micWords(s) { return (s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean); }
function micCommonRun(a, b) {   // longest run of consecutive identical words shared by a and b
  let best = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { row[j] = prev[j - 1] + 1; if (row[j] > best) best = row[j]; }
    prev = row;
  }
  return best;
}
function touchMicView(fromIdx) {
  if (viewMode !== 'mic') return;
  paragraphs = micParas;
  const i = (fromIdx == null) ? micParas.length - 1 : fromIdx;
  dirtyFrom = Math.min(dirtyFrom, Math.max(0, i));
}
function ingestMic(text, status) {
  text = (text || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const last = micParas[micParas.length - 1];
  // 1) partials of the still-open utterance just grow the last line
  if (micOpen && last && last.src === 'mic') { last.text = (text.length >= last.text.length) ? text : last.text; micOpen = (status !== 'final'); touchMicView(); return; }
  // 2) exact repeat / prefix continuation of the last line
  if (last && last.src === 'mic' && last.text && (text === last.text || text.startsWith(last.text) || last.text.startsWith(text))) {
    last.text = (text.length >= last.text.length) ? text : last.text; micOpen = (status !== 'final'); touchMicView(); return;
  }
  // 3) echo / re-recognition: a strong verbatim overlap with one of the last few lines -> fold in, no dup
  const b = micWords(text);
  if (b.length >= 4) {
    for (let k = micParas.length - 1; k >= 0 && k >= micParas.length - 3; k--) {
      const p = micParas[k]; if (p.src !== 'mic' || !p.text) continue;
      const a = micWords(p.text);
      const run = micCommonRun(a, b);
      if (run >= 5 || (run >= 3 && run >= 0.6 * Math.min(a.length, b.length))) {   // same phrase said/heard again
        if (b.length > a.length) p.text = text;   // upgrade to the fuller wording, in place
        micOpen = (status !== 'final'); touchMicView(k); return;
      }
    }
  }
  // 4) genuinely new content
  micParas.push({ t: fmt(elapsed()), ts: elapsed(), text: text, src: 'mic' });
  micOpen = (status !== 'final');
  if (micParas.length > MAX_PARAS) micParas.splice(0, micParas.length - MAX_PARAS);
  touchMicView();
}
function mergeBoth() { return speakerParas.concat(micParas).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)); }
// point `paragraphs` at the active view + render (a mode switch or 'both' update does a full rebuild)
function renderActive(rebuild) {
  if (viewMode === 'both') { paragraphs = mergeBoth(); captionEl.innerHTML = ''; dirtyFrom = Infinity; }
  else { paragraphs = (viewMode === 'mic') ? micParas : speakerParas; if (rebuild) { captionEl.innerHTML = ''; dirtyFrom = Infinity; } }
  if (!paragraphs.length) { captionEl.innerHTML = ''; setPlaceholder(review ? 'No transcript for this source.' : (viewMode === 'mic' ? 'Listening to your mic…' : 'Listening…')); return; }
  renderCaption();
}
function fullText() { return paragraphs.map(p => p.text).filter(Boolean).join('\n'); }
function fullTextOf(arr) { return (arr || []).map(p => p.text).filter(Boolean).join('\n'); }
function resetTranscript() { paragraphs = []; speakerParas = []; micParas = []; micOpen = false; captionEl.innerHTML = ''; }
function ptLabel(p) { return (viewMode === 'both' ? ((p.src === 'mic' ? 'You' : 'Speaker') + ' · ') : '') + (p.t || ''); }

// ================= rendering =================
function captionHasSelection(sel) { const n = sel && sel.anchorNode; return !!(n && (n === captionEl || captionEl.contains(n))); }
// Text of the current selection with the .pt TIMESTAMPS excluded. A programmatic range
// spanning paragraphs would otherwise include them (user-select:none only blocks MOUSE
// selection, not range.toString()), so gather ONLY the .ptext portions.
function selectionCaptionText() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !captionHasSelection(sel)) return '';
  const range = sel.getRangeAt(0);
  const parts = [];
  captionEl.querySelectorAll('.ptext').forEach((pt) => {
    const node = pt.firstChild;
    if (!node || node.nodeType !== 3 || !range.intersectsNode(node)) return;
    let s = 0, e = node.textContent.length;
    if (node === range.startContainer) s = range.startOffset;
    if (node === range.endContainer) e = range.endOffset;
    const t = node.textContent.slice(s, e);
    if (t.trim()) parts.push(t.trim());
  });
  return parts.join('\n');
}
window.__captionSelText = selectionCaptionText;   // read by the main process for send/copy (no timestamps)
function nearBottom() { return (captionEl.scrollHeight - captionEl.clientHeight - captionEl.scrollTop) < 24; }
function scrollBottom() {
  const target = captionEl.scrollHeight - captionEl.clientHeight;
  if (Math.abs(captionEl.scrollTop - target) < 2) return;   // already at bottom: no scroll event fires, so don't arm the guard
  programmaticScroll = true; captionEl.scrollTop = captionEl.scrollHeight;
}
function setPlaceholder(msg) { if (paragraphs.length) return; captionEl.classList.add('ph'); captionEl.textContent = msg; }

// replace one paragraph's text, preserving/growing a selection that ends in it
function updatePtext(el, text) {
  const cur = el.firstChild;
  if (cur && cur.textContent === text) return;
  const sel = window.getSelection();
  let endInThis = false, grow = false, sc = null, so = 0, eo = 0;
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    endInThis = cur && r.endContainer === cur;
    if (endInThis) { sc = r.startContainer; so = r.startOffset; eo = r.endOffset; grow = (eo >= cur.textContent.length - 1) && !followStopped; }
  }
  el.textContent = text;
  if (endInThis) {
    const nn = el.firstChild;
    try {
      const rr = document.createRange();
      if (sc && sc !== cur && document.contains(sc)) rr.setStart(sc, Math.min(so, (sc.textContent || '').length));
      else rr.setStart(nn, Math.min(so, nn.textContent.length));   // start was in the replaced node -> keep its offset
      rr.setEnd(nn, grow ? nn.textContent.length : Math.min(eo, nn.textContent.length));
      sel.removeAllRanges(); sel.addRange(rr);
    } catch (e) {}
  }
}
function ptextOf(div) { const p = div && div.querySelector('.ptext'); return p ? p.firstChild : null; }
function renderCaption() {
  if (isDragging) { pendingRender = true; return; }   // don't disturb an in-progress drag-select
  pendingRender = false;
  if (!paragraphs.length) return;
  if (captionEl.classList.contains('ph')) { captionEl.classList.remove('ph'); captionEl.textContent = ''; }

  // cap memory over long sessions: drop oldest paragraphs + their DOM nodes (kept index-aligned)
  if (paragraphs.length > MAX_PARAS) {
    const drop = paragraphs.length - MAX_PARAS;
    paragraphs.splice(0, drop);
    const oldDivs = captionEl.querySelectorAll('.para');
    for (let d = 0; d < drop && d < oldDivs.length; d++) oldDivs[d].remove();
    if (dirtyFrom !== Infinity) dirtyFrom = Math.max(0, dirtyFrom - drop);
    sentMarks = sentMarks.map((m) => ({ paraIdx: m.paraIdx - drop, offset: m.offset, act: m.act })).filter((m) => m.paraIdx >= 0);
  }

  // Detect a selection reaching the transcript end ("follow") so it keeps extending
  // across new lines. Only follow when the start anchor resolves to a real ptext node.
  const sel = window.getSelection();
  const hasSel = sel && sel.rangeCount && !sel.isCollapsed && captionHasSelection(sel);
  let following = false, startParaIdx = -1, startO = 0;
  if (hasSel) {
    const r = sel.getRangeAt(0);
    const d0 = captionEl.querySelectorAll('.para');
    const lastNode0 = d0.length ? ptextOf(d0[d0.length - 1]) : null;
    if (lastNode0 && r.endContainer === lastNode0 && r.endOffset >= lastNode0.textContent.length - 1) {
      for (let i = 0; i < d0.length; i++) { if (ptextOf(d0[i]) === r.startContainer) { startParaIdx = i; startO = r.startOffset; break; } }
      if (startParaIdx !== -1) following = true;
    }
  }

  if (followStopped) following = false;   // "stop snipping" -> don't grow the selection
  let divs = captionEl.querySelectorAll('.para');
  for (let i = divs.length; i < paragraphs.length; i++) {
    const div = document.createElement('div'); div.className = 'para src-' + (paragraphs[i].src || 'speaker');
    const pt = document.createElement('div'); pt.className = 'pt'; pt.textContent = ptLabel(paragraphs[i]);
    const tx = document.createElement('div'); tx.className = 'ptext'; tx.textContent = paragraphs[i].text;
    div.appendChild(pt); div.appendChild(tx); captionEl.appendChild(div);
  }
  divs = captionEl.querySelectorAll('.para');
  // update every paragraph that actually changed since last render (cheap no-op when unchanged)
  const from = Math.max(0, Math.min(dirtyFrom, paragraphs.length - 1));
  for (let i = from; i < paragraphs.length; i++) {
    const div = divs[i]; if (!div) continue;
    const pt = div.querySelector('.pt'); const lbl = ptLabel(paragraphs[i]); if (pt.textContent !== lbl) pt.textContent = lbl;
    const tx = div.querySelector('.ptext');
    if (following) { if ((tx.firstChild ? tx.firstChild.textContent : '') !== paragraphs[i].text) tx.textContent = paragraphs[i].text; }
    else updatePtext(tx, paragraphs[i].text);
  }
  dirtyFrom = Infinity;
  // re-extend the following selection from its (index-resolved) start to the new end
  if (following) {
    const startNode = divs[Math.min(startParaIdx, divs.length - 1)] && ptextOf(divs[Math.min(startParaIdx, divs.length - 1)]);
    const endNode = ptextOf(divs[divs.length - 1]);
    if (startNode && endNode) {
      try { const rr = document.createRange(); rr.setStart(startNode, Math.min(startO, startNode.textContent.length)); rr.setEnd(endNode, endNode.textContent.length); sel.removeAllRanges(); sel.addRange(rr); } catch (e) {}
    }
  }
  // resume "select till end" after a send: once new text arrives past the saved anchor,
  // start a fresh growing selection from there (captures the NEXT statement)
  if (resumeAnchor) {
    const cur = window.getSelection();
    if (cur && cur.rangeCount && !cur.isCollapsed && captionHasSelection(cur)) { resumeAnchor = null; }
    else {
      const sNode = ptextOf(divs[Math.min(resumeAnchor.paraIdx, divs.length - 1)]);
      const eNode = ptextOf(divs[divs.length - 1]);
      if (sNode && eNode) {
        const sOff = Math.min(resumeAnchor.offset, sNode.textContent.length);
        if ((sNode !== eNode) || (eNode.textContent.length > sOff + 1)) {
          try { const rr = document.createRange(); rr.setStart(sNode, sOff); rr.setEnd(eNode, eNode.textContent.length); cur.removeAllRanges(); cur.addRange(rr); } catch (e) {}
          resumeAnchor = null;
        }
      }
    }
  }
  if (viewMode === 'speaker') renderSentMarks();   // send marks are anchored to the speaker transcript
  else captionEl.querySelectorAll('.sent-mark, .sent-hr').forEach((e) => e.remove());
  if (autoscroll) scrollBottom();
  scheduleMinimap();
}
// the text node under a screen point, within a paragraph
function ptextNodeAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const pt = el && el.closest ? el.closest('.ptext') : null;
  return (pt && pt.firstChild && pt.firstChild.nodeType === 3) ? pt.firstChild : null;
}

// autoscroll auto-toggles like Caption.Ed: scroll up -> off, back to bottom -> on
function setAutoscroll(on) {
  autoscroll = on;
  $('pill').textContent = on ? 'AutoScroll On' : 'AutoScroll Off';
  $('pill').classList.toggle('off', !on);
}
captionEl.addEventListener('scroll', () => {
  positionMinimap();
  if (programmaticScroll) { programmaticScroll = false; return; }
  const nb = nearBottom();
  if (nb !== autoscroll) setAutoscroll(nb);
});
$('pill').addEventListener('click', () => { setAutoscroll(!autoscroll); if (autoscroll) scrollBottom(); });

// ================= minimap: a VSCode-style overview of the whole transcript =================
// A width-scaled clone of the caption; the teal box is the current viewport. Click/drag to navigate.
let miniTimer = 0;
function scheduleMinimap() { if (miniTimer) return; miniTimer = setTimeout(() => { miniTimer = 0; buildMinimap(); }, 260); }
function buildMinimap() {
  const mc = $('miniContent'); if (!mc) return;
  mc.style.width = captionEl.clientWidth + 'px';
  mc.innerHTML = captionEl.innerHTML;   // same paragraphs, same layout, just shrunk
  positionMinimap();
}
function positionMinimap() {
  const mc = $('miniContent'), mv = $('miniView'), mm = $('minimap');
  if (!mc || !mv || !mm) return;
  const cw = captionEl.clientWidth, ch = captionEl.clientHeight, sh = captionEl.scrollHeight, st = captionEl.scrollTop;
  const mmW = mm.clientWidth, mmH = mm.clientHeight;
  if (!cw || !mmW) { mv.style.display = 'none'; return; }
  const s = mmW / cw;                       // scale by width, like a code minimap
  const scaledH = sh * s;
  let offset = 0;                           // long transcript taller than the strip -> slide it to follow the viewport
  if (scaledH > mmH) offset = -(scaledH - mmH) * (st / Math.max(1, sh - ch));
  mc.style.transform = 'translateY(' + offset + 'px) scale(' + s + ')';
  mv.style.display = (sh > ch + 4) ? 'block' : 'none';   // no viewport box when nothing scrolls
  mv.style.top = (st * s + offset) + 'px';
  mv.style.height = Math.max(14, ch * s) + 'px';
  updateMiniSel(s, offset);
}
// highlight the current selection's vertical span in the minimap
function updateMiniSel(s, offset) {
  const ms = $('miniSel'); if (!ms) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !captionHasSelection(sel)) { ms.style.display = 'none'; return; }
  const rects = sel.getRangeAt(0).getClientRects();
  if (!rects.length) { ms.style.display = 'none'; return; }
  const capTop = captionEl.getBoundingClientRect().top, st = captionEl.scrollTop;
  let top = Infinity, bot = -Infinity;
  for (let i = 0; i < rects.length; i++) { top = Math.min(top, rects[i].top); bot = Math.max(bot, rects[i].bottom); }
  const cTop = (top - capTop) + st, cBot = (bot - capTop) + st;   // -> caption content coordinates
  ms.style.display = 'block';
  ms.style.top = (cTop * s + offset) + 'px';
  ms.style.height = Math.max(2, (cBot - cTop) * s) + 'px';
}
(function wireMinimap() {
  const mm = $('minimap'); if (!mm) return;
  const jump = (e) => {
    // convert the click to a CONTENT coordinate through the minimap's scale + follow-offset, so it lands
    // where you clicked (a plain clickY/height mapping is wrong when the miniature is scaled/offset).
    const cw = captionEl.clientWidth, ch = captionEl.clientHeight, sh = captionEl.scrollHeight, st = captionEl.scrollTop;
    const mmH = mm.clientHeight || 1, s = (mm.clientWidth || 1) / (cw || 1), scaledH = sh * s;
    let offset = 0;
    if (scaledH > mmH) offset = -(scaledH - mmH) * (st / Math.max(1, sh - ch));
    const cy = e.clientY - mm.getBoundingClientRect().top;
    const contentY = (cy - offset) / s;   // caption content coordinate under the cursor
    captionEl.scrollTop = Math.max(0, Math.min(sh - ch, contentY - ch / 2));   // center the clicked point
  };
  mm.addEventListener('mousedown', (e) => {
    e.preventDefault(); jump(e);
    const mv = (ev) => jump(ev);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
})();
window.addEventListener('resize', scheduleMinimap);
// keep the minimap selection band live, but DEBOUNCE: triple-click fires several transient
// full-range selections before it settles on the paragraph -> without this the band flashes full-height.
let selTimer = 0;
document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(() => positionMinimap(), 60); });

// ================= smart sentence selection =================
function getSentences(text) {
  const res = []; const re = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g; let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    let s = m.index, e = m.index + m[0].length;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) res.push({ start: s, end: e });
  }
  return res;
}
function sentenceAt(sentences, off) {
  for (const s of sentences) if (off >= s.start && off <= s.end) return s;
  let best = null, bd = Infinity;
  for (const s of sentences) { const d = Math.min(Math.abs(off - s.start), Math.abs(off - s.end)); if (d < bd) { bd = d; best = s; } }
  return best;
}
function offsetFromPoint(x, y, node) {
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r && r.startContainer === node) return r.startOffset; }
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p && p.offsetNode === node) return p.offset; }
  return null;
}
function selectRange(node, s, e) {
  const len = node.textContent.length;
  const r = document.createRange();
  r.setStart(node, Math.max(0, Math.min(s, len)));
  r.setEnd(node, Math.max(0, Math.min(e, len)));
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function selectLatestSentence() {
  const divs = captionEl.querySelectorAll('.para');
  for (let i = divs.length - 1; i >= 0; i--) {
    const node = ptextOf(divs[i]);
    if (!node || !node.textContent || !node.textContent.trim()) continue;
    const sentences = getSentences(node.textContent);
    const latest = sentences.length ? sentences[sentences.length - 1] : null;
    if (!latest) continue;
    selectRange(node, latest.start, latest.end);
    followStopped = true;   // select one current sentence; do not silently grow into later captions
    resumeAnchor = null;
    const tb = $('toEndBtn'); if (tb) tb.classList.remove('snipping');
    try { divs[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    scheduleMinimap();
    return selectionCaptionText();
  }
  return '';
}
// Captions keep flowing during selection. We freeze DOM updates only during the
// active drag (so the drag isn't interrupted); once selected, a selection that
// reaches the end grows with new text, a middle selection stays put.
let clickX = 0, clickY = 0;
captionEl.addEventListener('mousedown', (e) => { isDragging = true; clickX = e.clientX; clickY = e.clientY; followStopped = false; const tb = $('toEndBtn'); if (tb) tb.classList.remove('snipping'); });
window.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  // A plain, non-dragging click clears the selection (incl. a re-applied follow-
  // selection), matching Caption.Ed. Guards: detail===1 skips the 2nd/3rd press of a
  // dbl/triple click (their handlers fire AFTER this and re-apply their own selection);
  // the <4px threshold skips a real drag-select; and a held modifier means the user is
  // EXTENDING or multi-selecting -- shift+click to the end MUST extend, not clear -- so
  // we skip. Clear BEFORE renderCaption() so the follow logic (which only re-applies a
  // NON-collapsed selection) has nothing left to restore.
  if (e.detail === 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      Math.abs(e.clientX - clickX) < 4 && Math.abs(e.clientY - clickY) < 4) {
    const s = window.getSelection(); if (s) s.removeAllRanges();
  }
  renderCaption();
});
// if the mouse is released outside the window (no mouseup delivered) don't freeze forever
window.addEventListener('blur', () => { if (isDragging) { isDragging = false; renderCaption(); } });
captionEl.addEventListener('dblclick', (e) => {   // double-click selects the whole sentence
  const node = ptextNodeAt(e.clientX, e.clientY); if (!node) return;
  const sentences = getSentences(node.textContent); if (!sentences.length) return;
  const off = offsetFromPoint(e.clientX, e.clientY, node); if (off == null) return;
  const s = sentenceAt(sentences, off); if (!s) return;
  selectRange(node, s.start, s.end); e.preventDefault();
});
captionEl.addEventListener('click', (e) => {
  if (e.detail >= 3) {   // triple-click selects the whole paragraph under the cursor
    const node = ptextNodeAt(e.clientX, e.clientY); if (!node) return;
    selectRange(node, 0, node.textContent.length); e.preventDefault();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const s = window.getSelection(); if (s) s.removeAllRanges(); }
});

// ================= screens =================
function show(name) {
  closePops();
  screen = name;
  for (const s of ['home', 'new', 'live', 'prompts']) $(s).classList.toggle('hidden', s !== name);
  document.querySelectorAll('.side[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  // Caption.Ed sizing rule: compact 640x440 caption window, 1024x700 setup window
  window.cap.resize(name === 'live' ? 640 : 1024, name === 'live' ? 440 : 700);
  if (name === 'home') renderRecent();
  if (name === 'prompts') loadPrompts();
  if (typeof startMicMeter === 'function') { if (name === 'live') startMicMeter(); else stopMicMeter(); }   // pulse only during a session
}
function showOverlay(which) {
  $('overlay').classList.remove('hidden');
  $('mPerm').classList.toggle('hidden', which !== 'perm');
  $('mDone').classList.toggle('hidden', which !== 'done');
  $('mExit').classList.toggle('hidden', which !== 'exit');
  $('mSavedDelete').classList.toggle('hidden', which !== 'savedDelete');
  $('mHelp').classList.toggle('hidden', which !== 'help');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ================= timer =================
function fmt(sec) { const m = Math.floor(sec / 60), s = sec % 60; return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); }
function tickTimer() { const sec = Math.floor((Date.now() - sessionStart) / 1000); $('timer').textContent = fmt(sec); if (!captionEl.classList.contains('ph')) $('ts').textContent = fmt(sec); }
function startTimer() { sessionStart = Date.now(); tickTimer(); clearInterval(timerInt); timerInt = setInterval(tickTimer, 500); }
function stopTimer() { clearInterval(timerInt); timerInt = null; }
function elapsed() { return Math.floor((Date.now() - sessionStart) / 1000); }

// ================= sessions =================
function loadSessions() { try { return JSON.parse(localStorage.getItem('ce_sessions') || '[]'); } catch (e) { return []; } }
function saveSessions(a) { localStorage.setItem('ce_sessions', JSON.stringify(a)); }
function defaultSessionName() {
  const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const h = now.getHours(), ap = h < 12 ? 'AM' : 'PM', h12 = ((h + 11) % 12) + 1;
  return 'Session - ' + pad(now.getMonth() + 1) + '/' + pad(now.getDate()) + ' ' + h12 + ':' + pad(now.getMinutes()) + ' ' + ap;   // e.g. "Session - 08/02 3:57 AM"
}
let pendingSessionDelete = null;
function renderRecent() {
  const list = $('recentList'); const sessions = loadSessions().sort((a, b) => b.ts - a.ts); list.innerHTML = '';
  if (!sessions.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No sessions yet — Start a new session above.'; list.appendChild(e); return; }
  for (const s of sessions) {
    const row = document.createElement('div'); row.className = 'session-row';
    row.innerHTML = `<div class="session-main"><div class="r-name"></div><div class="r-dur"></div></div><button class="session-delete" type="button" title="Delete this saved session" aria-label="Delete this saved session"><svg class="ic"><use href="#i-trash"/></svg></button>`;
    row.querySelector('.r-name').textContent = s.name; row.querySelector('.r-dur').textContent = s.duration;
    row.querySelector('.session-main').addEventListener('click', () => openReview(s));
    row.querySelector('.session-delete').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      pendingSessionDelete = s;
      $('savedDeleteName').textContent = s.name;
      showOverlay('savedDelete');
    });
    list.appendChild(row);
  }
}
$('savedDeleteCancel').addEventListener('click', () => { pendingSessionDelete = null; hideOverlay(); });
$('savedDeleteX').addEventListener('click', () => { pendingSessionDelete = null; hideOverlay(); });
$('savedDeleteOk').addEventListener('click', async () => {
  const s = pendingSessionDelete; if (!s) { hideOverlay(); return; }
  const b = $('savedDeleteOk'); b.disabled = true; b.textContent = 'Deleting…';
  if (s.audio && window.cap.deleteAudio) { try { await window.cap.deleteAudio(String(s.id)); } catch (err) {} }
  saveSessions(loadSessions().filter((item) => String(item.id) !== String(s.id)));
  pendingSessionDelete = null; b.disabled = false; b.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg> Delete session';
  hideOverlay(); renderRecent();
});
function reviewParas(text, src) {
  return (text || '').split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ t: i === 0 ? '00:00' : '', ts: i, text: t, src: src }));
}
function openReview(s) {
  review = true; stopTimer();
  $('timer').textContent = s.duration; $('ts').textContent = s.duration;
  $('dot').classList.add('paused'); $('endBtn').innerHTML = '<svg class="ic bk"><use href="#i-back"/></svg> BACK';
  speakerParas = entriesToParas(s.speakerEntries, s.speaker != null ? s.speaker : s.text, 'speaker');
  micParas = entriesToParas(s.micEntries, s.mic, 'mic');
  viewMode = 'speaker'; applySrcToggle();
  captionEl.classList.remove('ph'); captionEl.innerHTML = ''; dirtyFrom = Infinity;
  paragraphs = speakerParas.length ? speakerParas : [{ t: '00:00', text: '', src: 'speaker' }];
  renderCaption();
  show('live'); captionEl.scrollTop = 0;
  setupReplay(s);   // audio player + timestamp sync (stays hidden if this session has no recording)
}
function startLiveSession() {
  setBusy(false);
  if (window.cap.resetGptSession) window.cap.resetGptSession();
  review = false; captureStopped = false; frozenElapsed = 0; dirtyFrom = Infinity; resetTranscript();
  answerRequestId = ''; answerSeq = -1; answerText = ''; answerPhase = 'ready'; answerRecovering = false;
  $('gptAnswerText').textContent = 'Select an interview question, then press Send or another answer button.';
  $('gptAnswerText').classList.add('empty');
  setAnswerStatus('Ready', 'ready');
  teardownReplay();
  viewMode = 'speaker'; applySrcToggle();
  $('dot').classList.remove('paused'); $('endBtn').innerHTML = '<svg class="ic sq"><use href="#i-stop"/></svg>';
  setAutoscroll(true); setPlaceholder('Listening…');
  show('live'); startTimer(); applyOpacity();
  startRecording();   // record speaker(loopback)+mic for replay; no-op if capture is unavailable
}

// ================= settings popover: opacities =================
let lcOpacity = 0;     // original Live Captions opacity (percent) - hidden by default
let appOpacity = 100;  // this app window's opacity (percent)
function applyOpacity() {
  window.cap.setLcOpacity(Math.round(lcOpacity / 100 * 255));
  $('opacityVal').textContent = lcOpacity + '%'; $('opacitySlider').value = lcOpacity;
  localStorage.setItem('ce_lcOpacity', lcOpacity);
}
function applyAppOpacity() {
  window.cap.setAppOpacity(appOpacity / 100);
  $('appOpacityVal').textContent = appOpacity + '%'; $('appOpacitySlider').value = appOpacity;
  localStorage.setItem('ce_appOpacity', appOpacity);
}
// These controls are global, so detach their one shared copy from the Live screen.
// It can then be opened from Home, New Session, Prompts, or Live without duplicated state.
['popBackdrop', 'opacityPop', 'privacyPop', 'settingsPop'].forEach((id) => { const el = $(id); if (el) document.body.appendChild(el); });
let openPopAnchor = null;
function anchorEl(anchor) { return typeof anchor === 'string' ? $(anchor) : anchor; }
function positionPopAt(anchor, popId) {
  const btn = anchorEl(anchor); if (!btn) return;
  const r = btn.getBoundingClientRect(); const pop = $(popId);
  const w = pop.offsetWidth || 236, h = pop.offsetHeight || 200;
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);   // keep the (tall) dialog fully on-screen
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(r.left - 90, window.innerWidth - w - 8)) + 'px';
}
function closePops() {
  ['opacityPop', 'privacyPop', 'settingsPop', 'srcPop'].forEach((id) => { if ($(id)) $(id).classList.add('hidden'); });
  if (typeof cancelHotkeyCapture === 'function') cancelHotkeyCapture();
  $('popBackdrop').classList.add('hidden'); openPopAnchor = null;
}
function togglePop(anchor, popId) {
  const willOpen = $(popId).classList.contains('hidden');
  closePops();
  if (willOpen) {
    openPopAnchor = anchorEl(anchor);
    if ($('lcOpacityRow')) $('lcOpacityRow').classList.toggle('hidden', screen !== 'live');
    $(popId).classList.remove('hidden'); $('popBackdrop').classList.remove('hidden');
    // settings is a wide dialog -- if the window is too narrow to show it, widen the window first
    if ((popId === 'settingsPop' || popId === 'privacyPop') && window.innerWidth < 344) { window.cap.resize(344, window.innerHeight); setTimeout(() => positionPopAt(openPopAnchor, popId), 70); }
    positionPopAt(openPopAnchor, popId);
  }
}
document.querySelectorAll('[data-pop]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  if (b.dataset.pop === 'opacityPop' && screen === 'live') window.cap.ensureLiveCaptions();
  togglePop(b, b.dataset.pop);
}));
// A transparent no-drag backdrop covers the window while a popover is open, so a click
// anywhere -- INCLUDING the draggable header, whose drag region swallows clicks -- dismisses it.
$('popBackdrop').addEventListener('click', closePops);
$('opacitySlider').addEventListener('input', () => { lcOpacity = +$('opacitySlider').value; applyOpacity(); });
$('appOpacitySlider').addEventListener('input', () => { appOpacity = +$('appOpacitySlider').value; applyAppOpacity(); });
document.addEventListener('click', (e) => {
  if (e.target.closest && (e.target.closest('[data-pop]') || e.target.closest('#srcBtn'))) return;
  const sp = $('srcPop');
  const inPop = $('opacityPop').contains(e.target) || $('privacyPop').contains(e.target) || $('settingsPop').contains(e.target) || (sp && sp.contains(e.target));
  const anyOpen = !$('opacityPop').classList.contains('hidden') || !$('privacyPop').classList.contains('hidden') || !$('settingsPop').classList.contains('hidden') || (sp && !sp.classList.contains('hidden'));
  if (!inPop && anyOpen) closePops();
});
window.addEventListener('resize', () => {
  for (const id of ['opacityPop', 'privacyPop', 'settingsPop', 'srcPop']) {
    if ($(id) && !$(id).classList.contains('hidden')) positionPopAt(openPopAnchor, id);
  }
});

// ===== ChatGPT actions, hotkeys, privacy overlay, connection status =====
let hotCfg = {
  send:    { key: '' },              // hotkeys start UNBOUND -- the user assigns them (click the box, press a key)
  aa:      { key: '', label: 'aa' },
  bb:      { key: '', text: 'zz' },
  latest:  { key: '' },
  compact: { key: '', url: '' },
  micmute: { key: '' }
};
const PRIVACY_UI_DEFAULTS = {
  enabled: false, captureProtected: true, clickHotkey: 'CommandOrControl+Shift+X'
};
let privacyCfg = Object.assign({}, PRIVACY_UI_DEFAULTS);
let privacyRuntime = { clickThrough: false };
let privacyHotkeys = { click: false };
let privacyForcedOff = false;
let privacyClickTimer = null;
function displayAccel(key) { return (key || '').replace('CommandOrControl', 'Ctrl'); }
function renderPrivacy(state) {
  if (state) {
    privacyCfg = Object.assign({}, PRIVACY_UI_DEFAULTS, state.config || {});
    privacyRuntime = Object.assign({ clickThrough:false }, state.runtime || {});
    privacyHotkeys = Object.assign({ click:false }, state.hotkeys || {});
    privacyForcedOff = !!state.forcedOff;
  }
  $('privacyEnabled').checked = !!privacyCfg.enabled;
  $('privacyEnabled').disabled = privacyForcedOff;
  $('privacyCapture').checked = !!privacyCfg.captureProtected;
  $('privacyClick').checked = !!privacyRuntime.clickThrough;
  $('privacyOptions').classList.toggle('is-disabled', !privacyCfg.enabled || privacyForcedOff);
  $('hkPrivacyClick').textContent = displayAccel(privacyCfg.clickHotkey);
  markHk('hkPrivacyClick', !privacyCfg.enabled || privacyHotkeys.click);
  $('privacyClick').disabled = !privacyCfg.enabled || !privacyHotkeys.click;
  document.querySelectorAll('.privacy-trigger').forEach((b) => {
    const failed = !!privacyCfg.enabled && !privacyHotkeys.click;
    b.classList.toggle('privacy-on', !!privacyCfg.enabled && !privacyRuntime.clickThrough && !failed);
    b.classList.toggle('privacy-click', !!privacyRuntime.clickThrough && !failed);
    b.classList.toggle('privacy-error', failed);
    b.title = privacyForcedOff ? 'Privacy overlay · safe start disabled it' : failed ? 'Privacy overlay · recovery shortcut unavailable' : privacyRuntime.clickThrough ? 'Privacy overlay · click-through ON · ' + displayAccel(privacyCfg.clickHotkey) + ' to exit' : privacyCfg.enabled ? 'Privacy overlay active' : 'Privacy overlay off';
  });
  const status = $('privacyStatus');
  status.className = 'privacy-status';
  if (privacyForcedOff) status.textContent = 'Safe start is active. Privacy controls are disabled for this run.';
  else if (!privacyCfg.enabled) status.textContent = 'Privacy overlay is off.';
  else if (!privacyHotkeys.click) {
    status.classList.add('warn');
    status.textContent = 'A recovery shortcut could not be registered. The related risky action is disabled.';
  } else if (privacyRuntime.clickThrough) {
    status.classList.add('warn');
    status.textContent = 'Click-through is ON. Press ' + displayAccel(privacyCfg.clickHotkey) + ' to regain mouse control.';
  } else {
    const active = [];
    if (privacyCfg.captureProtected) active.push('capture protected');
    active.push('taskbar hidden');
    status.classList.add('ok');
    status.textContent = 'Active' + (active.length ? ': ' + active.join(' · ') : '') + '. Click-through recovery: ' + displayAccel(privacyCfg.clickHotkey) + '.';
  }
}
async function pushPrivacy(patch) {
  try {
    const state = await window.cap.setPrivacy(Object.assign({}, privacyCfg, patch || {}));
    renderPrivacy(state);
    return state;
  } catch (e) {
    const status = $('privacyStatus'); status.className = 'privacy-status warn'; status.textContent = 'Could not apply privacy settings.';
    return null;
  }
}
try { const s = JSON.parse(localStorage.getItem('ce_hotcfg') || 'null'); if (s) hotCfg = Object.assign(hotCfg, s); } catch (e) {}
if (hotCfg.bb && hotCfg.bb.text === 'bb') hotCfg.bb.text = 'zz';   // rename the old default bb -> zz
// one-time migration: machines still carrying the old pre-set F1/F2/F3/F6 defaults -> unbind them
if ((hotCfg.send || {}).key === 'F1' && (hotCfg.aa || {}).key === 'F2' && (hotCfg.bb || {}).key === 'F3' && (hotCfg.compact || {}).key === 'F6') {
  hotCfg.send.key = ''; hotCfg.aa.key = ''; hotCfg.bb.key = ''; hotCfg.compact.key = '';
}
function applyHotUI() {
  $('hkSend').textContent = hotCfg.send.key || '—';
  $('hkAa').textContent = hotCfg.aa.key || '—';
  $('hkBb').textContent = hotCfg.bb.key || '—';
  if ($('hkLatest')) $('hkLatest').textContent = (hotCfg.latest && hotCfg.latest.key) || '—';
  $('hkCompact').textContent = hotCfg.compact.key || '—';
  if ($('hkMic')) $('hkMic').textContent = (hotCfg.micmute && hotCfg.micmute.key) || '—';
  if ($('hkPrivacyClick')) $('hkPrivacyClick').textContent = displayAccel(privacyCfg.clickHotkey);
  $('kwAa').value = hotCfg.aa.label != null ? hotCfg.aa.label : 'aa';
  $('kwBb').value = hotCfg.bb.text != null ? hotCfg.bb.text : 'zz';
  $('kwCompactUrl').value = hotCfg.compact.url || '';
  const aBtn = $('aaBtn'); if (aBtn) aBtn.textContent = hotCfg.aa.label || 'aa';   // button labels mirror the keywords
  const aCode = $('aaCodeBtn'); if (aCode) aCode.textContent = hotCfg.aa.label || 'aa';   // coding-mode aa mirrors the same keyword
  const bBtn = $('bbBtn'); if (bBtn) bBtn.textContent = hotCfg.bb.text || 'zz';
  // toolbar button tooltips show the CURRENTLY-SET hotkey (or nothing if unbound), not a hard-coded F-key
  const hk = (k) => k ? '  (' + k + ')' : '';
  const setTitle = (id, base) => { const b = $(id); if (b) b.title = base; };
  setTitle('gptBtn', 'Send the selection to ChatGPT' + hk(hotCfg.send.key));
  if (aBtn) aBtn.title = 'Send your "' + (hotCfg.aa.label || 'aa') + '" keyword + the selection to ChatGPT' + hk(hotCfg.aa.key);
  if (bBtn) bBtn.title = 'Send "' + (hotCfg.bb.text || 'zz') + '" only to ChatGPT' + hk(hotCfg.bb.key);
  setTitle('latestBtn', 'Select the latest sentence without sending it' + hk(hotCfg.latest && hotCfg.latest.key));
  setTitle('compactBtn', 'Compact this chat into a new tab' + hk(hotCfg.compact.key));
  setTitle('micBtn', 'Mute the microphone system-wide (stops it reaching every app, incl. meetings)' + hk(hotCfg.micmute && hotCfg.micmute.key));
}
function markHk(id, ok) { const b = $(id); if (b) b.classList.toggle('taken', ok === false); }
function syncHot() {
  hotCfg.aa.label = ($('kwAa').value || '').trim() || 'aa';
  hotCfg.bb.text = ($('kwBb').value || '').trim() || 'bb';
  hotCfg.compact.url = ($('kwCompactUrl').value || '').trim();
  try { localStorage.setItem('ce_hotcfg', JSON.stringify(hotCfg)); } catch (e) {}
  window.cap.setHotkeys(hotCfg).then((r) => {
    if (r && r.results) { markHk('hkSend', r.results.send); markHk('hkAa', r.results.aa); markHk('hkBb', r.results.bb); markHk('hkLatest', r.results.latest); markHk('hkCompact', r.results.compact); markHk('hkMic', r.results.micmute); }
  }).catch(() => {});
}
// rebind a hotkey: click its box, then press the new key
let capturing = null;
function cancelHotkeyCapture() {
  if (!capturing) return;
  capturing.classList.remove('capturing');
  capturing = null;
  applyHotUI();
  renderPrivacy();
}
function accelFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) { /* function key as-is */ }
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else return null;
  return mods.length ? mods.join('+') + '+' + key : key;
}
document.querySelectorAll('.hk[data-act], .hk[data-pact]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  if (capturing === b) { cancelHotkeyCapture(); return; }
  cancelHotkeyCapture();
  capturing = b; b.classList.add('capturing'); b.textContent = 'press key…';
  b.title = 'Press a key to bind · Backspace/Delete to clear · Esc to cancel';
}));
document.addEventListener('keydown', (e) => {
  if (!capturing) return;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const act = capturing.dataset.act;
  const pact = capturing.dataset.pact;
  if (e.key === 'Escape') { /* cancel -> keep the current binding */ }
  else if (act && (e.key === 'Backspace' || e.key === 'Delete')) { hotCfg[act].key = ''; }
  else if (pact && (e.key === 'Backspace' || e.key === 'Delete')) {
    // Privacy recovery shortcuts cannot be blank. Delete restores the safe default.
    privacyCfg.clickHotkey = PRIVACY_UI_DEFAULTS.clickHotkey;
  } else {
    const acc = accelFromEvent(e);
    if (acc && act) hotCfg[act].key = acc;
    if (acc && pact) privacyCfg.clickHotkey = acc;
  }
  capturing.classList.remove('capturing'); capturing = null;
  applyHotUI();
  if (act) syncHot();
  if (pact) pushPrivacy();
}, true);
['kwAa', 'kwBb', 'kwCompactUrl'].forEach((id) => $(id).addEventListener('change', syncHot));
$('privacyEnabled').addEventListener('change', () => pushPrivacy({ enabled: $('privacyEnabled').checked }));
$('privacyCapture').addEventListener('change', () => pushPrivacy({ captureProtected: $('privacyCapture').checked }));
$('privacyClick').addEventListener('change', () => {
  if (!$('privacyClick').checked) { window.cap.privacyAction('click-off').then((r) => renderPrivacy(r && r.state)).catch(() => renderPrivacy()); return; }
  // A short visible warning gives the user time to read the recovery shortcut before mouse input is ignored.
  $('privacyClick').checked = false;
  const status = $('privacyStatus'); status.className = 'privacy-status warn';
  status.textContent = 'Click-through starts in 2 seconds. Press ' + displayAccel(privacyCfg.clickHotkey) + ' to turn it off.';
  clearTimeout(privacyClickTimer);
  privacyClickTimer = setTimeout(() => {
    window.cap.privacyAction('toggle-click').then((r) => renderPrivacy(r && r.state)).catch(() => renderPrivacy());
  }, 2000);
});
if (window.cap.onPrivacyState) window.cap.onPrivacyState(renderPrivacy);
function renderAnswerMode() {
  const b = $('answerModeBtn');
  b.setAttribute('aria-pressed', answerInApp ? 'true' : 'false');
  b.classList.toggle('on', answerInApp);
  b.classList.toggle('waiting', answerInApp && answerPhase === 'waiting');
  b.classList.toggle('error', answerInApp && answerPhase === 'error');
  b.title = answerInApp
    ? 'Answer in app: ON — keep the current window and return ChatGPT replies here'
    : 'Answer in app: OFF — show replies in the ChatGPT tab';
  $('gptAnswerView').classList.toggle('hidden', !answerInApp);
  $('minimap').classList.toggle('hidden', answerInApp);
  $('caption').classList.remove('hidden');
  const refresh = $('answerRefreshBtn'); if (refresh) refresh.disabled = !answerRequestId || answerRecovering;
}
function setAnswerStatus(label, phase) {
  answerPhase = phase || 'ready';
  const s = $('gptAnswerStatus');
  s.textContent = label;
  s.className = 'gpt-answer-status' + (phase && phase !== 'ready' ? ' ' + phase : '');
  renderAnswerMode();
}
function beginGptAnswer(status) {
  answerRequestId = String(status.requestId || ''); answerSeq = -1; answerText = ''; answerRecovering = false;
  const out = $('gptAnswerText'); out.textContent = 'Waiting for ChatGPT…'; out.classList.add('empty');
  setAnswerStatus('Queued…', 'waiting');
}
function failGptAnswer(message, partialText) {
  answerRecovering = false;
  const rb = $('answerRefreshBtn'); if (rb) rb.classList.remove('recovering');
  const out = $('gptAnswerText');
  if (partialText) {
    answerText = partialText;
    out.textContent = partialText + '\n\n— ' + (message || 'The response connection was interrupted.');
    out.classList.remove('empty');
  } else {
    out.textContent = message || 'Could not receive the ChatGPT answer.'; out.classList.add('empty');
  }
  setAnswerStatus('Response error', 'error');
  setBusy(false);
}
function receiveGptAnswer(r) {
  if (!r || !r.requestId || r.requestId !== answerRequestId) return;
  const seq = Number.isFinite(+r.seq) ? +r.seq : 0;
  if (seq <= answerSeq) return;
  answerSeq = seq;
  answerRecovering = false;
  const rb = $('answerRefreshBtn'); if (rb) rb.classList.remove('recovering');
  if (r.phase === 'start' || r.phase === 'submitted') { setAnswerStatus('Generating…', 'waiting'); return; }
  if (r.phase === 'recovered') { setAnswerStatus('Recovered · monitoring…', 'waiting'); return; }
  if (r.phase === 'error') { failGptAnswer(r.error || 'No ChatGPT response was detected.', r.text || answerText); return; }
  if (typeof r.text === 'string' && r.text) {
    const out = $('gptAnswerText');
    const follow = out.scrollTop + out.clientHeight >= out.scrollHeight - 32;
    // Each stream chunk carries the FULL answer so far. Assigning textContent every time destroyed and
    // rebuilt the whole text node and re-laid out the entire block -- O(n) per chunk on a growing answer,
    // ~25 times a second. When the new text is a pure extension of what is already rendered, grow the
    // existing text node instead; fall back to a full replace on regenerate/edit or the first chunk.
    const node = out.firstChild;
    const grew = answerText && r.text.length > answerText.length && r.text.startsWith(answerText);
    if (grew && node && node.nodeType === 3 && out.childNodes.length === 1 && !out.classList.contains('empty')) {
      node.appendData(r.text.slice(answerText.length));
    } else {
      out.textContent = r.text;
      out.classList.remove('empty');
    }
    answerText = r.text;
    if (follow) out.scrollTop = out.scrollHeight;
  }
  if (r.phase === 'final') { setAnswerStatus(r.error ? 'Complete · monitor timeout' : 'Complete', 'done'); setBusy(false); }
  else setAnswerStatus('Generating…', 'waiting');
}
$('answerModeBtn').addEventListener('click', () => {
  answerInApp = !answerInApp;
  try { localStorage.setItem('ca_answer_in_app', answerInApp ? '1' : '0'); } catch (e) {}
  if (window.cap.setAnswerInApp) window.cap.setAnswerInApp(answerInApp);
  renderAnswerMode();
});
$('answerCopyBtn').addEventListener('click', () => {
  if (!answerText) return;
  window.cap.copy(answerText);
  const u = $('answerCopyUse'); if (u) { u.setAttribute('href', '#i-check'); setTimeout(() => u.setAttribute('href', '#i-copy'), 550); }
});
if ($('answerRefreshBtn')) $('answerRefreshBtn').addEventListener('click', () => {
  if (!answerRequestId || answerRecovering) return;
  answerRecovering = true; answerSeq = -1;
  $('answerRefreshBtn').classList.add('recovering');
  setAnswerStatus('Recovering…', 'waiting');
  setBusy(true, busyBtn || 'gptBtn', 30000);
  if (window.cap.recoverGpt) window.cap.recoverGpt();
});
if (window.cap.onGptAnswer) window.cap.onGptAnswer(receiveGptAnswer);
if (window.cap.onGptStatus) window.cap.onGptStatus((s) => {
  if (!s) return;
  if (s.justSent) {
    const map = { send: 'gptBtn', aa: mode === 'Live Coding' ? 'aaCodeBtn' : 'aaBtn', simple: mode === 'Live Coding' ? 'ssCodeBtn' : 'simpleBtn', bb: 'bbBtn', compact: 'compactBtn', paste: 'editBtn', code1: 'planBtn', code2: 'codeBtn', code3: 'improveBtn', code4: 'edgeBtn', code5: 'complexityBtn' };
    setBusy(true, map[s.action] || 'gptBtn', s.returnToApp ? 185000 : 9000);
    if (s.returnToApp) beginGptAnswer(s);
  }
  if (s.requestId && s.requestId === answerRequestId && s.phase === 'delivered') setAnswerStatus('Sending…', 'waiting');
  if (s.requestId && s.requestId === answerRequestId && s.phase === 'submitted') setAnswerStatus('Generating…', 'waiting');
  if (s.requestId && s.requestId === answerRequestId && s.phase === 'recovering') setAnswerStatus('Recovering…', 'waiting');
  if (typeof s.connected !== 'boolean') return;
  const el = $('bridgeStatus');
  if (el) {
    el.textContent = s.connected ? 'Extension: connected ✓' : 'Extension: not connected — load it in Chrome & keep this app running';
    el.classList.toggle('ok', s.connected); el.classList.toggle('bad', !s.connected);
  }
  const g = $('gptBtn'); if (g && !busy) g.classList.toggle('nolink', !s.connected);
  if (s.connected) { lastConn = Date.now(); if (typeof s.bound === 'boolean') connBound = s.bound; }
  updateConn();
});
function updateConn() {
  const on = (Date.now() - lastConn) < 3500;
  const text = on ? (connBound ? '● linked' : '● bind a tab') : '● no bridge';
  const title = on ? (connBound ? 'ChatGPT extension connected and a tab is bound' : 'Extension connected; bind a ChatGPT tab') : 'ChatGPT extension is not connected';
  const nodes = Array.from(document.querySelectorAll('[data-global-conn]'));
  if ($('gptConn')) nodes.push($('gptConn'));
  nodes.forEach((el) => {
    el.classList.toggle('on', on && connBound);
    el.classList.toggle('warn', on && !connBound);
    el.textContent = text;
    el.title = title;
  });
}
setInterval(updateConn, 1500);
// restore persisted settings
(function initSettings() {
  // Caption assistance uses one fixed visual theme.
  appOpacity = 100;   // always start fully opaque so a persisted low value can't hide the window
  applyAppOpacity();
  lcOpacity = 0;      // always start with the original Live Captions hidden (0%)
  applyOpacity();     // write the value to the enforcement file so it sticks
  applyHotUI(); syncHot();   // reflect saved hotkeys/keywords in the UI and register them in main
  renderPrivacy();
  if (window.cap.getPrivacy) window.cap.getPrivacy().then(renderPrivacy).catch(() => renderPrivacy());
  renderAnswerMode();
  if (window.cap.setAnswerInApp) window.cap.setAnswerInApp(answerInApp);
  if (window.cap.getVersion) window.cap.getVersion().then((v) => { const e = $('homeVer'); if (e) e.textContent = 'v' + v + ' · Haru Mikage · Japan · 2026.8.15'; }).catch(() => {});
})();

// ================= nav / buttons =================
$('startNew').addEventListener('click', () => show('new'));
$('backHome').addEventListener('click', () => show('home'));
$('startSession').addEventListener('click', () => showOverlay('perm'));
document.querySelectorAll('.card').forEach((card) => card.addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((c) => c.classList.remove('selected')); card.classList.add('selected');
  mode = card.dataset.mode; try { localStorage.setItem('caMode', mode); } catch (e) {}
  applyMode();
}));
document.querySelectorAll('.card').forEach((c) => c.classList.toggle('selected', c.dataset.mode === mode));   // restore saved mode
// interview mode -> Live Coding shows the 1..5 command buttons + F1..F5 hotkeys (Standard mode untouched)
function applyMode() {
  document.body.classList.toggle('mode-coding', mode === 'Live Coding');
  if (window.cap.setMode) window.cap.setMode(mode);
}
document.querySelectorAll('.code-btn').forEach((b) => b.addEventListener('click', () => {
  if (busy) return;
  setBusy(true, b.id);
  window.cap.sendKeyword(b.dataset.cmd);
}));
applyMode();
$('permCancel').addEventListener('click', hideOverlay);
$('permOk').addEventListener('click', () => { hideOverlay(); startLiveSession(); });
$('endBtn').addEventListener('click', () => {
  if (review) { teardownReplay(); review = false; show('home'); return; }   // BACK from a saved transcript
  stopTimer(); captureStopped = true; frozenElapsed = elapsed(); pauseRecording();   // halt capture + freeze duration + pause the recording
  $('sessName').value = defaultSessionName();
  showOverlay('done');
});
$('doneX').addEventListener('click', () => {   // dismiss -> resume capture from where END froze
  hideOverlay(); captureStopped = false; resumeRecording();
  sessionStart = Date.now() - frozenElapsed * 1000;
  clearInterval(timerInt); tickTimer(); timerInt = setInterval(tickTimer, 500);
});
$('doneSave').addEventListener('click', async () => {
  const name = ($('sessName').value || '').trim() || 'Untitled session';
  const id = Date.now();
  const s = buildSessionObj(id, name, fmt(frozenElapsed));
  s.audio = await saveSessionAudio(id);   // stops + persists the recording (null if none)
  const sessions = loadSessions(); sessions.push(s); saveSessions(sessions);
  hideOverlay(); show('home');
});
$('doneDelete').addEventListener('click', () => { discardRecording(); hideOverlay(); show('home'); });
$('copyBtn').addEventListener('click', () => {
  const t = selectionCaptionText(); if (!t) return;   // selection only
  window.cap.copy(t);
  const u = $('copyBtn').querySelector('use'); if (u) { u.setAttribute('href', '#i-check'); setTimeout(() => u.setAttribute('href', '#i-copy'), 550); }
});
function flashBtn(id) { const b = $(id); if (!b) return; b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 220); }
let actionNoticeTimer = null;
function showActionNotice(message, type, timeoutMs) {
  const n = $('actionNotice'); if (!n) return;
  clearTimeout(actionNoticeTimer);
  n.textContent = message;
  n.className = 'action-notice ' + (type || 'warn');
  actionNoticeTimer = setTimeout(() => { n.className = 'action-notice hidden'; }, timeoutMs || 2300);
}
function confirmSelectionBriefly() {
  captionEl.classList.add('selection-confirming');
  setTimeout(() => captionEl.classList.remove('selection-confirming'), 650);
}
function setBusy(on, id, timeoutMs) {
  busy = on;
  if (busyBtn) { const p = $(busyBtn); if (p) p.classList.remove('busy'); }   // clear previous spinner
  busyBtn = on ? (id || null) : null;
  if (on && busyBtn) { const b = $(busyBtn); if (b) b.classList.add('busy'); }
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  if (on) busyTimer = setTimeout(() => setBusy(false), timeoutMs || 9000);   // long timeout while streaming an in-app response
}
function trigger(action, btnId) {
  if (busy) { showActionNotice('A ChatGPT request is already in progress. Please wait.', 'warn'); return; }
  const needsSelection = action === 'send' || action === 'paste' || action === 'aa' || action === 'simple';
  const selectedText = needsSelection ? selectionCaptionText() : '';
  if (needsSelection && !selectedText) {
    flashBtn('latestBtn');
    showActionNotice('Select a question first, or press Latest.', 'warn');
    return;
  }
  if (needsSelection) {
    confirmSelectionBriefly();
    const preview = selectedText.replace(/\s+/g, ' ').trim();
    showActionNotice('Sending: “' + (preview.length > 74 ? preview.slice(0, 71) + '…' : preview) + '”', 'ok', 1700);
  }
  setBusy(true, btnId);
  window.cap.sendAction(action, selectedText);
}
// Keep the transcript range alive until the click handler snapshots it. Moving focus to a
// toolbar button can otherwise collapse the DOM selection before aa/ss/Send reads it.
['gptBtn', 'aaBtn', 'aaCodeBtn', 'simpleBtn', 'ssCodeBtn', 'editBtn'].forEach((id) => {
  const b = $(id); if (b) b.addEventListener('mousedown', (e) => e.preventDefault());
});
$('gptBtn').addEventListener('click', () => trigger('send', 'gptBtn'));
$('aaBtn').addEventListener('click', () => trigger('aa', 'aaBtn'));
if ($('aaCodeBtn')) $('aaCodeBtn').addEventListener('click', () => trigger('aa', 'aaCodeBtn'));   // Live Coding row: same aa action
if ($('ssCodeBtn')) $('ssCodeBtn').addEventListener('click', () => trigger('simple', 'ssCodeBtn'));   // Live Coding row: ss (simple answer)
if ($('simpleBtn')) $('simpleBtn').addEventListener('click', () => trigger('simple', 'simpleBtn'));
$('bbBtn').addEventListener('click', () => trigger('bb', 'bbBtn'));
$('compactBtn').addEventListener('click', () => trigger('compact', 'compactBtn'));
$('editBtn').addEventListener('click', () => trigger('paste', 'editBtn'));
function runLatestSelection() {
  if (selectLatestSentence()) {
    flashBtn('latestBtn');
    showActionNotice('Latest sentence selected. Choose Send, aa, or ss.', 'ok');
  } else showActionNotice('No recent transcript sentence is available yet.', 'warn');
}
if ($('latestBtn')) $('latestBtn').addEventListener('click', runLatestSelection);
if (window.cap.onHotkeyLatest) window.cap.onHotkeyLatest(runLatestSelection);
$('toEndBtn').addEventListener('click', () => {
  const b = $('toEndBtn');
  if (b.classList.contains('snipping')) { followStopped = true; b.classList.remove('snipping'); }   // click again -> STOP growing (freeze)
  else { followStopped = false; selectToEnd(); b.classList.add('snipping'); }                          // START select-till-end
  flashBtn('toEndBtn');
});
// after a send (button or hotkey): clear + re-arm select-till-end from the last end
function captureResumeAnchor(actionId) {
  followStopped = false;   // a send re-arms a fresh growing selection
  const divs = captionEl.querySelectorAll('.para');
  const sel = window.getSelection();
  if (!divs.length) { resumeAnchor = null; if (sel) sel.removeAllRanges(); return; }
  let anchor = null, hadSel = false;
  if (sel && sel.rangeCount && !sel.isCollapsed && captionHasSelection(sel)) {
    hadSel = true;
    const r = sel.getRangeAt(0);
    for (let i = 0; i < divs.length; i++) { if (ptextOf(divs[i]) === r.endContainer) { anchor = { paraIdx: i, offset: r.endOffset }; break; } }
  }
  if (!anchor) { const last = ptextOf(divs[divs.length - 1]); anchor = { paraIdx: divs.length - 1, offset: last ? last.textContent.length : 0 }; }
  if (hadSel && (actionId === 'send' || actionId === 'aa' || actionId === 'simple' || actionId === 'compact' || actionId === 'paste' || /^code[1-5]$/.test(actionId))) {
    sentMarks.push({ paraIdx: anchor.paraIdx, offset: anchor.offset, act: actionId }); if (sentMarks.length > 60) sentMarks.shift();
  }
  resumeAnchor = anchor;
  if (sel) sel.removeAllRanges();
  renderCaption();
}
// draw a small marker at each point the user sent from (children of .para, so they scroll with it)
function renderSentMarks() {
  captionEl.querySelectorAll('.sent-mark, .sent-hr').forEach((e) => e.remove());
  if (!sentMarks.length) return;
  const divs = captionEl.querySelectorAll('.para');
  sentMarks.forEach((m) => {
    if (m.paraIdx < 0 || m.paraIdx >= divs.length) return;
    const div = divs[m.paraIdx]; const node = ptextOf(div); if (!node) return;
    const txt = node.textContent;
    let off = Math.min(m.offset, txt.length);
    // the rolling transcript can shift a stored offset into the middle of a word -> snap to the word's end
    if (off > 0 && off < txt.length && /\S/.test(txt.charAt(off)) && /\S/.test(txt.charAt(off - 1))) {
      while (off < txt.length && /\S/.test(txt.charAt(off))) off++;
    }
    try {
      const rr = document.createRange(); rr.setStart(node, off); rr.setEnd(node, off);
      const rect = rr.getBoundingClientRect(); const pr = div.getBoundingClientRect();
      const mk = document.createElement('span'); mk.className = 'sent-mark m-' + m.act;
      mk.setAttribute('data-act', ({ send: '↑', aa: (hotCfg.aa.label || 'aa'), simple: 'simple', compact: '⤢', paste: '✎' }[m.act] || '•'));
      mk.style.top = (rect.top - pr.top) + 'px'; mk.style.left = (rect.left - pr.left) + 'px';
      div.appendChild(mk);
      // solid rule under the marked line so the send point reads as a clear divider
      const hr = document.createElement('span'); hr.className = 'sent-hr m-' + m.act;
      hr.style.top = (rect.top - pr.top + rect.height) + 'px';
      div.appendChild(hr);
    } catch (e) {}
  });
}
// extend the current selection (or caret) to the transcript end; it then keeps growing
function selectToEnd() {
  const divs = captionEl.querySelectorAll('.para');
  if (!divs.length) return;
  const sel = window.getSelection();
  let startNode = null, startOff = 0;
  if (sel && sel.rangeCount && captionHasSelection(sel)) { const r = sel.getRangeAt(0); startNode = r.startContainer; startOff = r.startOffset; }
  if (!startNode) { startNode = ptextOf(divs[0]); startOff = 0; }
  const endNode = ptextOf(divs[divs.length - 1]);
  if (!startNode || !endNode) return;
  try { const rr = document.createRange(); rr.setStart(startNode, Math.min(startOff, startNode.textContent.length)); rr.setEnd(endNode, endNode.textContent.length); sel.removeAllRanges(); sel.addRange(rr); } catch (e) {}
  resumeAnchor = null;
  setAutoscroll(true);   // selecting to the end means "keep following" -> turn autoscroll on
  scrollBottom();
}
if (window.cap.onGptResult) window.cap.onGptResult((r) => {
  if (r && r.code === 'selection-required') {
    setBusy(false);
    flashBtn('latestBtn');
    showActionNotice(r.error || 'Select a question first, or press Latest.', 'warn');
    return;
  }
  if (r && r.returnToApp) {
    if (!r.ok && (!r.requestId || r.requestId === answerRequestId)) failGptAnswer((r.detail && r.detail.error) || r.error || 'Could not send the request to ChatGPT.');
    return;   // successful insertion is only an acknowledgement; the answer stream ends the busy state
  }
  setBusy(false);
});
if (window.cap.onAdvanceSelection) window.cap.onAdvanceSelection((id) => captureResumeAnchor(id));
$('markBtn').addEventListener('click', () => { if (fullText()) window.cap.saveFile(fullText()).catch(() => {}); });
function applyTopState() {
  window.cap.setAlwaysOnTop(alwaysTop);
  const t = $('topToggle'); if (t) t.checked = alwaysTop;
}
if ($('topToggle')) $('topToggle').addEventListener('change', () => { alwaysTop = $('topToggle').checked; applyTopState(); });
applyTopState();   // set the initial state (off) + sync main

// ---- audio source selector: Speaker (interviewer) / You (mic) / Speaker + Mic ----
function applySrcToggle() {
  const u = $('srcUse'); if (u) u.setAttribute('href', viewMode === 'mic' ? '#i-mic' : '#i-speaker');
  const btn = $('srcBtn'); if (btn) { btn.classList.toggle('src-mic', viewMode === 'mic'); btn.classList.toggle('src-both', viewMode === 'both'); }
  document.querySelectorAll('.src-opt').forEach((o) => o.classList.toggle('sel', o.dataset.src === viewMode));
  captionEl.classList.toggle('view-both', viewMode === 'both');   // per-source coloring only in Both view
}
if ($('srcBtn')) $('srcBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePop('srcBtn', 'srcPop'); });
document.querySelectorAll('.src-opt').forEach((o) => o.addEventListener('click', () => {
  viewMode = o.dataset.src || 'speaker';
  applySrcToggle();
  setAutoscroll(true);      // switching source -> show the latest, don't jump to the top
  renderActive(true);       // full rebuild for the new view (live or review)
  scrollBottom(); closePops();
}));
applySrcToggle();

// system-wide mic mute: red mic-off icon while muted (mutes the Core Audio endpoint -> every app).
// A specific mic can be targeted via the selector (default was the WRONG mic when the user's mic
// isn't the system default) -- '' targets every active mic so the user's mic is always silenced.
let micMuted = false, micUnmutedOnStart = false;
// drop the "Microphone (…)" wrapper so the dropdown shows just the device name (e.g. "NewCoo")
function micLabel(name) { const m = /\(([^)]+)\)/.exec(name || ''); return (m ? m[1] : String(name || '').replace(/^Microphone\s*/i, '')).trim(); }
let micDevice = '', micDevicesList = [];
try { micDevice = localStorage.getItem('caMicDevice') || ''; } catch (e) {}
function setSelectedAsDefaultMic(force) {
  const d = micDevicesList.find((x) => x.name === micDevice);
  if (d && d.id && (force || !d.isDefault) && window.cap.setDefaultMic) window.cap.setDefaultMic(d.id).catch(() => {});
}
function applyMicState() {
  const b = $('micBtn'), u = $('micUse');
  const which = micDevice ? ('“' + micDevice + '”') : 'all microphones';
  if (b) { b.classList.toggle('mic-muted', micMuted); b.title = micMuted ? ('MUTED (' + which + ') — click to unmute') : ('Mute ' + which + ' system-wide (stops it reaching every app, incl. meetings)'); }
  if (u) u.setAttribute('href', micMuted ? '#i-mic-off' : '#i-mic');
}
function micSelects() { return [$('micSelect'), $('micSelect2'), $('micSelect0')].filter(Boolean); }
function fillMicSelects(devs) {
  micSelects().forEach((sel) => {
    sel.innerHTML = '';
    devs.forEach((d) => { const o = document.createElement('option'); o.value = d.name; o.textContent = micLabel(d.name) + (d.isDefault ? '  (default)' : ''); sel.appendChild(o); });
    sel.value = micDevice;
  });
}
function syncMicFromList(devs) {   // reflect the targeted device's mute state on the button
  const d = devs.find((x) => x.name === micDevice);
  micMuted = d ? !!d.muted : false; applyMicState();
}
function refreshMics() {
  window.cap.micList().then((devs) => {
    devs = devs || []; micDevicesList = devs;
    if (!micDevice || !devs.some((d) => d.name === micDevice)) {   // no/stale selection -> pick the default (or first) mic
      const def = devs.find((d) => d.isDefault) || devs[0];
      micDevice = def ? def.name : '';
      try { localStorage.setItem('caMicDevice', micDevice); } catch (e) {}
    }
    fillMicSelects(devs); syncMicFromList(devs);
    if (!micUnmutedOnStart) {   // mute defaults OFF: force-unmute ALL mics once on launch (clears any lingering/stuck mute)
      micUnmutedOnStart = true;
      window.cap.micMute('off', '').then((r) => { if (r && r.ok) { micMuted = false; applyMicState(); } }).catch(() => {});
    }
    if (screen === 'live') startMicMeter();
  }).catch(() => {});
}
micSelects().forEach((sel) => sel.addEventListener('change', () => {
  micDevice = sel.value || '';
  try { localStorage.setItem('caMicDevice', micDevice); } catch (e) {}
  micSelects().forEach((s) => { if (s !== sel) s.value = micDevice; });
  window.cap.micMute('query', '').then((r) => { if (r && r.ok) { micMuted = r.muted; applyMicState(); } }).catch(() => {});
  try { window.cap.setMicName(micDevice); } catch (e) {}   // local GPU STT re-captures the chosen mic
  if (isCloud(micEngine)) applyEngines();   // cloud mic: reconnect the transcriber on the new device
  if (screen === 'live') startMicMeter();
}));
async function toggleMic() {
  const b = $('micBtn'); if (!b || b.classList.contains('busy')) return;
  b.classList.add('busy');   // spinner during the (slightly slow) Core Audio call
  const want = !micMuted;    // drive from INTENT (explicit on/off), not the device's self-reported state --
  console.log('[mic] user wants ' + (want ? 'MUTE' : 'unmute') + ' (all mics)');
  micMuted = want; applyMicState();   // some virtual mics (Voicemod) reset their own mute, so a toggle-read gets stuck
  // target '' = ALL active mics: mutes the physical source too, so a voice-changer's output also goes silent
  try { const r = await window.cap.micMute(want ? 'on' : 'off', ''); if (r && !r.ok) { /* keep intent */ } }
  catch (e) {} finally { b.classList.remove('busy'); }
}
$('micBtn').addEventListener('click', toggleMic);
if (window.cap.onHotkeyMute) window.cap.onHotkeyMute(() => toggleMic());
refreshMics();   // populate selectors + reflect current mute state

// GPT auto scroll (read-along): a header icon + the settings toggle both drive the same state.
// Defaults ON at every launch (the user asked for it enabled by default); toggling only affects this session.
let scrollOn = true;
function applyScrollState() {
  const b = $('scrollBtn'); if (b) { b.classList.toggle('scroll-on', scrollOn); b.title = scrollOn ? 'GPT auto scroll: ON — click to turn off' : 'GPT auto scroll: off — read-along scroll'; }
  const t = $('micInspectorToggle'); if (t) t.checked = scrollOn;
  window.cap.setTeleprompter(scrollOn);
}
function setScrollOn(v) { scrollOn = !!v; applyScrollState(); }
if ($('scrollBtn')) $('scrollBtn').addEventListener('click', () => setScrollOn(!scrollOn));
if ($('micInspectorToggle')) $('micInspectorToggle').addEventListener('change', () => setScrollOn($('micInspectorToggle').checked));
applyScrollState();

// Read-along test console (on the ChatGPT tab) — off by default; toggled from Settings
if ($('consoleToggle')) {
  const applyConsole = () => window.cap.setConsole($('consoleToggle').checked);
  $('consoleToggle').addEventListener('change', applyConsole);
  applyConsole();
}
// GPT auto scroll position: "scroll up at X%" -> "scroll to Y%". Sent to main -> extension SmartScroller.
(function () {
  const ti = $('scrollTrigInput'), ta = $('scrollTargetInput'), tsp = $('scrollSpeedInput'); if (!ti || !ta) return;
  try { const s = JSON.parse(localStorage.getItem('ca_scroll') || 'null'); if (s) { if (s.trigger) ti.value = Math.round(s.trigger * 100); if (s.target) ta.value = Math.round(s.target * 100); if (s.speed && tsp) tsp.value = s.speed; } } catch (e) {}
  const apply = () => {
    let trig = Math.max(.25, Math.min(.95, (+ti.value || 57) / 100));
    let targ = Math.max(.10, Math.min(.90, (+ta.value || 35) / 100));
    let speed = Math.max(.3, Math.min(4, (tsp ? +tsp.value : 1.5) || 1.5));
    if (targ > trig) { targ = trig; ta.value = Math.round(targ * 100); }   // target must be above (smaller %) than the trigger
    try { localStorage.setItem('ca_scroll', JSON.stringify({ trigger: trig, target: targ, speed: speed })); } catch (e) {}
    try { window.cap.setScrollParams({ trigger: trig, target: targ, speed: speed }); } catch (e) {}
  };
  ti.addEventListener('change', apply); ta.addEventListener('change', apply); if (tsp) tsp.addEventListener('change', apply);
  apply();   // push saved/default values to main on load
})();

// ===== Transcription engine: System (Live Captions + WinRT) / gpt-4o-mini-transcribe / Deepgram =====
// Cloud engines capture BOTH the mic (getUserMedia) and the speaker (getDisplayMedia loopback) in the
// renderer and stream to the API; System uses the OS pipeline via IPC captions (guarded in onCaption).
let micTx = null, speakerTx = null, txKeys = null;
function setEngineNote(t) { const n = $('engineNote'); if (n) n.textContent = t || ''; }
function stopEngine() { if (micTx) { micTx.stop(); micTx = null; } if (speakerTx) { speakerTx.stop(); speakerTx = null; } }
function isCloud(e) { return e === 'deepgram' || e === 'elevenlabs' || e === 'speechmatics'; }
function engName(e) { return ({ system: 'System', browser: 'Browser', local: 'Local (Vosk)', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs', speechmatics: 'Speechmatics' }[e] || e); }
function engineSummary() { return '🔊 ' + engName(speakerEngine) + '   ·   🎤 ' + engName(micEngine); }
function onTxStatus(src, st, detail) {
  if (st === 'live') setEngineNote(engineSummary() + ' — live');
  else if (st === 'error') { console.warn('[CA] transcribe', src, detail); setEngineNote((src === 'mic' ? '🎤 ' : '🔊 ') + detail); }
}
// paste-key form: shown when a chosen cloud engine has no saved key. Saving writes it (via main) + re-applies.
let keyFormEngine = null;
function showKeyForm(engine) {
  keyFormEngine = engine;
  const f = $('keyForm'); if (f) f.style.display = 'block';
  const i = $('keyInput'); if (i) { i.value = ''; i.placeholder = 'paste ' + engName(engine) + ' API key'; setTimeout(() => { try { i.focus(); } catch (e) {} }, 30); }
}
function hideKeyForm() { const f = $('keyForm'); if (f) f.style.display = 'none'; }
async function saveKeyFromForm() {
  const i = $('keyInput'); const key = i ? i.value.trim() : ''; if (!key || !keyFormEngine) return;
  try { const r = await window.cap.saveKey(keyFormEngine, key); if (r && r.ok) { txKeys = null; hideKeyForm(); applyEngines(); } else setEngineNote('could not save key'); }
  catch (e) { setEngineNote('could not save key'); }
}
if ($('keySaveBtn')) $('keySaveBtn').addEventListener('click', saveKeyFromForm);
if ($('keyInput')) $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKeyFromForm(); } });
// cloud SPEAKER transcript -> speakerParas (utterance model, mirrors ingestMic)
function ingestSpeakerWS(text, status) {
  if (!text) return;
  const last = speakerParas[speakerParas.length - 1];
  if (speakerOpen && last && last.src === 'speaker') last.text = text;
  else { speakerParas.push({ t: fmt(elapsed()), ts: elapsed(), text: text, src: 'speaker' }); speakerOpen = true; }
  if (status === 'final') speakerOpen = false;
  if (speakerParas.length > MAX_PARAS) speakerParas.splice(0, speakerParas.length - MAX_PARAS);
  if (viewMode === 'speaker') { paragraphs = speakerParas; dirtyFrom = Math.min(dirtyFrom, Math.max(0, speakerParas.length - 1)); }
  if (viewMode !== 'mic') renderActive();
}
// reconcile the renderer-side transcribers to (speakerEngine, micEngine) + tell main. Cloud engines open a
// WebSocket here PER SOURCE (mic + speaker can be different engines); system/browser/local need no socket.
async function applyEngines() {
  stopEngine();
  try { localStorage.setItem('ca_spk_engine', speakerEngine); localStorage.setItem('ca_mic_engine', micEngine); } catch (e) {}
  try { window.cap.setEngines(speakerEngine, micEngine); } catch (e) {}
  const ss = $('speakerEngineSelect'); if (ss && ss.value !== speakerEngine) ss.value = speakerEngine;
  const ms = $('micEngineSelect'); if (ms && ms.value !== micEngine) ms.value = micEngine;
  speakerOpen = false; micOpen = false;
  const needLocal = (speakerEngine === 'local' || micEngine === 'local');
  const ib = $('engineInstallBtn'); if (ib) ib.style.display = needLocal ? 'block' : 'none';
  const ei = $('engineInstall'); if (ei) ei.style.display = needLocal ? 'block' : 'none';   // hide the install log unless a Local engine is selected
  if (micEngine === 'local') { try { window.cap.setMicName(micDevice); } catch (e) {} }
  const clouds = [];   // cloud engines needing a socket (mic first; add speaker if different)
  if (isCloud(micEngine)) clouds.push(micEngine);
  if (isCloud(speakerEngine) && !clouds.includes(speakerEngine)) clouds.push(speakerEngine);
  if (!clouds.length) { hideKeyForm(); setEngineNote(engineSummary()); return; }
  if (!window.CATranscriber) { setEngineNote('transcribe.js not loaded'); return; }
  if (!txKeys) { try { txKeys = await window.cap.getKeys(); } catch (e) { txKeys = {}; } }
  for (const eng of clouds) if (!(txKeys[eng] || '')) { setEngineNote('Paste your ' + engName(eng) + ' API key below and hit Save.'); showKeyForm(eng); return; }
  hideKeyForm(); setEngineNote('connecting…');
  if (isCloud(micEngine)) {
    micTx = new window.CATranscriber({ engine: micEngine, source: 'mic', key: txKeys[micEngine], deviceName: micDevice,
      onText: (text, status) => { ingestMic(text, status); if (viewMode !== 'speaker') renderActive(); if (scrollOn) window.cap.teleFeed(text, status); },
      onStatus: (st, d) => onTxStatus('mic', st, d) });
    micTx.start();
  }
  if (isCloud(speakerEngine)) {
    speakerTx = new window.CATranscriber({ engine: speakerEngine, source: 'speaker', key: txKeys[speakerEngine],
      onText: (text, status) => ingestSpeakerWS(text, status),
      onStatus: (st, d) => onTxStatus('speaker', st, d) });
    speakerTx.start();
  }
}
try { speakerEngine = localStorage.getItem('ca_spk_engine') || 'system'; micEngine = localStorage.getItem('ca_mic_engine') || 'browser'; } catch (e) {}
if ($('speakerEngineSelect')) { $('speakerEngineSelect').value = speakerEngine; $('speakerEngineSelect').addEventListener('change', () => { speakerEngine = $('speakerEngineSelect').value; applyEngines(); }); }
if ($('micEngineSelect')) { $('micEngineSelect').value = micEngine; $('micEngineSelect').addEventListener('change', () => { micEngine = $('micEngineSelect').value; applyEngines(); }); }
// one-click local-model setup (installs torch + RealtimeSTT + faster-whisper)
if ($('engineInstallBtn')) $('engineInstallBtn').addEventListener('click', async () => {
  const el = $('engineInstall'); if (el) el.textContent = 'starting…';
  $('engineInstallBtn').disabled = true; $('engineInstallBtn').textContent = 'installing…';
  let r; try { r = await window.cap.installLocal(); } catch (e) { r = { ok: false }; }
  if (el) el.textContent = (el.textContent + '\n' + (r && r.ok ? '✓ done — reselect Local (Vosk)' : '✗ failed (see log above)')).split('\n').slice(-10).join('\n');
  $('engineInstallBtn').disabled = false; $('engineInstallBtn').textContent = 'Set up local model (one-time)';
});
if (window.cap.onInstallProgress) window.cap.onInstallProgress((l) => { const el = $('engineInstall'); if (el) { el.textContent = (el.textContent + '\n' + l).split('\n').slice(-10).join('\n'); el.scrollTop = el.scrollHeight; } });
// extension -> app reverse channel: close the console here when closed in the browser; show the browser mic
if (window.cap.onConsoleClosed) window.cap.onConsoleClosed(() => { const t = $('consoleToggle'); if (t && t.checked) { t.checked = false; try { window.cap.setConsole(false); } catch (e) {} } });
if (window.cap.onToggleAutoscroll) window.cap.onToggleAutoscroll(() => { try { setScrollOn(!scrollOn); } catch (e) {} });   // browser icon toggled GPT auto scroll
if (window.cap.onBrowserMic) window.cap.onBrowserMic((s) => {
  const lbl = (s && s.label) || '';
  const el = $('browserMicNote'); if (el) el.textContent = lbl ? ('🌐 ' + micLabel(lbl)) : '';   // drop the "Microphone (…)" wrapper
  const b = $('srcBtn'); if (b && lbl) b.title = b.title.split('  ·  ')[0] + '  ·  browser mic: ' + lbl;
});
// local GPU STT (Python) reports its status back through main
if (window.cap.onEngineStatus) window.cap.onEngineStatus((s) => {
  if (speakerEngine !== 'local' && micEngine !== 'local') return;
  if (s.state === 'live') setEngineNote(engineSummary() + ' — live');
  else if (s.state === 'error') setEngineNote((s.src === 'mic' ? '🎤 ' : '🔊 ') + (s.detail || 'error'));
});
applyEngines();

// ---- sound-reactive pulse: glow the mic button with the live input level ----
let micMeter = { stream: null, ctx: null, raf: 0 };
let micLvlSmooth = 0;
function setMicPulse(level) {
  const b = $('micBtn'); if (!b) return;
  const FLOOR = 0.07;
  let l = Math.max(0, Math.min(1, level));
  l = l <= FLOOR ? 0 : (l - FLOOR) / (1 - FLOOR);   // gate the noise floor so it stops fluttering at the bottom in silence
  micLvlSmooth = l > micLvlSmooth ? l : (micLvlSmooth * 0.82 + l * 0.18);   // fast attack, slow decay (VU feel)
  if (micLvlSmooth < 0.02) micLvlSmooth = 0;   // fully settle -> no residual sliver
  b.style.setProperty('--mic-lvl', micLvlSmooth.toFixed(3));   // CSS fills the button bottom-up to this fraction
}
function stopMicMeter() {
  if (micMeter.raf) cancelAnimationFrame(micMeter.raf);
  try { if (micMeter.stream) micMeter.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { if (micMeter.ctx) micMeter.ctx.close(); } catch (e) {}
  micMeter = { stream: null, ctx: null, raf: 0 };
  setMicPulse(0);
}
async function startMicMeter() {
  stopMicMeter();
  try {
    let constraint = true;   // resolve the selected Core Audio name to a MediaDevices id
    if (micDevice && navigator.mediaDevices.enumerateDevices) {
      const list = await navigator.mediaDevices.enumerateDevices();
      const m = list.find((d) => d.kind === 'audioinput' && d.label && d.label.indexOf(micDevice) >= 0);
      if (m && m.deviceId) constraint = { deviceId: { exact: m.deviceId } };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    micMeter.stream = stream; micMeter.ctx = ctx;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      setMicPulse(Math.min(1, Math.sqrt(sum / buf.length) * 3.2));   // scale so normal speech fills the glow
      micMeter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { /* no permission / device -> just no pulse */ }
}

// ===================== session audio: record (live) + replay (review) =====================
async function micConstraint() {
  let constraint = true;
  try {
    if (micDevice && navigator.mediaDevices.enumerateDevices) {
      const list = await navigator.mediaDevices.enumerateDevices();
      const m = list.find((d) => d.kind === 'audioinput' && d.label && d.label.indexOf(micDevice) >= 0);
      if (m && m.deviceId) constraint = { deviceId: { exact: m.deviceId } };
    }
  } catch (e) {}
  return constraint;
}
let caRec = null;   // { mr, chunks, ctx, streams, mime } while a live session is recording
function stopTracksOf(rec) {
  if (!rec) return;
  try { (rec.streams || []).forEach((s) => s.getTracks().forEach((t) => t.stop())); } catch (e) {}
  try { if (rec.ctx && rec.ctx.state !== 'closed') rec.ctx.close(); } catch (e) {}
}
async function startRecording() {
  if (caRec) discardRecording();
  const rec = { mr: null, chunks: [], ctx: null, streams: [], mime: 'audio/webm' };
  const streams = [];
  try {   // speaker = system-audio loopback (drop the video track, like the cloud transcriber does)
    const sp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sp.getVideoTracks().forEach((t) => t.stop());
    if (sp.getAudioTracks().length) streams.push(sp); else sp.getTracks().forEach((t) => t.stop());
  } catch (e) { console.log('[rec] speaker capture unavailable:', e && e.message); }
  try {   // mic (the selected device)
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: await micConstraint() }));
  } catch (e) { console.log('[rec] mic capture unavailable:', e && e.message); }
  if (!streams.length) { console.log('[rec] no audio -> this session will save without a recording'); return; }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    streams.forEach((s) => { try { ctx.createMediaStreamSource(s).connect(dest); } catch (e) {} });   // mix speaker + mic
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
    rec.mr = mr; rec.ctx = ctx; rec.streams = streams; rec.mime = mr.mimeType || mime || 'audio/webm';
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.start(2000);
    caRec = rec;
    console.log('[rec] recording started (' + streams.length + ' stream(s), ' + rec.mime + ')');
  } catch (e) { console.log('[rec] MediaRecorder failed:', e && e.message); streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); }
}
function pauseRecording() { try { if (caRec && caRec.mr && caRec.mr.state === 'recording') caRec.mr.pause(); } catch (e) {} }   // END overlay: exclude the gap
function resumeRecording() { try { if (caRec && caRec.mr && caRec.mr.state === 'paused') caRec.mr.resume(); } catch (e) {} }
function discardRecording() { const rec = caRec; caRec = null; try { if (rec && rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); } catch (e) {} stopTracksOf(rec); }
function stopRecording() {   // -> Promise<Blob|null>
  return new Promise((resolve) => {
    const rec = caRec; caRec = null;
    if (!rec || !rec.mr) { stopTracksOf(rec); resolve(null); return; }
    const done = () => { stopTracksOf(rec); resolve(rec.chunks.length ? new Blob(rec.chunks, { type: rec.mime }) : null); };
    if (rec.mr.state === 'inactive') { done(); return; }
    rec.mr.onstop = done;
    try { if (rec.mr.state === 'paused') rec.mr.resume(); } catch (e) {}   // resume so stop() flushes the tail
    try { rec.mr.stop(); } catch (e) { done(); }
  });
}
async function saveSessionAudio(id) {
  const blob = await stopRecording();
  if (!blob) return null;
  try { const buf = new Uint8Array(await blob.arrayBuffer()); const r = await window.cap.saveAudio(String(id), buf); return (r && r.ok) ? (r.file || (String(id) + '.webm')) : null; }
  catch (e) { console.log('[rec] audio save failed:', e && e.message); return null; }
}
function entryList(arr) { return (arr || []).map((p) => ({ ts: p.ts || 0, text: p.text || '' })).filter((e) => e.text); }
function buildSessionObj(id, name, dur) {
  return { id: id, ts: Date.now(), name: name, duration: dur, mode: mode,
    speaker: fullTextOf(speakerParas), mic: fullTextOf(micParas), text: fullTextOf(speakerParas),
    speakerEntries: entryList(speakerParas), micEntries: entryList(micParas) };
}
function entriesToParas(entries, fallbackText, src) {
  if (entries && entries.length) return entries.map((e) => ({ t: fmt(e.ts || 0), ts: e.ts || 0, text: e.text, src: src }));
  return reviewParas(fallbackText, src);   // older sessions: no per-line ts -> fake index ts, no sync
}

// ---- replay player (review mode) ----
let caPlay = null;         // { url, autoscroll, lastScroll } while reviewing a recorded session
let replayWired = false;
function teardownReplay() {
  const a = $('rpAudio'); if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {} }
  if (caPlay && caPlay.url) { try { URL.revokeObjectURL(caPlay.url); } catch (e) {} }
  caPlay = null;
  const bar = $('replayBar'); if (bar) bar.classList.add('hidden');
  captionEl.querySelectorAll('.para.playing').forEach((d) => d.classList.remove('playing'));
}
function setupReplay(s) {
  teardownReplay();
  const bar = $('replayBar'); if (!bar || !s || !s.audio) return;   // no recording -> no player
  caPlay = { url: null, autoscroll: true, lastScroll: -1 };
  wireReplayControls();
  bar.classList.remove('hidden');
  $('rpScroll').classList.add('on');
  const a = $('rpAudio'); a.playbackRate = parseFloat($('rpSpeed').value) || 1;
  window.cap.getAudio(String(s.id)).then((buf) => {
    if (!buf || !caPlay) { bar.classList.add('hidden'); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: 'audio/webm' }));
    caPlay.url = url; a.src = url; a.load();
  }).catch(() => { bar.classList.add('hidden'); });
}
function syncCaptionTo(t) {
  let idx = -1;
  for (let i = 0; i < paragraphs.length; i++) { if ((paragraphs[i].ts || 0) <= t + 0.25) idx = i; else break; }   // paras are ts-ordered per view
  const divs = captionEl.querySelectorAll('.para');
  for (let i = 0; i < divs.length; i++) { const on = (i === idx); if (divs[i].classList.contains('playing') !== on) divs[i].classList.toggle('playing', on); }
  if (idx >= 0 && divs[idx] && caPlay && caPlay.autoscroll && caPlay.lastScroll !== idx) {
    caPlay.lastScroll = idx;
    const el = divs[idx];   // center the playing paragraph in the caption viewport (scroll the caption container itself)
    const contentY = (el.getBoundingClientRect().top - captionEl.getBoundingClientRect().top) + captionEl.scrollTop + el.offsetHeight / 2;
    const target = Math.max(0, Math.min(captionEl.scrollHeight - captionEl.clientHeight, contentY - captionEl.clientHeight / 2));
    programmaticScroll = true;
    try { captionEl.scrollTo({ top: target, behavior: 'smooth' }); } catch (e) { captionEl.scrollTop = target; }
  }
}
function wireReplayControls() {
  if (replayWired) return; replayWired = true;
  const a = $('rpAudio'), seek = $('rpSeek'); let seeking = false, durReady = false;
  // MediaRecorder webm has no duration in its header -> audio.duration is Infinity and seeking is dead.
  // Force Chromium to compute it: seek far past the end, let it clamp, then snap back to 0.
  function fixDuration() {
    if (a.duration === Infinity || isNaN(a.duration) || !a.duration) {
      durReady = false;
      const ontu = () => { a.removeEventListener('timeupdate', ontu); try { a.currentTime = 0; } catch (e) {} durReady = true; $('rpDur').textContent = fmt(Math.floor(isFinite(a.duration) ? a.duration : 0)); };
      a.addEventListener('timeupdate', ontu);
      try { a.currentTime = 1e101; } catch (e) { durReady = true; }
    } else { durReady = true; $('rpDur').textContent = fmt(Math.floor(a.duration || 0)); }
  }
  $('rpPlay').addEventListener('click', () => { if (a.paused) a.play(); else a.pause(); });
  $('rpBack').addEventListener('click', () => { a.currentTime = Math.max(0, a.currentTime - 10); });
  $('rpFwd').addEventListener('click', () => { a.currentTime = Math.min(a.duration || 0, a.currentTime + 10); });
  $('rpSpeed').addEventListener('change', () => { a.playbackRate = parseFloat($('rpSpeed').value) || 1; });
  $('rpScroll').addEventListener('click', () => { if (!caPlay) return; caPlay.autoscroll = !caPlay.autoscroll; $('rpScroll').classList.toggle('on', caPlay.autoscroll); });
  seek.addEventListener('input', () => { seeking = true; if (a.duration) $('rpCur').textContent = fmt(Math.floor(a.duration * seek.value / 1000)); });
  seek.addEventListener('change', () => { if (a.duration) a.currentTime = a.duration * seek.value / 1000; seeking = false; });
  a.addEventListener('play', () => { $('rpPlay').textContent = '⏸'; });
  a.addEventListener('pause', () => { $('rpPlay').textContent = '▶'; });
  a.addEventListener('loadedmetadata', fixDuration);
  a.addEventListener('durationchange', () => { if (durReady && isFinite(a.duration)) $('rpDur').textContent = fmt(Math.floor(a.duration)); });
  a.addEventListener('timeupdate', () => {
    if (!durReady || !isFinite(a.duration) || !a.duration) return;   // ignore updates during the duration-fix seek
    if (!seeking) seek.value = Math.round(a.currentTime / a.duration * 1000);
    $('rpCur').textContent = fmt(Math.floor(a.currentTime));
    syncCaptionTo(a.currentTime);
  });
}
// click a transcript line while reviewing -> seek playback there (ignored while selecting text)
captionEl.addEventListener('click', (e) => {
  if (!review || !caPlay || !caPlay.url) return;
  const sel = window.getSelection(); if (sel && !sel.isCollapsed) return;
  const para = e.target && e.target.closest ? e.target.closest('.para') : null; if (!para) return;
  const divs = Array.prototype.slice.call(captionEl.querySelectorAll('.para'));
  const idx = divs.indexOf(para); if (idx < 0 || !paragraphs[idx]) return;
  const a = $('rpAudio'); a.currentTime = paragraphs[idx].ts || 0; a.play();
});
// Clicking anywhere re-asserts topmost so we surface above another always-on-top
// window (e.g. a browser forced on-top by WindowsTop.exe). Fires on every mousedown
// regardless of focus (covers the already-focused case). Capture phase, no
// preventDefault, so caption drag/selection is untouched. Gated by the ↑ toggle.
window.addEventListener('mousedown', () => { if (alwaysTop) window.cap.raiseTop(); }, true);
function showHelp() {
  alert('Caption assistance — interview support over Live Captions\n\n' +
    'Mirrors Windows Live Captions so you can SELECT the interviewer’s words and act on them.\n\n' +
    'TRANSCRIPT\n' +
    '• Drag to select  ·  double-click = a sentence  ·  triple-click = the line\n' +
    '• “Till the end” keeps following new text (auto-scroll on)\n' +
    '• Minimap on the right: drag to navigate; red marks show where you sent from\n\n' +
    'SEND TO CHATGPT (needs the Chrome extension + a bound tab)\n' +
    '• ↑ Send (F1): send the selection  ·  aa (F2): keyword + selection  ·  zz (F3): keyword only\n' +
    '• Chat icon: OFF shows the reply in ChatGPT; ON keeps focus here and streams the reply beside the transcript\n' +
    '• ✎ Edit-before-send: paste without submitting  ·  Compact (F6): move the chat to a fresh tab\n' +
    '• The chain icon in ChatGPT binds the tab; the copy icon copies the last answer\n\n' +
    'GPT AUTO SCROLL (read-along)\n' +
    '• Settings → GPT auto scroll: as you read the answer aloud, the line is marked and the page follows you\n\n' +
    'OTHER\n' +
    '• Mic button: mute your mic system-wide (also a hotkey)  ·  its fill shows live input level\n' +
    '• Eye: Live Captions opacity, window opacity, keep-on-top\n' +
    '• Shield: privacy overlay + recovery shortcuts  ·  Gear: audio, ChatGPT actions and hotkeys  ·  Save: export the transcript');
}
$('helpBtn').addEventListener('click', showHelp);
document.querySelectorAll('.act-help').forEach((b) => b.addEventListener('click', showHelp));
document.querySelectorAll('.side[data-nav]').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));

// ===== Default prompts page =====
const CA_PROMPT_EDITS_KEY = 'captionassistance_prompt_edits_v1';
let caPrompts = null, caPromptIdx = 0, caPromptEditing = false;
function loadPromptEdits() {
  try { const v = JSON.parse(localStorage.getItem(CA_PROMPT_EDITS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch (e) { return {}; }
}
function savePromptEdits(edits) { localStorage.setItem(CA_PROMPT_EDITS_KEY, JSON.stringify(edits)); }
function setPromptEditing(on) {
  caPromptEditing = !!on;
  const text = $('promptText');
  if (text) { text.readOnly = !caPromptEditing; text.classList.toggle('editing', caPromptEditing); }
  if ($('promptEdit')) $('promptEdit').classList.toggle('hidden', caPromptEditing);
  if ($('promptSave')) $('promptSave').classList.toggle('hidden', !caPromptEditing);
  if ($('promptCancel')) $('promptCancel').classList.toggle('hidden', !caPromptEditing);
  if (caPromptEditing && text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
}
async function loadPrompts() {
  if (!caPrompts) {
    try {
      const edits = loadPromptEdits();
      caPrompts = (await window.cap.getPrompts()).map((p) => ({ ...p, originalText: p.text, text: Object.prototype.hasOwnProperty.call(edits, p.name) ? edits[p.name] : p.text }));
    } catch (e) { caPrompts = []; }
  }
  // Open the prompt that matches the interview mode selected on the New Session page.
  // If a mode does not have its own prompt yet, keep the current/Standard prompt.
  const preferredName = mode === 'Live Coding'
    ? 'Interview Prompt(Live Coding)'
    : (mode === 'System Design' ? 'Interview Prompt(System Design)' : 'Interview Prompt(Standard)');
  const preferredIdx = caPrompts.findIndex((p) => p.name === preferredName);
  if (preferredIdx >= 0) caPromptIdx = preferredIdx;
  else if (caPromptIdx >= caPrompts.length) caPromptIdx = 0;
  const tabs = $('promptTabs');
  if (tabs) {
    tabs.innerHTML = '';
    caPrompts.forEach((p, i) => {
      const t = document.createElement('button');
      t.className = 'prompt-tab' + (i === caPromptIdx ? ' active' : '');
      t.textContent = p.name;
      t.addEventListener('click', () => { caPromptIdx = i; setPromptEditing(false); renderPrompt(); });
      tabs.appendChild(t);
    });
    tabs.style.display = caPrompts.length > 1 ? 'flex' : 'none';
  }
  renderPrompt();
}
function renderPrompt() {
  const p = (caPrompts || [])[caPromptIdx];
  if ($('promptName')) $('promptName').textContent = p ? p.name : 'No prompt found';
  if ($('promptText')) $('promptText').value = p ? p.text : 'No prompts were bundled with this build.';
  document.querySelectorAll('.prompt-tab').forEach((t, i) => t.classList.toggle('active', i === caPromptIdx));
}
if ($('promptEdit')) $('promptEdit').addEventListener('click', () => {
  if ((caPrompts || [])[caPromptIdx]) setPromptEditing(true);
});
if ($('promptCancel')) $('promptCancel').addEventListener('click', () => {
  renderPrompt(); setPromptEditing(false);
});
if ($('promptSave')) $('promptSave').addEventListener('click', () => {
  const p = (caPrompts || [])[caPromptIdx]; if (!p || !$('promptText')) return;
  p.text = $('promptText').value;
  const edits = loadPromptEdits();
  if (p.text === p.originalText) delete edits[p.name]; else edits[p.name] = p.text;
  savePromptEdits(edits); setPromptEditing(false);
  const b = $('promptEdit'); b.textContent = 'Saved ✓'; setTimeout(() => { b.textContent = 'Edit'; }, 1200);
});
if ($('promptCopy')) $('promptCopy').addEventListener('click', () => {
  const p = (caPrompts || [])[caPromptIdx]; if (!p) return;
  window.cap.copy(caPromptEditing && $('promptText') ? $('promptText').value : p.text);
  const b = $('promptCopy'), o = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = o; }, 1200);
});
['min1', 'min2', 'min3', 'min4'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', () => window.cap.minimize()); });
// closing with a live transcript -> ask whether to save first
function requestClose() {
  if (screen === 'live' && !review && paragraphs.length) {
    const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
    $('exitName').value = 'Session ' + now.toLocaleString(undefined, { month: 'short', day: 'numeric' }) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    showOverlay('exit');
  } else { window.cap.close(); }
}
['close1', 'close2', 'close3', 'close4'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', requestClose); });
$('exitSave').addEventListener('click', async () => {
  const name = ($('exitName').value || '').trim() || 'Untitled session';
  const id = Date.now();
  const dur = fmt(captureStopped ? frozenElapsed : elapsed());
  const s = buildSessionObj(id, name, dur);
  s.audio = await saveSessionAudio(id);
  const sessions = loadSessions(); sessions.push(s); saveSessions(sessions);
  window.cap.close();
});
$('exitNoSave').addEventListener('click', () => { discardRecording(); window.cap.close(); });
$('exitCancel').addEventListener('click', hideOverlay);

// ================= live caption stream =================
window.cap.onCaption((obj) => {
  if (screen !== 'live' || review || captureStopped) return;
  // Route by SOURCE against the per-source engine. mic captions arrive here from Chrome speech
  // (from:'chrome'), the WinRT fallback, or local Vosk; cloud mic/speaker arrive via their own WebSockets
  // (micTx/speakerTx), not here. The Live Captions reader runs in every mode (opacity) but its sourceless
  // text only counts as the SPEAKER source when speakerEngine is 'system'.
  if (obj.src === 'mic') {   // microphone source (you) -- captured continuously, shown in mic/both view
    if (micEngine !== 'browser' && micEngine !== 'local') return;   // cloud mic comes via micTx
    if (obj.status === 'waiting' || obj.status === 'setup') return;
    if (micEngine === 'browser') {                                  // prefer Chrome speech over the WinRT fallback
      if (obj.from === 'chrome') caLastChromeMic = Date.now();
      else if (Date.now() - caLastChromeMic < 6000) return;         // ...ignore the WinRT reader while Chrome is feeding
    }
    ingestMic(obj.text, obj.status);
    if (viewMode !== 'speaker') renderActive();
    return;
  }
  // speaker source: sourceless text = Live Captions (speaker='system'); src:'speaker' = local Vosk (speaker='local')
  if (obj.src === 'speaker') { if (speakerEngine !== 'local') return; }
  else if (speakerEngine !== 'system') return;   // sourceless LC text, but a non-system speaker engine is active
  if (obj.status === 'waiting') { if (viewMode === 'speaker' && !speakerParas.length) setPlaceholder('Listening…'); $('ts').textContent = 'waiting'; return; }
  if (obj.status === 'setup') { if (viewMode === 'speaker' && !speakerParas.length) setPlaceholder('Preparing speech model…'); $('ts').textContent = 'setup'; return; }
  const cur = (obj.text || '').replace(/\r/g, '');   // keep the newlines Live Captions inserts
  if (!cur.trim()) return;
  ingestWindow(cur);
  if (viewMode !== 'mic') renderActive();
});

show('home');
