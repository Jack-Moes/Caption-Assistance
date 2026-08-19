# Changelog

## 1.2.0 — 2026.8.19

Three changes aimed at the moment that actually decides the answer: the question
arriving correctly, and being able to speak the reply without reading all of it first.

### Added

- **Technical term repair.** Live captions are accurate on ordinary speech and wrong
  on exactly the words that decide the answer. The bundled prompt already documented
  the damage ("Postgres" -> "post grass", "Kafka" -> "coffca", "S3" -> "S three") and
  asked the model to guess what was meant. The app now repairs it at the source, in
  two conservative passes: a table of spell-outs no phonetic key can recover, and
  phonetic matching against a KNOWN vocabulary only - the terms mined from your CV and
  job description plus a small built-in list. Nothing outside that vocabulary can be
  produced, so a mis-hearing cannot become an arbitrary wrong word. Settings has a
  toggle and lists the most recent corrections.
- **Answer layout for speaking.** The opening sentence is separated and set heavier;
  the closing confirmation question is split onto its own line; A- / A+ set the text
  size. Streaming still grows one text node in place, so the per-chunk cost stays
  proportional to the delta.
- **Answer history.** Completed answers are kept for the session with the question
  that produced them, with back/forward controls and the question shown in the status
  line. A live chunk no longer yanks the view away while you read an earlier answer,
  and the answers are stored with the saved session.

### Fixed

- Phonetic similarity alone could rewrite ordinary speech: "last" and "rust" collapse
  to the same key, and scoring on the better of sound/spelling turned "last year" into
  "Rust year". Both must now agree, and short words go through the alias table only.
- A multi-word correction candidate could swallow a leading article, turning "the
  checkout orchestrater" into "CheckoutOrchestrator" with the "the" consumed.
- Stepping forward through answer history landed on the newest entry and labelled it
  "past", when that entry is the current answer.


## 1.1.0 — 2026.8.19

App version 1.0.2 → 1.1.0. Chrome extension 1.4.0 → 1.6.0.

Everything here stays free and offline: no API key, no subscription, no external
service. Local LLM inference was evaluated and rejected — on this hardware
(i7-4790, Intel HD 4600, no CUDA) a 7B model needs 20-40 seconds per answer, so
the browser tab remains the only workable path to a model and the work went into
hardening it rather than replacing it.

### Added

- **Windows speech microphone engine.** The WinRT reader was only a fallback next
  to Chrome speech; it is now a first-class `windows` engine and the default. No
  Python, no key, no network, and it reaches the mic through the same Windows
  audio stack Core Audio uses — so it works where PyAudio cannot even enumerate
  the capture device.
- **Send the clipboard.** A rebindable hotkey sends whatever is on the clipboard,
  for questions that arrive as text rather than speech.
- **Read the screen (OCR).** `ocr-reader.exe` captures the foreground window and
  recognises it with `Windows.Media.Ocr`. A coding problem lives on the screen and
  never in the audio, so no transcript selection could previously reach it. Built
  with the C# compiler and WinRT metadata that ship with Windows — no SDK, no
  model download.
- **Question detection.** Latest now selects the newest sentence that reads as a
  question instead of whichever sentence was literally last, which in a live
  transcript is usually the interviewer still talking or an acknowledgement.
  Offline pattern scoring; nothing is ever sent without an explicit action.
- **Per-site adapters.** The composer/answer selectors moved out of `content.js`
  into `adapters.js`, keyed by host, with a verified chatgpt.com adapter, a
  generic fallback, and best-effort aistudio.google.com and claude.ai entries.
- **Adapter self-check.** The bound page reports which selectors actually
  resolved; the app shows it in the connection tooltip and warns when a layout is
  unrecognised, so an unverified adapter fails loudly instead of silently.
- **Local document context.** Keep CV, job description and round notes as plain
  `.txt`/`.md` files in `userData/context`. Paragraphs are scored against each
  question by rarity-weighted keyword overlap and only the best few are attached
  (4 chunks / 1800 chars). No embeddings, no vector store — these documents are
  tens of KB.
- **Bridge port fallback.** The app walks 17632-17636 and the extension probes the
  same range, instead of one hard-coded port.
- **Regression suite** (`tools/smoke`): 52 checks driving the real app over
  Electron's remote-debugging port, including a live TTS → Live Captions →
  transcript pass. Previously there were no tests at all.

### Fixed

- **Two Live Captions readers ran at once.** Killing a reader on an engine switch
  let its own exit handler schedule a restart, so two processes fought over one
  Live Captions window and captions were dropped. The tracked-process guard that
  `spawnLocalStt` already used now applies to both readers.
- **Engine switches restarted the caption reader** even though it is engine
  independent, dropping captions for a second or more each time.
- **Local STT never started.** `spawn` was given `cwd: __dirname`, which points
  inside `app.asar` when packaged — a path that does not exist on disk. It failed
  with ENOENT and blamed the executable, which read as a missing Python.
- **Silent engine failures.** The WinRT reader's own error lines were discarded
  because only `partial`/`final` were handled, and the renderer accepted engine
  status only while a `local` engine was selected. A blocked OS speech setting or
  a dead mic engine looked exactly like silence. Both now surface, with an
  actionable message, throttled to one per 15s.
- **Paragraph splitting ignored CRLF**, so any context file written on Windows
  (Notepad included) collapsed into a single chunk and every question received the
  same undifferentiated blob.
- **The asar builder dropped new files.** It repacked only files already present
  in the original header, so a newly added source file was silently missing at
  runtime.
- **"Till the end" had no visible state.** The class toggled but the computed
  style was identical, so there was no way to tell whether the mode was on.
- **A taken bridge port killed the app silently** — it logged one line and stayed
  dead while the extension showed only "not connected".
- **The app refused to start off one LAN.** A `192.168.5.*` gate called
  `process.exit(1)` before `createWindow`, leaving no window and no error. The
  user guide already documented that no such requirement existed.

### Changed

- **Answer latency.** The answer watcher attaches at the send click rather than
  after submit confirmation; observer debounce 60ms → 16ms and stream throttle
  120ms → 40ms; final-phase settle 1900ms → 600ms. First token ~250-400ms →
  ~60-110ms.
- **Streamed answers render incrementally.** Each chunk carries the full answer,
  so assigning `textContent` rebuilt the whole text node ~25 times a second at a
  cost that grew with the answer. The delta is appended instead.
- **Chrome speech restarts on the next tick** instead of after a fixed 150ms,
  which used to swallow the first word of the next sentence. Trade-off: the tab's
  recording indicator blinks more often.
- **Splash hold 5s → 700ms.**
- **Command expiry 5s → 15s**, since a sleeping MV3 service worker can take longer
  than 5s to reconnect.
- **Cloud engines are labelled "API key"** in Settings so the free options are
  distinguishable at a glance.
- **Build outputs are no longer tracked.** `app.asar.new` and `app.asar.pending`
  are ignored; `resources/app.asar` stays tracked because it is the shipped
  runtime and the builder needs it as a header template.

### Known limitations

- The `windows` mic engine requires Settings → Privacy & security → Speech →
  Online speech recognition to be ON. The app now says so explicitly when it is
  blocked.
- The aistudio.google.com and claude.ai adapters are unverified starting points.
  The self-check reports whether they work on the page you actually open.
- Local (Vosk) microphone capture does not work on hardware where PyAudio cannot
  see the capture device; use Windows speech or Chrome speech there.
