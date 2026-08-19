"""Caption assistance regression smoke test (drives the real app over CDP)."""
import cdp, io, json, os, time, urllib.request, subprocess, sys

TOK = 'captionassistance-bridge-7f3a'
PORTS = [17632, 17633, 17634, 17635, 17636]

def discover_base():
    # The app falls back through this range when its preferred port is taken, so the suite must not
    # assume 17632 either.
    for p in PORTS:
        try:
            d = json.loads(urllib.request.urlopen('http://127.0.0.1:%d/ping?token=%s' % (p, TOK), timeout=3).read().decode())
            if d.get('app') == 'caption.assistance':
                return 'http://127.0.0.1:%d' % p, d
        except Exception:
            pass
    return None, None

BASE, PING = discover_base()
results = []
skipped = []
def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  -> ' + str(detail)[:120]) if detail else ''))

def skip(name, why):
    skipped.append((name, why))
    print('  SKIP  ' + name + '  -> ' + why)

def poll():
    return json.loads(urllib.request.urlopen(
        BASE + '/poll?token=%s&client=smoke' % TOK, timeout=5).read().decode())

def procs(name):
    out = subprocess.run(['tasklist'], capture_output=True, text=True).stdout.lower()
    return out.count(name.lower())

def stt_procs():
    # Filter on the image name FIRST. Matching only on command line made the query match the
    # PowerShell process running the query itself (its own command line contains the search string).
    out = subprocess.run(['powershell', '-NoProfile', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
        "Where-Object { $_.CommandLine -like '*stt-local*' } | Measure-Object).Count"],
        capture_output=True, text=True, timeout=60).stdout.strip()
    try:
        return int(out.splitlines()[-1])
    except Exception:
        return -1

def reader_procs():
    # Build the match pattern by concatenation. Any literal pattern spelled out here also appears in this
    # query's own command line, so PowerShell matched the querying process and always reported one extra.
    out = subprocess.run(['powershell', '-NoProfile', '-Command',
        "$pat = '*-File*caption-' + 'reader.ps1*';"
        "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
        "Where-Object { $_.CommandLine -like $pat } | Measure-Object).Count"],
        capture_output=True, text=True, timeout=60).stdout.strip()
    try:
        return int(out.splitlines()[-1])
    except Exception:
        return -1

def wait_for(fn, timeout=20, step=1.0):
    # Poll until fn() is truthy. Fixed sleeps made this suite flaky: process teardown
    # and Live Captions warm-up are both several seconds and highly variable.
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False

if not BASE:
    print('no Caption assistance bridge found on ports %s - is the app running?' % PORTS)
    sys.exit(1)
c = cdp.connect()
J = c.js

print('\n== 1. startup / home ==')
check('home screen visible', J("[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id).join(',')") == 'home')
check('preload API exposed', J("Object.keys(window.cap||{}).length") >= 57)
APP_VERSION = J("cap.getVersion().then(v=>v)", timeout=20)
check('version rendered matches the app', ('v' + str(APP_VERSION)) in (J("(document.getElementById('homeVer')||{}).textContent") or ''), APP_VERSION)
check('bridge reachable on a fallback-range port', bool(BASE), BASE)
check('ping reports its own port', PING and PING.get('port') in PORTS, PING)

print('\n== 2. engine list (Phase 3) ==')
opts = J("[...document.querySelectorAll('#micEngineSelect option')].map(o=>o.value).join(',')")
check('windows option first', opts.startswith('windows'), opts)
labels = J("[...document.querySelectorAll('#micEngineSelect option,#speakerEngineSelect option')].filter(o=>/API key/.test(o.textContent)).length")
check('cloud engines marked "API key"', labels == 6, labels)

print('\n== 3. mic engine switching ==')
J("(function(){var s=document.getElementById('micEngineSelect');s.value='windows';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
time.sleep(4)
check('bridge reports windows/app', poll().get('engine') == 'windows' and poll().get('micSource') == 'app')
check('mic-reader.exe running', procs('mic-reader') >= 1)
note = J("(document.getElementById('engineNote')||{}).textContent") or ''
check('engine error surfaced in UI (B1 class)', ('blocked by an OS setting' in note) or ('Windows speech' in note), note[:80])

J("(function(){var s=document.getElementById('micEngineSelect');s.value='local';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
check('local engine stops mic-reader', wait_for(lambda: procs('mic-reader') == 0, 20))
check('local STT process spawned (cwd fix)', wait_for(lambda: stt_procs() >= 1, 20))

J("(function(){var s=document.getElementById('micEngineSelect');s.value='windows';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
check('switch back to windows', wait_for(lambda: procs('mic-reader') >= 1 and stt_procs() == 0, 30))
# Engine switches used to kill the Live Captions reader, whose exit handler then scheduled its own
# restart -- leaving two readers fighting over the same window and dropping captions.
check('exactly one caption reader', wait_for(lambda: reader_procs() == 1, 15), reader_procs())

print('\n== 4. live session ==')
J("document.getElementById('startNew').click()"); time.sleep(0.7)
J("document.getElementById('startSession').click()"); time.sleep(0.8)
check('permission modal', J("!document.getElementById('mPerm').classList.contains('hidden')"))
J("document.getElementById('permOk').click()"); time.sleep(4)
check('live screen', J("[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id).join(',')") == 'live')
check('recording started', J("(typeof caRec!=='undefined'&&caRec&&caRec.mr)?caRec.mr.state:'n/a'") == 'recording')

print("")
print("== 5. speaker caption end-to-end (TTS -> Live Captions -> app) ==")

def lc_ready():
    ts = J("(document.getElementById('ts')||{}).textContent") or ''
    ph = J("(document.getElementById('caption')||{}).textContent") or ''
    return 'setup' not in ts.lower() and 'Preparing speech model' not in ph

check('Live Captions out of setup', wait_for(lc_ready, 60, 2))

KILL_TTS = ("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
            "Where-Object { $_.CommandLine -like '*SpeechSynthesizer*' } | "
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")

def say(t):
    # The synthesizer sometimes wedges holding the audio output device. That is an environment fault, not
    # an app fault, so report it as a skip rather than failing every check that needs audible speech.
    try:
        subprocess.run(['powershell', '-NoProfile', '-Command',
            "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$s.SetOutputToDefaultAudioDevice(); $s.Speak('" + t + "'); $s.Dispose()"],
            capture_output=True, timeout=45)
        return True
    except subprocess.TimeoutExpired:
        print('  note: speech synthesizer timed out, killing it and continuing')
        subprocess.run(['powershell', '-NoProfile', '-Command', KILL_TTS], capture_output=True, timeout=60)
        return False

def spk_text():
    return (J("(typeof speakerParas!=='undefined'?speakerParas:[]).map(p=>p.text).join(' ')") or '')

def heard():
    return 'scaling' in spk_text().lower()

spoke = say('Tell me about a scaling problem you solved.')
ok = wait_for(heard, 20, 2) if spoke else False
if spoke and not ok:
    spoke = say('Tell me about a scaling problem you solved.')   # LC often misses the first utterance after start
    ok = wait_for(heard, 25, 2)
AUDIO_OK = spoke
if not spoke:
    skip('speaker transcript captured', 'speech synthesizer is wedged - no audio could be played')
else:
    check('speaker transcript captured', ok, spk_text()[:90])

print('\n== 6. selection + till-end visual state (B2) ==')
J("document.getElementById('latestBtn').click()"); time.sleep(0.5)
sel = J("window.__captionSelText?window.__captionSelText():''") or ''
if AUDIO_OK:
    check('Latest selects a sentence', len(sel.strip()) > 3, sel[:60])
else:
    skip('Latest selects a sentence', 'no transcript (audio unavailable)')
off1 = J("(function(){var b=document.getElementById('toEndBtn'),s=getComputedStyle(b);return s.backgroundColor+'|'+s.boxShadow})()")
J("document.getElementById('toEndBtn').click()"); time.sleep(0.4)
on = J("(function(){var b=document.getElementById('toEndBtn'),s=getComputedStyle(b);return s.backgroundColor+'|'+s.boxShadow})()")
J("document.getElementById('toEndBtn').click()"); time.sleep(0.3)
check('till-end ON differs from OFF', on != off1, 'off=%s on=%s' % (off1[:32], on[:32]))

print('\n== 7. guards ==')
J("window.getSelection().removeAllRanges()"); time.sleep(0.2)
J("document.getElementById('gptBtn').click()"); time.sleep(0.7)
check('no-selection guard', 'Select a question first' in (J("(document.getElementById('actionNotice')||{}).textContent") or ''))

print('\n== 8. session save / delete ==')
J("document.getElementById('endBtn').click()"); time.sleep(0.9)
J("document.getElementById('sessName').value='SMOKE TEST'")
J("document.getElementById('doneSave').click()"); time.sleep(3.5)
sess = json.loads(J("localStorage.getItem('ce_sessions')||'[]'"))
if AUDIO_OK:
    check('session saved with transcript', len(sess) == 1 and len(sess[0].get('text','')) > 0, str(sess)[:90])
else:
    check('session saved', len(sess) == 1, str(sess)[:90])
J("(document.querySelector('#recentList .del')||document.querySelector('#recentList button')).click()"); time.sleep(0.8)
J("document.getElementById('savedDeleteOk').click()"); time.sleep(1.5)
check('session deleted', json.loads(J("localStorage.getItem('ce_sessions')||'[]'")) == [])

print("")
print("== 9. clipboard action ==")
check('clipboard hotkey row present', bool(J("!!document.getElementById('hkClip')")))
res = J("cap.setHotkeys({clip:{key:'F9'}}).then(r=>JSON.stringify(r.results)+'|'+r.actions.clip.key)", timeout=20)
check('clip hotkey registers', '"clip":true' in res and res.endswith('|F9'), res)
J("cap.setHotkeys({clip:{key:''}})", timeout=20)

J("window.__gptRes=null; window.cap.onGptResult(function(r){window.__gptRes=r;});")
J("cap.copy('')")
time.sleep(0.6)
J("cap.sendAction('clip')")
time.sleep(1.5)
check('empty clipboard guarded', J("(window.__gptRes||{}).code") == 'clipboard-empty', J("(window.__gptRes||{}).error"))

# NEVER exercise a real send while a tab is bound: the command would be delivered to the live
# conversation and actually submit there. Only probe the path when nothing is bound to receive it.
if poll().get('boundClient'):
    code = '__bound__'
else:
    J("cap.copy('What is your experience with Kubernetes?')")
    time.sleep(0.6)
    J("window.__gptRes=null")
    J("cap.sendAction('clip')")
    time.sleep(1.8)
    code = J("(window.__gptRes||{}).code")
# no extension is bound during the suite, so getting as far as the bridge proves the clipboard text
# was read and passed the guard
# Headless/service sessions have no window station, so the OS clipboard is unavailable and the app
# correctly reports it empty. Report that as skipped rather than failed.
if code == '__bound__':
    skip('clipboard text sent to bridge', 'a ChatGPT tab is bound - a real send would post into the live conversation')
elif code == 'clipboard-empty':
    skip('clipboard text sent to bridge', 'no clipboard access in this session (clip.exe: Access is denied)')
else:
    check('clipboard text sent to bridge', code in ('bridge-offline', 'no-bound-tab'), code)

print("")
print("== 10. question detection (offline) ==")
check('extractor loaded', bool(J("!!(window.CAQuestionDetect && window.CAQuestionDetect.extract)")))

CASES = [
    ("So, tell me about a time you scaled a system.", True),
    ("What is your experience with Kubernetes", True),
    ("Can you walk me through your deployment pipeline", True),
    ("How would you handle a cache stampede?", True),
    ("Okay.", False),
    ("Yeah that makes sense.", False),
    ("Thanks.", False),
    ("Good morning", False),
]
bad_cases = []
for text, want in CASES:
    got = J("(function(){var r=window.CAQuestionDetect.extract(" + json.dumps(text) + ");"
            "return r?('Y '+r.confidence.toFixed(2)+' | '+r.text):'N';})()")
    hit = str(got).startswith('Y')
    if hit != want:
        bad_cases.append('%r want=%s got=%s' % (text, want, got))
check('question vs non-question cases (%d)' % len(CASES), not bad_cases, '; '.join(bad_cases))

# picks the newest question when acknowledgements follow it
multi = J("(function(){var r=window.CAQuestionDetect.extract('Right. Got it. Can you describe your testing strategy');"
          "return r?r.text:'N';})()")
check('picks the question, not the filler', 'describe your testing strategy' in str(multi), multi)

# Latest must prefer a detected question over the literal last sentence
J("document.getElementById('startNew').click()")
time.sleep(0.7)
J("document.getElementById('startSession').click()")
time.sleep(0.8)
J("document.getElementById('permOk').click()")
time.sleep(4)
check('Live Captions ready for detection run', wait_for(lc_ready, 60, 2))
if AUDIO_OK:
    say('How do you handle database migrations? Yeah, okay, sure.')
got_q = wait_for(lambda: 'migration' in (spk_text() or '').lower(), 30, 2) if AUDIO_OK else False
if AUDIO_OK:
    check('transcript for detection captured', got_q, spk_text()[:90])
else:
    skip('transcript for detection captured', 'no audio could be played')
if got_q:
    J("document.getElementById('autoQToggle').checked=true; document.getElementById('autoQToggle').dispatchEvent(new Event('change',{bubbles:true}))")
    J("document.getElementById('latestBtn').click()")
    time.sleep(0.6)
    picked = J("window.__captionSelText?window.__captionSelText():''") or ''
    check('Latest selects the question sentence', 'migration' in picked.lower(), picked[:80])
else:
    skip('Latest selects the question sentence', 'no transcript captured to detect from')
J("document.getElementById('endBtn').click()")
time.sleep(0.9)
J("document.getElementById('doneDelete').click()")
time.sleep(2)

print("")
print("== 11. site adapter + self-check ==")

# The adapter module ships in the extension, so exercise its source directly in the app's renderer.
# location.hostname here is a file:// page, which is exactly the GENERIC fallback path that every
# unverified site relies on.
src = io.open('../../extension/adapters.js', encoding='utf-8').read()
J(src)
check('adapters module evaluates', bool(J("!!(window.CAAdapter && window.CAAdapter.selfCheck)")))
check('known hosts registered', J("Object.keys(window.CAAdapter.BY_HOST).join(',')") ==
      'chatgpt.com,chat.openai.com,aistudio.google.com,claude.ai',
      J("Object.keys(window.CAAdapter.BY_HOST).join(',')"))

# GENERIC against a synthetic chat DOM
J("""(function(){
  var d=document.createElement('div'); d.id='ca-fake-chat'; d.style.display='none';
  d.innerHTML='<form><div contenteditable="true"></div>'
    + '<button aria-label="Send message"></button></form>'
    + '<div data-message-author-role="user">hello</div>'
    + '<div data-message-author-role="assistant"><div class="markdown">an answer</div></div>';
  document.body.appendChild(d);
})()""")
g = J("(function(){var a=window.CAAdapter.GENERIC;return JSON.stringify({c:!!a.composer(),s:!!a.sendBtn(),m:a.messages().length,role:a.roleOf(a.messages()[1]),body:a.bodyOf(a.messages()[1]).textContent});})()")
check('generic adapter resolves a chat DOM', '"c":true' in g and '"s":true' in g and '"role":"assistant"' in g and 'an answer' in g, g)
sc = J("(function(){var r=window.CAAdapter.selfCheck();return JSON.stringify(r);})()")
check('selfCheck reports ok on a usable page', '"ok":true' in sc, sc)
J("var n=document.getElementById('ca-fake-chat'); if(n) n.remove();")
sc2 = J("(function(){var r=window.CAAdapter.selfCheck();return JSON.stringify(r);})()")
check('selfCheck reports NOT ok once the page has no composer', '"ok":false' in sc2, sc2)

# app side: a broken adapter must reach the UI rather than fail silently on the next send
def post_ext(payload):
    req = urllib.request.Request(BASE + '/from-ext?token=' + TOK,
                                 data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    urllib.request.urlopen(req, timeout=5).read()

post_ext({'type': 'adapter-check', 'payload': {'adapter': 'chatgpt', 'host': 'chatgpt.com', 'ok': True, 'composer': True, 'sendBtn': True, 'messages': 4}})
time.sleep(1.0)
check('healthy adapter shown in the connection tooltip',
      'chatgpt' in (J("(document.getElementById('gptConn')||{}).title") or ''),
      J("(document.getElementById('gptConn')||{}).title"))

post_ext({'type': 'adapter-check', 'payload': {'adapter': 'aistudio', 'host': 'aistudio.google.com', 'ok': False, 'composer': False, 'sendBtn': False, 'messages': 0}})
time.sleep(1.2)
check('broken adapter raises a visible warning',
      'not recognised' in (J("(document.getElementById('actionNotice')||{}).textContent") or ''),
      J("(document.getElementById('actionNotice')||{}).textContent"))

print("")
print("== 12. screen OCR ==")
check('OCR hotkey row present', bool(J("!!document.getElementById('hkOcr')")))
res = J("cap.setHotkeys({ocr:{key:'F10'}}).then(r=>JSON.stringify(r.results)+'|'+r.actions.ocr.key)", timeout=20)
check('ocr hotkey registers', '"ocr":true' in res and res.endswith('|F10'), res)
J("cap.setHotkeys({ocr:{key:''}})", timeout=20)

# Exercise the shipped binary itself: render known text, OCR it, compare. This is the whole value of the
# feature -- reading a coding problem off the screen that no transcript can ever contain.
ocr_exe = os.path.abspath(os.path.join('..', '..', 'Caption assistance-1.0.2-local', 'resources', 'ocr-reader.exe'))
check('ocr-reader.exe shipped', os.path.exists(ocr_exe), ocr_exe)
png = os.path.join(os.environ.get('TEMP', '.'), 'ca-smoke-ocr.png')
subprocess.run(['powershell', '-NoProfile', '-Command',
    "Add-Type -AssemblyName System.Drawing;"
    "$b=New-Object System.Drawing.Bitmap 900,120;$g=[System.Drawing.Graphics]::FromImage($b);"
    "$g.Clear([System.Drawing.Color]::White);$g.TextRenderingHint='AntiAliasGridFit';"
    "$f=New-Object System.Drawing.Font('Segoe UI',22);"
    "$g.DrawString('Reverse a linked list in place.',$f,[System.Drawing.Brushes]::Black,20,30);"
    "$g.Dispose();$b.Save($env:CA_OCR_PNG);$b.Dispose()"],
    capture_output=True, timeout=90, env=dict(os.environ, CA_OCR_PNG=png))
r = subprocess.run([ocr_exe, '--file', png], capture_output=True, text=True, timeout=90)
line = (r.stdout or '').strip().splitlines()[-1] if (r.stdout or '').strip() else ''
try:
    parsed = json.loads(line)
except Exception:
    parsed = {}
check('OCR reads rendered text', parsed.get('ok') and 'linked list' in parsed.get('text', '').lower(), line[:110])
try:
    os.remove(png)
except Exception:
    pass

if poll().get('boundClient'):
    skip('OCR send path', 'a ChatGPT tab is bound - a real send would post into the live conversation')
else:
    J("window.__gptRes=null; window.cap.onGptResult(function(r){window.__gptRes=r;});")
    J("cap.sendAction('ocr')")
    time.sleep(4)
    code = J("(window.__gptRes||{}).code")
    check('OCR send path reaches the bridge or reports why', code in ('bridge-offline', 'no-bound-tab', 'ocr-failed', 'ocr-self'), code)

print("")
print("== 13. local context (CV / JD) ==")
ctx = json.loads(J("cap.getContext().then(c=>JSON.stringify(c))", timeout=20))
check('context folder reported', bool(ctx.get('dir')), ctx.get('dir'))
ctx_dir = ctx['dir']
os.makedirs(ctx_dir, exist_ok=True)
probe = os.path.join(ctx_dir, '_smoke_probe.txt')
existing = [f for f in os.listdir(ctx_dir) if f.lower().endswith(('.txt', '.md'))]
NL2 = chr(10) + chr(10)
PROBE_TEXT = NL2.join([
    'I ran the Kubernetes migration for our checkout service, moving twelve deployments off bare EC2 '
    'and onto EKS with Helm charts and a blue-green rollout.',
    'Outside work I play bass guitar and mostly listen to film scores, Hans Zimmer especially, and I '
    'spend weekends on small side projects.',
    'I rewrote our Postgres access layer to use connection pooling, which cut p99 latency on the '
    'orders endpoint from 900ms to 120ms under load.',
]) + chr(10)
io.open(probe, 'w', encoding='utf-8').write(PROBE_TEXT)
time.sleep(0.4)

after = json.loads(J("cap.getContext().then(c=>JSON.stringify(c))", timeout=20))
check('probe file picked up', after.get('chunks', 0) >= len(existing) + 3, after.get('chunks'))

def top_file_text(q):
    r = json.loads(J("cap.previewContext(" + json.dumps(q) + ").then(x=>JSON.stringify(x))", timeout=20))
    return (r['chunks'][0]['text'] if r.get('chunks') else ''), r

t1, r1 = top_file_text('How would you deploy this service on Kubernetes?')
check('question about Kubernetes selects the Kubernetes paragraph', 'Kubernetes' in t1 or 'Helm' in t1, t1[:80])

t2, r2 = top_file_text('What do you do outside of work for fun?')
check('a hobby question does not pull the Kubernetes paragraph', 'Kubernetes' not in t2, t2[:80])

t3, r3 = top_file_text('Tell me about a database latency problem you fixed.')
check('a latency question selects the Postgres paragraph', 'Postgres' in t3 or 'latency' in t3, t3[:80])

check('context stays within its char budget', r1.get('chars', 0) <= 1800, r1.get('chars'))

en = J("cap.setContextEnabled(false).then(v=>String(v))", timeout=20)
check('context can be turned off', en == 'false', en)
J("cap.setContextEnabled(true)", timeout=20)

os.remove(probe)
time.sleep(0.3)
gone = json.loads(J("cap.previewContext('Kubernetes deployment').then(x=>JSON.stringify(x))", timeout=20))
check('removing the file removes its context', all('Kubernetes migration' not in ch['text'] for ch in gone.get('chunks', [])), gone.get('chars'))

print("")
print("== 14. technical term repair ==")
check('term module loaded', bool(J("!!(window.CATermCorrect && window.CATermCorrect.fix)")))

def fixed(t):
    return J("(function(){return window.CATermCorrect.fix(" + json.dumps(t) + ").text;})()")

# the failures the bundled prompt itself documents
POSITIVE = [
    ('we run everything on post grass', 'Postgres'),
    ('the events go through coffca', 'Kafka'),
    ('we store them in s three', 'S3'),
    ('we use oh auth for login', 'OAuth'),
    ('the services talk over gee are pee see', 'gRPC'),
    ('we deployed it on cube netties', 'Kubernetes'),
    ('the pipeline is sci dee', 'CI/CD'),
    ('written in type script', 'TypeScript'),
]
missed = []
for text, want in POSITIVE:
    got = fixed(text)
    if want not in str(got):
        missed.append('%r -> %r (wanted %s)' % (text, got, want))
check('mangled terms repaired (%d cases)' % len(POSITIVE), not missed, '; '.join(missed))

# casing only
check('known term gets canonical casing', 'Kubernetes' in str(fixed('we moved to kubernetes last year')),
      fixed('we moved to kubernetes last year'))

# NEGATIVE: ordinary speech must survive untouched. A wrong "fix" is worse than no fix.
NEGATIVE = [
    'we had a whole rack of servers in that room',
    'there are some known issues with the old build',
    'i can tell you about the team i worked with',
    'the coffee machine was the real bottleneck',
    'she asked me to describe my approach in detail',
    'we shipped it last year and it still runs',
    'that was the first time we tried that',
    'it is a best practice on most teams',
    'the cost was lower than we expected',
]
broken = []
for text in NEGATIVE:
    got = str(fixed(text))
    if got != text:
        broken.append('%r -> %r' % (text, got))
check('ordinary speech left alone (%d cases)' % len(NEGATIVE), not broken, '; '.join(broken))

# vocabulary really does come from the user's documents
ctx_dir2 = json.loads(J("cap.getContext().then(c=>JSON.stringify(c))", timeout=20))['dir']
os.makedirs(ctx_dir2, exist_ok=True)
probe2 = os.path.join(ctx_dir2, '_smoke_terms.txt')
io.open(probe2, 'w', encoding='utf-8').write(
    'I maintained the CheckoutOrchestrator service and the PaymentsAPI gateway, '
    'both deployed on EKS with Helm.' + chr(10))
vocab = json.loads(J("cap.getTermVocab().then(v=>JSON.stringify(v))", timeout=20))
check('vocabulary mined from documents', 'CheckoutOrchestrator' in vocab and 'PaymentsAPI' in vocab,
      ', '.join(vocab[:6]))
n = J("(function(){return window.CATermCorrect.setVocabulary(" + json.dumps(vocab) + ");})()")
check('vocabulary loaded into the corrector', isinstance(n, (int, float)) and n > 50, n)
got_doc = str(fixed('the checkout orchestrater kept timing out'))
check('a document term is repaired too', 'CheckoutOrchestrator' in got_doc, got_doc)
check('the leading article is not swallowed', got_doc.startswith('the '), got_doc)
os.remove(probe2)

# the UI can show its work
rec = json.loads(J("JSON.stringify(window.CATermCorrect.recent(3))"))
check('recent fixes are recorded for the UI', len(rec) > 0 and 'to' in (rec[0] if rec else {}), rec[:2])

print("")
print("== 15. answer layout ==")
check('answer renderer present', bool(J("typeof renderAnswer === 'function' && typeof resetAnswerLayout === 'function'")))

def render(text, final=False):
    J("renderAnswer(" + json.dumps(text) + ", " + ("true" if final else "false") + ")")

def parts():
    return json.loads(J("""(function(){var o=document.getElementById('gptAnswerText');
      var l=o.querySelector('.ans-lead'), b=o.querySelector('.ans-body'), t=o.querySelector('.ans-tail');
      return JSON.stringify({lead:l?l.textContent:null, body:b?b.textContent:null,
        tail:t?t.textContent:null, tailShown:t?!t.classList.contains('hidden'):null});})()"""))

# while the first sentence is still arriving there is nothing to set apart yet
J("resetAnswerLayout()")
render('So, yeah, I think the key thing')
p1 = parts()
check('partial first sentence stays in the lead', p1['lead'] == 'So, yeah, I think the key thing' and not p1['body'], p1)

# once it closes, the opening sentence separates from the rest
render('So, yeah, I think the key thing is idempotency. We made every consumer safe to retry.')
p2 = parts()
check('lead is the opening sentence', p2['lead'] == 'So, yeah, I think the key thing is idempotency.', p2['lead'])
check('remainder goes to the body', 'every consumer safe to retry' in (p2['body'] or ''), p2['body'])

# streaming must keep appending to the same text node rather than rebuilding it
node_id = J("(function(){var b=document.querySelector('#gptAnswerText .ans-body');window.__n=b.firstChild;return b.firstChild?b.firstChild.data.length:-1;})()")
render('So, yeah, I think the key thing is idempotency. We made every consumer safe to retry. That removed the duplicate charges.')
same = J("(function(){var b=document.querySelector('#gptAnswerText .ans-body');return b.firstChild===window.__n;})()")
grew = J("(function(){var b=document.querySelector('#gptAnswerText .ans-body');return b.firstChild?b.firstChild.data.length:-1;})()")
check('body grows in place while streaming', same is True and grew > node_id, 'sameNode=%s len %s->%s' % (same, node_id, grew))

# the closing confirmation question is split out on the final chunk
NL = chr(10)
final_text = ('So, yeah, the key thing is idempotency. We made every consumer safe to retry, which removed '
              'the duplicate charges.' + NL + NL + 'I guess your team must already have a policy on where '
              'retries are allowed to happen?')
J("resetAnswerLayout()")
render(final_text, True)
p3 = parts()
check('closing question split into its own block', p3['tailShown'] is True and p3['tail'].endswith('?'), p3['tail'])
check('closing question removed from the body', 'already have a policy' not in (p3['body'] or ''), p3['body'])

# an answer with no closing question must not lose its last line
J("resetAnswerLayout()")
render('First sentence here. Second sentence with no question at the end.', True)
p4 = parts()
check('no false split when there is no closing question', p4['tailShown'] is False and 'Second sentence' in (p4['body'] or ''), p4)

# font control
before = J("(function(){return parseInt(getComputedStyle(document.getElementById('gptAnswerText')).fontSize,10);})()")
J("document.getElementById('ansFontUp').click()")
time.sleep(0.3)
after = J("(function(){return parseInt(getComputedStyle(document.getElementById('gptAnswerText')).fontSize,10);})()")
check('A+ enlarges the answer text', after == before + 1, '%s -> %s' % (before, after))
J("document.getElementById('ansFontDown').click()")
time.sleep(0.3)
check('size is persisted', J("localStorage.getItem('ca_ans_font')") == str(before), J("localStorage.getItem('ca_ans_font')"))

J("resetAnswerLayout()")

print("")
print("== 16. answer history ==")
check('history helpers present', bool(J("typeof pushAnswerHistory === 'function' && typeof showAnswerAt === 'function'")))
J("resetAnswerHistory()")

def hist():
    return json.loads(J("JSON.stringify({n:answerHistory.length, idx:answerViewIdx, label:(document.getElementById('ansHistLabel')||{}).textContent, navHidden:(document.getElementById('ansHistNav')||{}).className})"))

J("pushAnswerHistory('How do you handle retries?', 'We make every consumer idempotent. That is the whole trick.')")
h1 = hist()
check('first answer stored', h1['n'] == 1 and h1['idx'] == -1, h1)

J("pushAnswerHistory('And rollback?', 'We keep the previous release warm and flip traffic back. It takes about a minute.')")
h2 = hist()
check('second answer stored', h2['n'] == 2, h2)
check('nav becomes visible with two answers', 'hidden' not in (h2['navHidden'] or ''), h2['navHidden'])
check('label shows the live position', h2['label'].startswith('2 / 2'), h2['label'])

# a recovery re-delivering the identical answer must not create a duplicate entry
J("pushAnswerHistory('And rollback?', 'We keep the previous release warm and flip traffic back. It takes about a minute.')")
check('identical re-delivery is not duplicated', hist()['n'] == 2, hist())

# step back to the earlier answer
J("document.getElementById('ansPrev').click()")
time.sleep(0.3)
h3 = hist()
body_now = J("(function(){var b=document.querySelector('#gptAnswerText .ans-body');var l=document.querySelector('#gptAnswerText .ans-lead');return (l?l.textContent:'')+' | '+(b?b.textContent:'');})()")
check('prev shows the earlier answer', h3['idx'] == 0 and 'idempotent' in str(body_now), body_now[:80])
check('label marks it as past', 'past' in (h3['label'] or ''), h3['label'])
check('status names the earlier question', 'retries' in str(J("(document.getElementById('gptAnswerStatus')||{}).textContent")),
      J("(document.getElementById('gptAnswerStatus')||{}).textContent"))

# a streaming chunk must not yank the view away while reading history
J("answerRequestId='probe-req'")
J("receiveGptAnswer({requestId:'probe-req', phase:'stream', text:'a brand new answer arriving', seq:999999})")
time.sleep(0.3)
still = J("(function(){var b=document.querySelector('#gptAnswerText .ans-body');var l=document.querySelector('#gptAnswerText .ans-lead');return (l?l.textContent:'')+' | '+(b?b.textContent:'');})()")
check('live streaming does not interrupt reading history', 'idempotent' in str(still), still[:80])

# forward returns to live
J("document.getElementById('ansNext').click()")
time.sleep(0.3)
check('next returns to the live answer', hist()['idx'] == -1, hist())

# saved sessions carry the answers
saved = json.loads(J("JSON.stringify(buildSessionObj(1,'probe','00:10').answers||[])"))
check('answers are saved with the session', len(saved) == 2 and saved[0]['q'].startswith('How do you handle'), saved[:1])

J("resetAnswerHistory(); resetAnswerLayout()")

print("")
print("== 17. blocked engine is visible outside Settings ==")
check('speech settings shortcut exists', bool(J("!!document.getElementById('speechSettingsBtn')")))
check('shortcut is hidden while nothing is wrong',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display") == 'none',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display"))
check('the settings shortcut is wired to main', J("typeof cap.openSpeechSettings === 'function'"))

# exercise the failure paths directly: a machine where speech works cannot produce the blocked state
J("(function(){var n=document.getElementById('actionNotice'); if(n){n.textContent='';n.className='action-notice hidden';}})()")
J("micEngine='windows'")
J("""onEngineStatusUpdate({src:'mic', engine:'windows', state:'error',
  detail:'Windows speech is blocked by an OS setting - open Settings > Privacy & security > Speech and turn ON "Online speech recognition", then pick the engine again.'})""")
time.sleep(0.4)
notice = J("(document.getElementById('actionNotice')||{}).textContent")
check('a blocked engine raises a toast without opening Settings',
      'hidden' not in (J("(document.getElementById('actionNotice')||{}).className") or 'hidden'), notice[:80])
check('the toast carries the real reason', 'Online speech recognition' in str(notice), str(notice)[:90])
check('the settings shortcut appears',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display") == 'block',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display"))

# an unrelated failure still warns, but must not offer the speech-settings shortcut
J("onEngineStatusUpdate({src:'mic', engine:'windows', state:'error', detail:'local transcription could not start (spawn failed)'})")
time.sleep(0.4)
check('an unrelated failure still warns', 'could not start' in str(J("(document.getElementById('actionNotice')||{}).textContent")),
      J("(document.getElementById('actionNotice')||{}).textContent"))
check('shortcut hidden for an unrelated failure',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display") == 'none',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display"))

# recovery clears the shortcut again
J("onEngineStatusUpdate({src:'mic', engine:'windows', state:'live'})")
time.sleep(0.3)
check('recovery hides the shortcut',
      J("getComputedStyle(document.getElementById('speechSettingsBtn')).display") == 'none' and
      'live' in (J("(document.getElementById('engineNote')||{}).textContent") or ''),
      J("(document.getElementById('engineNote')||{}).textContent"))

print("")
print("== 18. the chosen mic is the one that gets transcribed ==")
# The WinRT reader and Chrome capture the WINDOWS DEFAULT device, not the app's selection, so choosing a
# mic has to move that default. It did not, and the meter followed your choice while the recognizer sat
# on a different, silent device - sound arriving, nothing ever transcribed.
mics = json.loads(J("cap.micList().then(a=>JSON.stringify(a))", timeout=30))
check('more than one capture device to test with', len(mics) >= 2, [m['name'] for m in mics])
if len(mics) >= 2:
    original = next((m for m in mics if m['isDefault']), mics[0])
    other = next(m for m in mics if m['name'] != original['name'])

    def select(name):
        J("(function(){var s=document.getElementById('micSelect0')||document.getElementById('micSelect');"
          "s.value=" + json.dumps(name) + ";s.dispatchEvent(new Event('change',{bubbles:true}));})()")

    def is_default(name):
        cur = json.loads(J("cap.micList().then(a=>JSON.stringify(a))", timeout=30))
        return any(m['name'] == name and m['isDefault'] for m in cur)

    select(other['name'])
    moved = wait_for(lambda: is_default(other['name']), 25, 2)
    check('choosing a mic moves the Windows default to it', moved, other['name'])

    select(original['name'])
    restored = wait_for(lambda: is_default(original['name']), 25, 2)
    check('the original default is restored', restored, original['name'])
else:
    skip('choosing a mic moves the Windows default to it', 'only one capture device on this machine')

c.close()
bad = [r for r in results if not r[1]]
print('')
print('================ %d/%d PASS, %d skipped ================' % (len(results)-len(bad), len(results), len(skipped)))
for n, why in skipped:
    print('  skipped:', n, '->', why)
for n,_,d in bad: print('  FAILED:', n, '->', d)
sys.exit(1 if bad else 0)
