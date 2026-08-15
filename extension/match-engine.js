// ============================================================================
// match-engine.js  --  PhonoDTW-MAC read-along engine (pure JS, no deps)
// Finds which ANSWER line the user is reading aloud from noisy (~80%) mic ASR.
//   const eng = new PhonoDTW(answerLines);
//   eng.update(micText, status) -> { lineIndex, confidence, wordProgressInLine }
// Plus SmartScroller: 70%->40% dead-band, speed-capped easeInOutCubic, forward-only.
// Designed via a 4-way design panel + judge (see teleprompter-engine workflow).
// Works in Node (module.exports) and the browser (window.MatchEngine / globals).
// ============================================================================
(function (root) {
  'use strict';

  var FILLERS = new Set(['uh', 'um', 'er', 'ah', 'mm', 'hmm', 'uhh', 'umm', 'like']);
  var STOP = new Set('the a an of to in on at is it and or for as be by we you i that this with your my our are was were will would can could of it\'s i\'m'.split(' '));

  function norm(w) {
    return String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9']/g, '');
  }
  function tokenize(s) {
    return String(s || '').split(/\s+/).map(norm).filter(function (w) { return w && !FILLERS.has(w); });
  }

  // lightweight Metaphone-ish consonant-class key (collapses ASR-confusable sounds)
  function phon(w) {
    w = norm(w); if (!w) return '';
    w = w.replace(/^(kn|gn|wr)/, function (c) { return c[1]; }).replace(/^x/, 's').replace(/mb$/, 'm')
      .replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k').replace(/sh|ch/g, 'X').replace(/th/g, '0').replace(/wh/g, 'w');
    var CL = { b: 'P', p: 'P', v: 'F', f: 'F', d: 'T', t: 'T', g: 'K', k: 'K', q: 'K', c: 'K', z: 'S', s: 'S', x: 'S', m: 'N', n: 'N', l: 'R', r: 'R', j: 'J', w: 'W', y: 'Y', h: 'H', '0': '0', X: 'X' };
    var out = '', first = true;
    for (var i = 0; i < w.length; i++) {
      var ch = w[i];
      if ('aeiou'.indexOf(ch) >= 0) { if (first) out += 'A'; continue; }
      var c = CL[ch] || ch; if (out[out.length - 1] !== c) out += c; first = false;
    }
    return out;
  }

  // banded Levenshtein with early-exit at cap -> effectively O(len)
  function levCap(a, b, cap) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    var prev = []; for (var j = 0; j <= lb; j++) prev[j] = j;
    for (var i = 1; i <= la; i++) {
      var cur = [i], best = i;
      for (var jj = 1; jj <= lb; jj++) {
        var c = Math.min(prev[jj] + 1, cur[jj - 1] + 1, prev[jj - 1] + (a[i - 1] === b[jj - 1] ? 0 : 1));
        cur[jj] = c; if (c < best) best = c;
      }
      if (best > cap) return cap + 1;
      prev = cur;
    }
    return prev[lb];
  }

  // FUSED token similarity: exact | raw-Lev | phonetic-Lev (x0.85), gated at tau
  function simTok(S, A, cap, tau) {
    if (S.raw === A.raw) return 1;
    var Lr = Math.max(S.raw.length, A.raw.length) || 1;
    var dr = levCap(S.raw, A.raw, cap);
    var sim = dr <= cap ? 1 - dr / Lr : 0;
    if (S.ph && A.ph) {
      var Lp = Math.max(S.ph.length, A.ph.length) || 1;
      var dp = levCap(S.ph, A.ph, cap);
      if (dp <= cap) sim = Math.max(sim, 0.85 * (1 - dp / Lp));
    }
    return sim >= tau ? sim : 0;
  }

  // ---------------- one-time answer prep ----------------
  function prepare(lines) {
    var A = [], lineStart = [], lineLen = [], df = new Map();
    lines.forEach(function (ln, li) {
      lineStart[li] = A.length;
      var t = tokenize(ln);
      lineLen[li] = Math.max(1, t.length);
      t.forEach(function (raw, p) {
        A.push({ raw: raw, ph: phon(raw), stop: STOP.has(raw), line: li, posInLine: p });
        df.set(raw, (df.get(raw) || 0) + 1);
      });
    });
    var L = A.length || 1;
    var idf = function (t) { return Math.min(3, Math.max(0.3, Math.log((L + 1) / ((df.get(t) || 0) + 0.5)))); };
    A.forEach(function (a) { a.w = a.stop ? 0.35 : idf(a.raw); });
    return { A: A, lineStart: lineStart, lineLen: lineLen, idf: idf };
  }

  var D = {
    WINDOW_N: 14, MIN_WINDOW: 3, BAND_BACK: 6, BAND_FWD: 26, MAX_ADVANCE: 8, TAU_TOK: 0.70, LEV_CAP: 2,
    MATCH_BASE: 2.0, MISMATCH_PEN: -1.0, GAP_SPOKEN: -0.6, GAP_ANSWER: -0.5, RECENCY: 0.9, STOP_W: 0.35,
    SIGMA_FWD: 14, SIGMA_BACK: 3, PRIOR_FLOOR: 0.3, MIN_MATCH_WORDS: 3, TAU_ADVANCE: 0.5, STRONG: 0.62,
    REGRESS_TOK: 6, BACK_RUN: 3, EMA_ALPHA: 0.6, CONFIRM_PARTIAL: 2, CONFIRM_FINAL: 1, CONFIRM_BACK: 3,
    ENTER_MARGIN: 0.06, MARGIN_K: 8, CONF_EMA: 0.5, RESYNC_AFTER: 6, RESYNC_MIN: null, RESYNC_GLOBAL: false,
    FREE: false, FREE_SIGMA: 45, FREE_WINDOWS: [5, 8, 12],
    // FREE directional prior: readers move FORWARD (next sentence, or skip ahead over spans the ASR
    // dropped) and rarely re-read a previous sentence. So forward jumps are cheap (wide sigma, high
    // floor) while backward jumps are expensive (narrow sigma, low floor) -> a backward match must be
    // much stronger to win. Within-sentence anchor lag (a few tokens back) is still ~free.
    FREE_SIGMA_FWD: 90, FREE_SIGMA_BACK: 10, FREE_FLOOR_FWD: 0.82, FREE_FLOOR_BACK: 0.28, FREE_BACK_SLACK: 3
  };

  function PhonoDTW(lines, opt) {
    this.o = Object.assign({}, D, opt || {});
    var prep = prepare(lines || []);
    this.A = prep.A; this.lineStart = prep.lineStart; this.lineLen = prep.lineLen; this.idf = prep.idf;
    this.cursor = 0; this.emitted = 0; this.ema = 0; this.committed = []; this.prevLen = 0;
    this.confLine = -1; this.confCnt = 0; this.backConfirm = 0; this.lowConf = 0; this.conf = 0;
    this.paraOf = this.o.paraOf || null;   // paragraph index per line (for the mid-paragraph jump penalty)
  }

  // banded local Smith-Waterman around anchor c; returns {dice, headIdx, matchLen, backRun}
  PhonoDTW.prototype._align = function (S, sw, totalS, c) {
    var o = this.o, A = this.A, k = S.length;
    var wlen = Math.min(k + 2, A.length - c);
    if (wlen <= 0) return { dice: 0, headIdx: c, matchLen: 0, backRun: 0 };
    var H = [], M = [];
    for (var r = 0; r <= k; r++) { H.push(new Float32Array(wlen + 1)); M.push(new Int16Array(wlen + 1)); }
    var totalW = 0; for (var j0 = 0; j0 < wlen; j0++) totalW += A[c + j0].w;
    var best = { h: 0, i: 0, j: 0 };
    for (var i = 1; i <= k; i++) {
      var rec = Math.pow(o.RECENCY, k - i);           // newest spoken word => exponent 0
      for (var j = 1; j <= wlen; j++) {
        var s = simTok(S[i - 1], A[c + j - 1], o.LEV_CAP, o.TAU_TOK);
        var match = s > 0;
        var diag = H[i - 1][j - 1] + (match ? o.MATCH_BASE * s * rec * sw[i - 1] : o.MISMATCH_PEN);
        var gS = H[i - 1][j] + o.GAP_SPOKEN, gA = H[i][j - 1] + o.GAP_ANSWER;
        var h = 0, m = 0;
        if (diag > h) { h = diag; m = M[i - 1][j - 1] + (match ? 1 : 0); }
        if (gS > h) { h = gS; m = M[i - 1][j]; }
        if (gA > h) { h = gA; m = M[i][j - 1]; }
        H[i][j] = h; M[i][j] = m;
        if (h > best.h || (h === best.h && i > best.i)) best = { h: h, i: i, j: j };
      }
    }
    // greedy overlap -> order-agnostic Dice normaliser (safety net vs a single bad DP path)
    var used = new Array(wlen).fill(false), inter = 0;
    for (var ii = k - 1; ii >= 0; ii--) {
      var bs = 0, bj = -1;
      for (var jj = 0; jj < wlen; jj++) {
        if (used[jj]) continue;
        var ss = simTok(S[ii], A[c + jj], o.LEV_CAP, o.TAU_TOK);
        if (ss > bs) { bs = ss; bj = jj; }
      }
      if (bj >= 0 && bs > 0) { used[bj] = true; inter += sw[ii] * bs; }
    }
    var dice = (2 * inter) / ((totalS + totalW) || 1);
    // short traceback: consecutive strong matches ending at the best cell
    var bi = best.i, bjt = best.j, run = 0;
    while (bi > 0 && bjt > 0 && simTok(S[bi - 1], A[c + bjt - 1], o.LEV_CAP, o.TAU_TOK) >= 0.72) { run++; bi--; bjt--; }
    var headIdx = best.j > 0 ? c + best.j - 1 : c;
    return { dice: dice, headIdx: headIdx, matchLen: M[best.i][best.j], backRun: run };
  };

  // viewport prior: the reader reads what's ON SCREEN, so among ambiguous/duplicate sentences prefer one
  // in view. On-screen -> full weight; off-screen -> soft, floored falloff (a strong just-off-screen match
  // during a scroll/jump can still win). Disabled when no view range is supplied.
  PhonoDTW.prototype._viewPrior = function (line) {
    var o = this.o;
    if (!o.VIEW_BONUS || this.visLo == null) return 1;
    if (line >= this.visLo && line <= this.visHi) return 1;
    var d = line < this.visLo ? (this.visLo - line) : (line - this.visHi);
    var fl = (o.VIEW_FLOOR != null) ? o.VIEW_FLOOR : 0.55, sg = o.VIEW_SIGMA || 2;
    return fl + (1 - fl) * Math.exp(-(d * d) / (2 * sg * sg));
  };
  // (VIEW_BONUS / VIEW_FLOOR / VIEW_SIGMA are read from options; see _viewPrior)
  PhonoDTW.prototype.update = function (micText, status, view) {
    var o = this.o;
    if (view && typeof view.lo === 'number') { this.visLo = view.lo; this.visHi = view.hi; } else { this.visLo = null; this.visHi = null; }
    // 1) own buffer, immune to WinRT partial/final resets
    var live = tokenize(micText).map(function (raw) { return { raw: raw, ph: phon(raw), stop: STOP.has(raw) }; });
    if (status === 'final') { for (var q = 0; q < live.length; q++) this.committed.push(live[q]); }
    if (this.committed.length > 80) this.committed.splice(0, this.committed.length - 80);
    var stream = status === 'final' ? this.committed : this.committed.concat(live);
    var S = stream.slice(-o.WINDOW_N), k = S.length;
    var contentN = S.filter(function (t) { return !t.stop; }).length;
    if (k < o.MIN_WINDOW || contentN < 2) return this._emit(this.conf * 0.9);

    // 2) spoken weights = (idf | 1.0 | STOP_W) x recency
    var self = this;
    var sw = S.map(function (t, i) {
      var base = t.stop ? o.STOP_W : (self.idf(t.raw) || 1.0);
      return base * Math.pow(o.RECENCY, (k - 1 - i));
    });
    var totalS = sw.reduce(function (a, b) { return a + b; }, 0);

    // FREE navigation: the reader may jump forward OR back to any sentence. Score the recent window
    // against EVERY position each update; a mild locality prior breaks ties toward continuity but a
    // strong far match wins. Ambiguous/low match -> HOLD (return previous line), so an unsure read
    // never yanks the highlight.
    if (o.FREE) {
      // MULTI-WINDOW: a jump leaves the recent speech split (tail-of-old + start-of-new) so no single
      // fixed window matches. Try several trailing window LENGTHS -- a short one locks onto the new
      // spot right after a jump; a long one is stable while reading straight -- and keep whichever is
      // the most CONFIDENT match. Ambiguous/weak -> HOLD.
      var sizes = o.FREE_WINDOWS || [5, 8, 12];
      var pick = null;
      // HARD viewport gate bounds (line units): the reader only reads what's ON SCREEN, and on a jump they
      // scroll the target paragraph into view FIRST -> only sentences within the visible range (+/- margin)
      // are match candidates. This is what kills duplicate-sentence mis-locks and keeps the match where the
      // eyes are. Falls back to a full scan when no view range is supplied.
      var haveView = !!(o.VIEW_BONUS && this.visLo != null);
      var vMargin = (o.VIEW_MARGIN != null) ? o.VIEW_MARGIN : 1;
      var vLoL = haveView ? (this.visLo - vMargin) : 0;
      var vHiL = haveView ? (this.visHi + vMargin) : 0;
      // paragraph-aware jump rule: readers move sequentially, or JUMP to a paragraph START -- they don't
      // jump into the MIDDLE of another paragraph. So a cross-paragraph match that doesn't land on the
      // target paragraph's first sentence is penalized. (curLine = where the frontier currently sits.)
      var curLine = this.A[Math.min(this.cursor, this.A.length - 1)].line;
      var midJumpPen = (o.MIDPARA_JUMP_PEN != null) ? o.MIDPARA_JUMP_PEN : 0.2;
      for (var wi = 0; wi < sizes.length; wi++) {
        var wn = Math.min(sizes[wi], stream.length);
        if (wn < 2) continue;
        var Sw = stream.slice(-wn), kw = Sw.length;
        var cN = 0; for (var ci = 0; ci < kw; ci++) if (!Sw[ci].stop) cN++;
        if (cN < 1) continue;
        var swW = Sw.map(function (t, i) { var base = t.stop ? o.STOP_W : (self.idf(t.raw) || 1.0); return base * Math.pow(o.RECENCY, (kw - 1 - i)); });
        var totW = swW.reduce(function (a, b) { return a + b; }, 0);
        var gb = { score: -1, dice: 0, headIdx: this.cursor, matchLen: 0 }, gs2 = { score: -1 };
        var fcStart = 0;
        if (haveView) { var sLn = Math.max(0, vLoL - 2); fcStart = (this.lineStart[sLn] != null) ? this.lineStart[sLn] : 0; }   // skip tokens well above the view
        for (var fc = fcStart; fc < this.A.length; fc++) {
          if (haveView && this.A[fc].line > vHiL) break;   // A[].line is non-decreasing -> nothing below the view can match
          var fr = this._align(Sw, swW, totW, fc);
          var hL = this.A[Math.max(0, Math.min(fr.headIdx, this.A.length - 1))].line;
          if (haveView && (hL < vLoL || hL > vHiL)) continue;   // matched sentence is OUT OF VIEW -> not a candidate
          // penalize a cross-paragraph move that lands MID-paragraph (not on its start): people don't read
          // that way. Same-paragraph moves (sequential + skips) and jumps to a paragraph START are free.
          var jumpFactor = 1;
          if (this.paraOf && this.paraOf[hL] !== this.paraOf[curLine]) {
            var tgtIsStart = (hL === 0) || (this.paraOf[hL - 1] !== this.paraOf[hL]);
            if (!tgtIsStart) jumpFactor = midJumpPen;
          }
          var fdx = fr.headIdx - this.cursor;
          // asymmetric: reading forward is expected (cheap), re-reading backward is rare (costly).
          // a few tokens of backward anchor-lag are free (FREE_BACK_SLACK) so within-sentence reading isn't punished.
          var eff = fdx >= 0 ? fdx : Math.min(0, fdx + o.FREE_BACK_SLACK);
          var fsig = eff >= 0 ? o.FREE_SIGMA_FWD : o.FREE_SIGMA_BACK;
          var ffloor = eff >= 0 ? o.FREE_FLOOR_FWD : o.FREE_FLOOR_BACK;
          var fprior = ffloor + (1 - ffloor) * Math.exp(-(eff * eff) / (2 * fsig * fsig));
          var fscore = fr.dice * fprior * jumpFactor;   // viewport hard-gated above; paragraph mid-jump penalty here
          if (fscore > gb.score) { gs2 = { score: gb.score }; gb = { score: fscore, dice: fr.dice, headIdx: fr.headIdx, matchLen: fr.matchLen }; }
          else if (fscore > gs2.score) gs2 = { score: fscore };
        }
        var fmargin = gb.score - Math.max(0, gs2.score);
        var fconf = Math.max(0, Math.min(1, gb.dice * (0.5 + 0.5 / (1 + Math.exp(-o.MARGIN_K * fmargin))) * Math.min(1, cN / o.MIN_MATCH_WORDS)));
        var rank = fconf + wn * 0.003;   // tie-break toward the LONGER (more context = more reliable) window
        if (!pick || rank > pick.rank) pick = { rank: rank, conf: fconf, dice: gb.dice, headIdx: gb.headIdx, matchLen: gb.matchLen, wn: wn };
      }
      if (!pick) return this._emit(this.conf * 0.9);
      this.conf = o.CONF_EMA * pick.conf + (1 - o.CONF_EMA) * this.conf;
      if (pick.matchLen >= 2 && pick.dice >= (o.FREE_TAU || 0.42)) {
        this.cursor = pick.headIdx;
        var fLine = this.A[Math.min(this.cursor, this.A.length - 1)].line;
        if (fLine !== this.emitted) {
          if (fLine === this.confLine) this.confCnt++; else { this.confLine = fLine; this.confCnt = 1; }
          if (this.confCnt >= (status === 'final' ? o.CONFIRM_FINAL : o.CONFIRM_PARTIAL)) { this.emitted = fLine; this.confCnt = 0; }
        } else this.confCnt = 0;
      }
      return this._emit(this.conf);
    }

    // 3) forward-biased band around the monotonic cursor
    var newSpoken = Math.max(0, stream.length - this.prevLen); this.prevLen = stream.length;
    var target = this.cursor + Math.min(newSpoken, o.MAX_ADVANCE);
    var lo = Math.max(0, this.cursor - o.BAND_BACK), hi = Math.min(this.A.length - 1, this.cursor + o.BAND_FWD);

    // 4) score = alignment-Dice x asymmetric positional prior
    var best = { score: -1 }, second = { score: -1 };
    for (var c = lo; c <= hi; c++) {
      var rr = this._align(S, sw, totalS, c);
      // prior centers on the read FRONTIER (head), not the anchor: with a long committed window the
      // anchor legitimately reaches back across a line boundary, so anchor-based priors lag a line.
      var dx = rr.headIdx - target, sig = dx >= 0 ? o.SIGMA_FWD : o.SIGMA_BACK;
      var prior = Math.exp(-(dx * dx) / (2 * sig * sig));
      var score = rr.dice * (o.PRIOR_FLOOR + (1 - o.PRIOR_FLOOR) * prior);
      if (score > best.score) { second = best; best = { score: score, c: c, dice: rr.dice, headIdx: rr.headIdx, matchLen: rr.matchLen, backRun: rr.backRun }; }
      else if (score > second.score) second = { score: score };
    }

    // 5) monotonic cursor guard
    if (best.matchLen >= o.MIN_MATCH_WORDS && best.dice >= o.TAU_ADVANCE) {
      var hIdx = best.headIdx;
      if (hIdx >= this.cursor) {
        this.ema = this.cursor === 0 ? hIdx : o.EMA_ALPHA * hIdx + (1 - o.EMA_ALPHA) * this.ema;
        this.cursor = Math.max(this.cursor, Math.floor(this.ema)); this.backConfirm = 0;
      } else if (best.dice >= o.STRONG && best.backRun >= o.BACK_RUN && (this.cursor - hIdx) > o.REGRESS_TOK) {
        if (++this.backConfirm >= o.CONFIRM_BACK) { this.cursor = hIdx; this.ema = hIdx; this.backConfirm = 0; }
      } else { this.cursor = Math.max(this.cursor, hIdx); this.backConfirm = 0; }
      this.lowConf = 0;
    } else { this.lowConf++; this.backConfirm = 0; }

    // 6) resync fallback: one forward-only full scan when confidence has been low
    if (this.lowConf >= o.RESYNC_AFTER) {
      var g = { dice: -1 };
      var rfrom = o.RESYNC_GLOBAL ? 0 : Math.max(0, this.lineStart[this.emitted] - 6);   // GLOBAL rescan catches arbitrary jumps
      for (var cc = rfrom; cc < this.A.length; cc++) {
        var rg = this._align(S, sw, totalS, cc);
        if (rg.dice > g.dice) { g = { dice: rg.dice, headIdx: rg.headIdx }; }
      }
      var rmin = (o.RESYNC_MIN != null) ? o.RESYNC_MIN : o.STRONG;
      if (g.dice >= rmin) { this.cursor = g.headIdx; this.ema = g.headIdx; this.lowConf = 0; }
    }

    // 7) line hysteresis (anti-jitter)
    var rawLine = this.A[Math.min(this.cursor, this.A.length - 1)].line;
    if (rawLine === this.emitted) { this.confCnt = 0; }
    else {
      if (rawLine === this.confLine) this.confCnt++; else { this.confLine = rawLine; this.confCnt = 1; }
      var backward = rawLine < this.emitted;
      var need = backward ? o.CONFIRM_BACK : (status === 'final' ? o.CONFIRM_FINAL : o.CONFIRM_PARTIAL);
      if (this.confCnt >= need || (!backward && this._prog() >= o.ENTER_MARGIN)) { this.emitted = rawLine; this.confCnt = 0; }
    }

    // 8) confidence: dice + margin over 2nd + magnitude, EMA-smoothed
    var margin = best.score - Math.max(0, second.score);
    var conf = best.dice * (0.5 + 0.5 / (1 + Math.exp(-o.MARGIN_K * margin))) * Math.min(1, contentN / o.MIN_MATCH_WORDS);
    conf = Math.max(0, Math.min(1, conf));
    this.conf = o.CONF_EMA * conf + (1 - o.CONF_EMA) * this.conf;
    return this._emit(this.conf);
  };

  PhonoDTW.prototype._prog = function () {
    var li = this.A[Math.min(this.cursor, this.A.length - 1)].line;
    return Math.max(0, Math.min(1, (this.cursor - this.lineStart[li]) / this.lineLen[li]));
  };
  PhonoDTW.prototype._emit = function (confidence) {
    return { lineIndex: this.emitted, confidence: confidence, wordProgressInLine: this._prog(), cursor: this.cursor };
  };
  PhonoDTW.prototype.reset = function () {
    this.cursor = 0; this.emitted = 0; this.ema = 0; this.committed = []; this.prevLen = 0;
    this.confLine = -1; this.confCnt = 0; this.backConfirm = 0; this.lowConf = 0; this.conf = 0;
  };

  // ================= SmartScroller (browser) =================
  // 70%->40% dead-band, speed-capped easeInOutCubic, forward-only, retarget-don't-stack.
  function SmartScroller(container, opt) {
    this.c = container;
    this.o = Object.assign({ TRIGGER_P: 0.70, TARGET_P: 0.40, SCROLL_MS: 650, SPEED_CAP: 220, SPEED: 1, MIN_INTERVAL: 350, CONF_MIN: 0.45, USE_VIEWPORT: false, FORWARD_ONLY: true }, opt || {});
    this.animating = false; this.lastAt = 0; this.lastLine = -1; this.anim = null;
    this.userUp = false; this.userUpLine = -1; this.lastSetTop = null;   // manual scroll-up pause state
  }
  SmartScroller.prototype.reset = function () { this.lastLine = -1; this.lastAt = 0; this.anim = null; this.userUp = false; this.lastSetTop = null; };
  SmartScroller.prototype.onUpdate = function (el, confidence, lineIndex) {
    var o = this.o, c = this.c;
    if (!el || confidence < o.CONF_MIN) return;
    // the user scrolled UP (view moved above where we last settled) -> pause auto-scroll and hold it
    // there until reading ADVANCES to a new line (they read on), then resume.
    if (!this.animating && this.lastSetTop != null && c.scrollTop < this.lastSetTop - 60) {
      if (!this.userUp) { this.userUp = true; this.userUpLine = this.lastLine; }
    }
    if (this.userUp) {
      if (lineIndex <= this.userUpLine) return;   // still on the same/earlier line -> respect the scroll-up
      this.userUp = false;                         // advanced to the next sentence -> resume auto-scroll
    }
    if (o.FORWARD_ONLY && lineIndex < this.lastLine) return;        // forward-only (off for free-jump reading)
    var r = el.getBoundingClientRect();
    var vh, centerY;
    if (o.USE_VIEWPORT) { vh = (typeof window !== 'undefined' ? window.innerHeight : c.clientHeight); centerY = r.top + r.height / 2; }
    else { vh = c.clientHeight; centerY = r.top - c.getBoundingClientRect().top + r.height / 2; }
    var p = centerY / vh;
    if (p < o.TRIGGER_P) return;                                    // dead-band [TARGET_P, TRIGGER_P): do nothing
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this.lastAt < o.MIN_INTERVAL) return;
    var to = c.scrollTop + (centerY - o.TARGET_P * vh);
    this.lastLine = lineIndex; this.lastAt = now; this.lastSetTop = to;   // remember where we settled (for scroll-up detection)
    if (this.anim) { this.anim.to = to; this.lastSetTop = to; return; }   // retarget in-flight tween
    var from = c.scrollTop, dist = to - from;
    var dur = Math.max(o.SCROLL_MS, Math.min(1400, Math.abs(dist) / (o.SPEED_CAP / 1000)));
    dur = Math.max(120, dur / (o.SPEED || 1));   // SPEED multiplier: >1 = faster scroll animation (floor so it never snaps instantly)
    var t0 = now, self = this;
    var ease = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
    this.anim = { to: to }; c.__auto = true; this.animating = true;
    var step = function (ts) {
      var nowt = ts || (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var x = Math.min(1, (nowt - t0) / dur);
      c.scrollTop = from + (self.anim.to - from) * ease(x);
      if (x < 1) requestAnimationFrame(step);
      else { self.animating = false; self.anim = null; c.__auto = false; }
    };
    requestAnimationFrame(step);
  };

  var API = { PhonoDTW: PhonoDTW, SmartScroller: SmartScroller, prepare: prepare, tokenize: tokenize, phon: phon, simTok: simTok, DEFAULTS: D };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) { root.MatchEngine = API; root.PhonoDTW = PhonoDTW; root.SmartScroller = SmartScroller; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
