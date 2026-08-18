"""Caption assistance regression smoke test (drives the real app over CDP)."""
import cdp, io, json, time, urllib.request, subprocess, sys

TOK = 'captionassistance-bridge-7f3a'
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
        'http://127.0.0.1:17632/poll?token=%s&client=smoke' % TOK, timeout=5).read().decode())

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

c = cdp.connect()
J = c.js

print('\n== 1. startup / home ==')
check('home screen visible', J("[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id).join(',')") == 'home')
check('preload API exposed', J("Object.keys(window.cap||{}).length") >= 57)
check('version rendered', 'v1.0.2' in (J("(document.getElementById('homeVer')||{}).textContent") or ''))
check('bridge /ping', urllib.request.urlopen('http://127.0.0.1:17632/ping?token=%s' % TOK, timeout=5).read().decode().find('"ok":true') > 0)

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

def say(t):
    subprocess.run(['powershell', '-NoProfile', '-Command',
        "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.SetOutputToDefaultAudioDevice(); $s.Speak('" + t + "'); $s.Dispose()"],
        capture_output=True, timeout=120)

def spk_text():
    return (J("(typeof speakerParas!=='undefined'?speakerParas:[]).map(p=>p.text).join(' ')") or '')

def heard():
    return 'scaling' in spk_text().lower()

say('Tell me about a scaling problem you solved.')
ok = wait_for(heard, 20, 2)
if not ok:
    say('Tell me about a scaling problem you solved.')   # LC often misses the very first utterance after start
    ok = wait_for(heard, 25, 2)
check('speaker transcript captured', ok, spk_text()[:90])

print('\n== 6. selection + till-end visual state (B2) ==')
J("document.getElementById('latestBtn').click()"); time.sleep(0.5)
sel = J("window.__captionSelText?window.__captionSelText():''") or ''
check('Latest selects a sentence', len(sel.strip()) > 3, sel[:60])
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
check('session saved with transcript', len(sess) == 1 and len(sess[0].get('text','')) > 0, str(sess)[:90])
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
say('How do you handle database migrations? Yeah, okay, sure.')
got_q = wait_for(lambda: 'migration' in (spk_text() or '').lower(), 30, 2)
check('transcript for detection captured', got_q, spk_text()[:90])
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
    req = urllib.request.Request('http://127.0.0.1:17632/from-ext?token=' + TOK,
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

c.close()
bad = [r for r in results if not r[1]]
print('')
print('================ %d/%d PASS, %d skipped ================' % (len(results)-len(bad), len(results), len(skipped)))
for n, why in skipped:
    print('  skipped:', n, '->', why)
for n,_,d in bad: print('  FAILED:', n, '->', d)
sys.exit(1 if bad else 0)
