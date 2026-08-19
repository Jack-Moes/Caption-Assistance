// term-correct.js -- repair the technical terms live captions mangle, before the question is sent.
//
// Windows Live Captions is accurate on ordinary speech and wrong on exactly the words that decide the
// answer: frameworks, databases, cloud services, acronyms. The bundled prompt documents the failures it
// produces ("Postgres" -> "post grass", "Kafka" -> "coffca", "S3" -> "S three") and asks the model to
// silently guess what was meant. Guessing is unreliable, costs a round of reasoning, and leaves the user
// staring at a transcript that still reads "post grass".
//
// This fixes it at the source instead, using two conservative passes:
//   1. ALIASES  - explicit spell-outs, the cases phonetics cannot recover
//   2. phonetic - fuzzy match against a KNOWN vocabulary only (your CV, the job description, plus a
//                 small built-in list). Nothing outside that vocabulary can ever be produced, so a
//                 mis-hearing can never turn into an arbitrary wrong word.
//
// The phonetic key mirrors match-engine.js, which already collapses ASR-confusable sounds for read-along.
(function () {
  'use strict';

  function norm(w) {
    return String(w).toLowerCase().replace(/[^a-z0-9'+#.]/g, '');
  }

  // Metaphone-ish consonant-class key: same approach as match-engine.js phon().
  function phon(w) {
    w = String(w).toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return '';
    w = w.replace(/^(kn|gn|wr)/, function (c) { return c[1]; }).replace(/^x/, 's').replace(/mb$/, 'm')
      .replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k')
      .replace(/sh|ch/g, 'X').replace(/th/g, '0').replace(/wh/g, 'w');
    var CL = { b: 'P', p: 'P', v: 'F', f: 'F', d: 'T', t: 'T', g: 'K', k: 'K', q: 'K', c: 'K',
               z: 'S', s: 'S', x: 'S', m: 'N', n: 'N', l: 'R', r: 'R', j: 'J', w: 'W', y: 'Y', h: 'H', '0': '0', X: 'X' };
    var out = '', first = true;
    for (var i = 0; i < w.length; i++) {
      var ch = w[i];
      if ('aeiou'.indexOf(ch) >= 0) { if (first) out += 'A'; continue; }
      var c = CL[ch] || ch;
      if (out[out.length - 1] !== c) out += c;
      first = false;
    }
    return out;
  }

  function lev(a, b, cap) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    var prev = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      var cur = [i], best = i;
      for (j = 1; j <= lb; j++) {
        var c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur[j] = c; if (c < best) best = c;
      }
      if (best > cap) return cap + 1;
      prev = cur;
    }
    return prev[lb];
  }

  // Spell-outs and syllable splits that no phonetic key recovers, taken from the failures the bundled
  // interview prompt already lists.
  var ALIASES = [
    ['post grass', 'Postgres'], ['post gres', 'Postgres'], ['postgres', 'Postgres'],
    ['my sequel', 'MySQL'], ['no sequel', 'NoSQL'], ['sequel', 'SQL'],
    ['cube netties', 'Kubernetes'], ['cuber netties', 'Kubernetes'], ['coober netties', 'Kubernetes'],
    ['coffca', 'Kafka'], ['coffee ka', 'Kafka'], ['cough ka', 'Kafka'],
    ['gee are pee see', 'gRPC'], ['g r p c', 'gRPC'],
    ['s three', 'S3'], ['ec two', 'EC2'], ['e c two', 'EC2'],
    ['sci dee', 'CI/CD'], ['see eye see dee', 'CI/CD'], ['ci cd', 'CI/CD'],
    ['oh auth', 'OAuth'], ['o auth', 'OAuth'],
    ['java script', 'JavaScript'], ['type script', 'TypeScript'],
    ['node jay ess', 'Node.js'], ['next jay ess', 'Next.js'], ['react jay ess', 'React'],
    ['get hub', 'GitHub'], ['git hub', 'GitHub'],
    ['red is', 'Redis'], ['dot net', '.NET'], ['rest api', 'REST API'],
    ['graph que el', 'GraphQL'], ['graph ql', 'GraphQL']
  ];

  // A small floor so the feature works before any document is added. The user's own CV and job
  // description are layered on top of this by setVocabulary().
  var BUILTIN = ('Kubernetes Docker Postgres PostgreSQL MySQL Redis MongoDB Kafka RabbitMQ Nginx Terraform '
    + 'Ansible Jenkins GitHub GitLab Prometheus Grafana Elasticsearch Cassandra DynamoDB Lambda '
    + 'JavaScript TypeScript Python Java Kotlin Swift Golang Rust React Angular Vue Svelte Node.js '
    + 'Express Django Flask FastAPI Spring Hibernate GraphQL REST gRPC WebSocket OAuth JWT '
    + 'Webpack Vite Babel ESLint Jest Cypress Playwright Selenium '
    + 'AWS Azure GCP EKS ECS S3 EC2 RDS CloudFront Kinesis Airflow Spark Hadoop Snowflake').split(' ');

  var VOCAB = [];       // [{ term, key, low }]
  var ALIAS_MAP = {};   // normalized spoken phrase -> canonical
  var RECENT = [];      // [{ from, to }] most recent first
  // A multi-word candidate must not start with a function word: 'the checkout orchestrater' scored well
  // enough against 'CheckoutOrchestrator' that the article was swallowed along with it.
  var LEAD_STOP = new Set(('the a an and or of to in on at is was were be been it its this that these those '
    + 'we our you your i my me he she they them their for with from by as so but if then than').split(' '));
  var MAX_NGRAM = 4;
  var TAU = 0.86;       // phonetic threshold; deliberately strict - a wrong "fix" is worse than none
  var RAW_MIN = 0.62;   // the spelling must ALSO be close. Phonetics alone is not enough: "last" and
                        // "rust" collapse to the same key RST, and taking the better of the two scores
                        // happily rewrote "last year" as "Rust year".
  var MIN_PHON_LEN = 5; // short words are too easy to match by sound; those go through ALIASES instead

  function setVocabulary(terms) {
    var seen = Object.create(null);
    VOCAB = [];
    BUILTIN.concat(terms || []).forEach(function (t) {
      t = String(t || '').trim();
      if (t.length < 2 || t.length > 32) return;
      var low = t.toLowerCase();
      if (seen[low]) return;
      seen[low] = 1;
      VOCAB.push({ term: t, key: phon(t), low: low });
    });
    ALIAS_MAP = Object.create(null);
    ALIASES.forEach(function (p) { ALIAS_MAP[p[0]] = p[1]; });
    return VOCAB.length;
  }

  function bestMatch(phrase) {
    var low = phrase.toLowerCase();
    if (ALIAS_MAP[low]) return { term: ALIAS_MAP[low], score: 1 };
    var flat = norm(phrase.split(/\s+/).join(''));
    if (!flat) return null;
    var key = phon(flat), best = null;
    for (var i = 0; i < VOCAB.length; i++) {
      var v = VOCAB[i];
      if (v.low === low) return { term: v.term, score: 1 };            // right word, maybe wrong case
      if (!key || !v.key) continue;
      if (flat.length < MIN_PHON_LEN) continue;
      if (Math.abs(key.length - v.key.length) > 2) continue;
      var cap = Math.max(1, Math.floor(Math.max(key.length, v.key.length) * 0.34));
      var d = lev(key, v.key, cap);
      if (d > cap) continue;
      var sPhon = 1 - d / Math.max(key.length, v.key.length);
      if (sPhon < TAU) continue;
      var vflat = v.low.replace(/[^a-z0-9]/g, '');
      var capR = Math.max(2, Math.ceil(Math.max(flat.length, vflat.length) * 0.4));
      var dr = lev(flat, vflat, capR);
      var sRaw = dr > capR ? 0 : 1 - dr / Math.max(flat.length, vflat.length);
      if (sRaw < RAW_MIN) continue;                       // sounds right but is spelled nothing like it
      var score = (sPhon + sRaw) / 2;
      if (!best || score > best.score) best = { term: v.term, score: score };
    }
    return best;
  }

  // Returns the repaired text plus what changed, so the UI can show its work.
  function fix(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim() || (!VOCAB.length && !Object.keys(ALIAS_MAP).length)) return { text: src, changes: [] };
    var re = /[A-Za-z0-9'+#.]+/g, toks = [], m;
    while ((m = re.exec(src)) !== null) toks.push({ w: m[0], s: m.index, e: m.index + m[0].length });
    if (!toks.length) return { text: src, changes: [] };

    var changes = [], out = '', cursor = 0, i = 0;
    while (i < toks.length) {
      var hit = null, span = 0;
      for (var n = Math.min(MAX_NGRAM, toks.length - i); n >= 1; n--) {
        if (n > 1 && LEAD_STOP.has(toks[i].w.toLowerCase())) continue;  // never absorb a leading article
        var phrase = toks.slice(i, i + n).map(function (t) { return t.w; }).join(' ');
        if (n === 1 && phrase.length < 3) continue;                    // too short to judge
        var b = bestMatch(phrase);
        if (b && b.term !== phrase) { hit = b; span = n; break; }      // includes fixing the casing
        if (b) { hit = null; span = n; break; }                        // already exactly right
      }
      if (hit) {
        var from = src.slice(toks[i].s, toks[i + span - 1].e);
        out += src.slice(cursor, toks[i].s) + hit.term;
        cursor = toks[i + span - 1].e;
        changes.push({ from: from, to: hit.term });
      }
      i += Math.max(1, span || 1);
    }
    out += src.slice(cursor);
    if (changes.length) {
      RECENT = changes.concat(RECENT).slice(0, 20);
    }
    return { text: out, changes: changes };
  }

  window.CATermCorrect = {
    setVocabulary: setVocabulary,
    fix: fix,
    recent: function (n) { return RECENT.slice(0, n || 5); },
    clearRecent: function () { RECENT = []; },
    vocabularySize: function () { return VOCAB.length; },
    _phon: phon
  };
  setVocabulary([]);
})();
