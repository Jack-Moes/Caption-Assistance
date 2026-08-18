// question-extract.js -- offline question detection for Caption assistance (runs in the renderer).
// Interview questions are highly formulaic, so a scored pattern pass finds them without an LLM: no API
// key, no network, no model download. Exposes window.CAQuestionDetect.
//
// extract(text) -> { start, end, text, confidence } | null
//   start/end are character offsets into `text`, so the caller can build a DOM Range and select the
//   sentence in place rather than handing back a rewritten string.
(function () {
  'use strict';

  // Highest-signal openers first; the first match wins, so order encodes priority.
  var CUES = [
    { re: /\b(tell me about|walk me through|give me an example|talk me through)\b/i, conf: 0.92 },
    { re: /\b(can|could|would|will)\s+you\s+(explain|describe|tell|walk|share|elaborate)\b/i, conf: 0.9 },
    { re: /^\s*(what|how|why|when|where|which|who|whose|whom)\b/i, conf: 0.82 },
    { re: /^\s*(do|does|did|are|is|was|were|have|has|had|can|could|would|should|will)\b/i, conf: 0.7 },
    { re: /^\s*(explain|describe|discuss|compare|define|walk|tell)\b/i, conf: 0.68 },
    { re: /\b(what|how|why|when|where|which|who)\s+(is|are|do|does|did|was|were|would|could|should|will)\b/i, conf: 0.66 },
    { re: /\b(experience|background|familiar)\s+with\b/i, conf: 0.55 },
    { re: /\b(your (approach|experience|thoughts|opinion)|how do you (handle|approach|deal))\b/i, conf: 0.6 }
  ];

  // Phrases that look like questions but are conversational filler, not something to answer.
  var NOISE = /^\s*(so|ok|okay|right|sure|yeah|yes|no|thanks|thank you|got it|makes sense|sounds good|hello|hi|good morning|good afternoon)\b[\s,.!?]*$/i;

  function sentences(text) {
    var out = [], re = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g, m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      var s = m.index, e = m.index + m[0].length;
      while (s < e && /\s/.test(text.charAt(s))) s++;
      while (e > s && /\s/.test(text.charAt(e - 1))) e--;
      if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) });
    }
    return out;
  }

  function score(sentence) {
    var t = sentence.trim();
    if (t.length < 8 || NOISE.test(t)) return 0;
    var words = t.split(/\s+/).length;
    if (words < 3) return 0;
    var conf = 0;
    for (var i = 0; i < CUES.length; i++) {
      if (CUES[i].re.test(t)) { conf = CUES[i].conf; break; }
    }
    if (/\?\s*$/.test(t)) conf = Math.max(conf, 0.88) + 0.06;   // explicit question mark is the strongest cue
    if (!conf) return 0;
    // Live captions arrive without punctuation, so length is the main sanity check: a 40-word run is
    // usually several merged utterances rather than one question.
    if (words > 45) conf -= 0.2;
    else if (words > 30) conf -= 0.1;
    if (words <= 6) conf -= 0.05;
    return Math.max(0, Math.min(1, conf));
  }

  // Scan the LAST sentences first: in an interview the newest question is the one that matters.
  function extract(text) {
    text = String(text == null ? '' : text);
    if (!text.trim()) return null;
    var list = sentences(text), best = null;
    for (var i = list.length - 1; i >= 0; i--) {
      var conf = score(list[i].text);
      if (!conf) continue;
      // Prefer recency: only an appreciably better earlier sentence displaces a later one.
      if (!best || conf > best.confidence + 0.12) best = { start: list[i].start, end: list[i].end, text: list[i].text, confidence: conf };
    }
    return best;
  }

  window.CAQuestionDetect = { extract: extract, _sentences: sentences, _score: score };
})();
