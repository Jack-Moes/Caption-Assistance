# Caption assistance — Easy User Guide (English)

Version 1.2.1 · Haru Mikage · Japan · 2026.8.19

## 1. What is this program?

Caption assistance is a Windows interview-support application. It collects live speech as text, lets you select an interview question, and can send that text to a ChatGPT tab through the included Chrome extension.

It can also save the transcript and a mixed recording of the speaker and microphone for later review.

The basic flow is:

1. Speech becomes a transcript.
2. Select the interviewer's question.
3. Press **Send**, **aa**, **ss**, or a mode-specific button.
4. ChatGPT creates an answer.
5. Read the answer in ChatGPT, or turn on **Answer in app** to see it beside the transcript.

This program does not answer an interview by itself. ChatGPT access, a signed-in ChatGPT page, and the Chrome extension are required for the ChatGPT features.

> Before recording other people, get their permission and follow the laws and rules that apply to your interview or meeting.

## 2. Start the app

### Normal start

1. Double-click `Run-Caption assistance-Local.cmd`.
2. Wait for the 5-second startup video.
3. If Windows asks for microphone or screen/audio-capture permission, allow it.
4. On the Home screen, click **Start a new session**.

Use `Run-Caption assistance-Safe.cmd` only for privacy recovery. Safe start disables the privacy controls for that run and forces the window to be visible.

### What the two start files mean

| File | Use it when |
|---|---|
| `Run-Caption assistance-Local.cmd` | Normal everyday use |
| `Run-Caption assistance-Safe.cmd` | The window became difficult to control because Privacy click-through was enabled |

Do not delete the `Caption assistance-1.0.2-local` folder. It contains the running application.

## 3. Install the Chrome extension

The extension is optional for transcription, recording, and saved sessions. It is required for automatic ChatGPT input, sending, in-app answers, and GPT read-along scrolling.

1. Open Chrome and enter `chrome://extensions` in the address bar.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder in this project folder.
5. Open or reload `https://chatgpt.com/` and sign in.
6. On the ChatGPT page, click the floating **chain** button once to bind that exact tab.

After updating the extension files, click **Reload** on the extension card and press **F5** on any ChatGPT page that was already open.

### Floating buttons on the ChatGPT page

The extension adds three small floating buttons to ChatGPT:

| Button | Feature |
|---|---|
| Chain | Bind or unbind this exact ChatGPT tab |
| Read-along/scroll | Turn GPT auto scroll on or off; it reflects the same state as the yellow app button |
| Copy | Copy the last ChatGPT answer |

If these buttons are missing after an extension update, reload the extension and press F5 on ChatGPT.

### Connection messages

| Message | Meaning | What to do |
|---|---|---|
| **linked** | The extension is connected and a ChatGPT tab is bound | Ready to use |
| **bind a tab** | The extension is connected, but no exact ChatGPT tab is selected | Click the chain button in the ChatGPT tab |
| **no bridge** | The app and extension are not connected | Start the app, reload the extension, then refresh ChatGPT |

The app and extension communicate locally on `127.0.0.1`, using the first free port in the range `17632-17636`. If something else already holds a port the app moves to the next one and the extension follows it, so a port clash no longer breaks the connection. The app runs on any network, and no external deployment server is needed.

## 4. Recommended first-time workflow

1. Start the app with the Local launcher.
2. Install and bind the Chrome extension.
3. Open **Default prompts** from the speech-bubble icon in the left sidebar.
4. Copy the prompt for your interview mode into a fresh ChatGPT conversation.
5. Add your job description, résumé, and any useful interview notes to that conversation.
6. Return to the app, start a new session, and choose the correct microphone and mode.
7. When a question appears, select it and use one of the send buttons.

Preparing the ChatGPT conversation before the interview usually produces more relevant answers than sending an isolated question.

## 5. Home screen

- **Home icon:** returns to the Home screen.
- **Plus icon:** opens New Session.
- **Speech-bubble icon:** opens Default prompts.
- **Start a new session:** opens the interview-mode screen.
- **Most recent sessions:** shows locally saved sessions. Click one to review it.
- **Trash button on a saved session:** permanently deletes its transcript and recording from this PC after confirmation.

Saved-session deletion cannot be undone.

## 6. Choose an interview mode

### Standard

For normal interview questions such as experience, behavior, projects, strengths, and technical Q&A. It shows the normal `aa`, `ss`, and `zz` actions.

### Live Coding

For algorithms and coding problems. It adds these buttons:

| Button | Purpose | Fixed key in Live Coding |
|---|---|---|
| **plan** | Explain the problem and make a solution plan | F1 |
| **code** | Write the solution code | F2 |
| **improve** | Improve or correct the current solution | F3 |
| **edge** | Find edge cases and test cases | F4 |
| **O(n)** | Analyze time and space complexity | F5 |

Live Coding also keeps the `aa` and `ss` buttons. The numbered commands work best after copying the **Interview Prompt(Live Coding)** prompt into ChatGPT.

### System Design

For architecture, scalability, databases, APIs, reliability, and trade-off questions. The session and general send tools work normally.

The current package does not include a separate **Interview Prompt(System Design)** file. Use the Standard prompt as a starting point or edit a copy in ChatGPT for system-design instructions.

### Microphone and Start Session

- Select the microphone that the app should transcribe and that the mute button should control.
- Click **Start Session**.
- Read the recording-permission message. Click **Accept & Start Recording** only after permission has been obtained.

If system-audio or microphone capture is unavailable, the session can still save a transcript, but it may have no recording or only one audio source.

## 7. Default prompts

Default prompts tell ChatGPT how to answer during the interview. The package currently includes:

- **Interview Prompt(Standard)**
- **Interview Prompt(Live Coding)**

Recommended use:

1. Choose a prompt tab.
2. Click **Copy**.
3. Paste it into a fresh ChatGPT conversation.
4. Add the job description, résumé, and useful context.

Prompt buttons:

- **Edit:** makes the prompt editable.
- **Save:** saves your edited version locally.
- **Cancel:** discards unsaved changes from the current editing session.
- **Copy:** copies the displayed prompt.

There is no Reset button. Prompt edits remain on this PC in the app's local data.

## 8. Live session: top toolbar

From left to right:

| Icon/button | Feature |
|---|---|
| Speaker | Choose which transcript is shown: **Speaker**, **You**, or **Speaker + Mic** |
| Yellow lines/arrow | Turn **GPT auto scroll** read-along on or off |
| Bookmark | Export/save the visible transcript to a file |
| Chat box | Turn **Answer in app** on or off |
| Shield | Open **Privacy overlay** controls |
| Eye | Change original Live Captions opacity, app opacity, and Keep window on top |
| Gear | Open transcription, ChatGPT action, hotkey, auto-scroll, and debug settings |
| Question mark | Show the short in-app help |
| Red square | End the live session |
| Minus | Minimize the app |
| X | Close the app; a live transcript asks whether to save first |

The red dot and timer at the top-left show that the session is running and how long it has run.

### Transcript source

- **Speaker:** interviewer/system audio only.
- **You:** your microphone only.
- **Speaker + Mic:** both sources in one time-ordered view.

Changing the view does not erase the other source. It only changes what is displayed.

## 9. Selecting transcript text

- Drag across text to select an exact question.
- Double-click to select a word or sentence according to the text control.
- Triple-click to select a line.
- The minimap on the right helps navigate a long transcript.
- Red marks in the transcript/minimap show previous send positions.

### Latest and question detection

**Latest** does not simply take the last sentence. With **Detect questions** on (Settings, default on) it
picks the most recent sentence that actually reads as a question, and ignores trailing acknowledgements.

If the interviewer says *"How do you handle database migrations? Yeah, okay, sure."*, Latest selects only
**"How do you handle database migrations?"**.

Detection runs entirely on this PC with no API key, no internet and no model download. It only decides
what gets **selected** - it never sends anything on its own. Turn it off in Settings to go back to
picking the literally last sentence.

### AutoScroll On at the bottom

This follows new incoming transcript lines. Click it to pause or resume transcript following.

This is different from the yellow **GPT auto scroll** button, which scrolls a ChatGPT answer while you read it aloud.

### Till the end button

The double-down-arrow button extends the selection from its starting point to the end of the transcript and keeps including new text. Click it again to freeze the selection.

This is useful when one interview question arrives in several caption fragments.

## 10. Bottom action buttons

| Button | What it does |
|---|---|
| Microphone | Mutes/unmutes the selected microphone system-wide; its fill also shows the input level |
| Copy | Copies only the selected transcript text |
| **Latest** | Selects the most recent transcript sentence without sending it; then choose Send, aa, or ss |
| Compact | Copies the current ChatGPT conversation into a fresh ChatGPT tab/window; uses the configured URL if one is set |
| Edit/pencil | Pastes the selection into ChatGPT but does **not** press Send, so you can edit it first |
| **aa** | Sends your configurable `aa` keyword plus the selected question |
| **ss** | Requests a short/simple 3–4 sentence answer plus the selected question |
| **zz** | Sends only the configurable `zz` keyword; it does not need selected text |
| Double-down arrow | Selects from the current point to the transcript end and follows new text |
| Up arrow | Sends the selected text to ChatGPT without an added keyword |

Send, aa, ss, and Edit need selected transcript text. If there is no selection, the app blocks the request and shows **Select a question first, or press Latest**. The Latest button is a safe shortcut: it selects but does not automatically send the newest sentence. Confirm the highlighted sentence, then press the action you want.

`aa` and `zz` are just configurable command words. Their exact meaning comes from the prompt that you gave ChatGPT.

### Questions that are not spoken

Two actions exist for questions the microphone can never hear. Both are hotkey-only: assign them in
Settings, then press the key.

| Action | What it sends |
|---|---|
| **Send clipboard** | Whatever is currently on the clipboard - a pasted problem statement, a chat message |
| **Read screen (OCR)** | The text of the window you are looking at, read with the OCR engine built into Windows |

**Read screen** is aimed at live coding: the problem is on the screen, so no transcript selection can
ever contain it. Bring the window with the problem to the front, then press the key. It refuses if
Caption assistance itself is in front, and it reads the front window only - not the whole desktop.

Neither needs an API key or the internet.

## 11. Answer in app

Click the top chat-box icon to choose where answers appear.

### OFF

- The answer appears in the bound ChatGPT tab.
- The browser may be brought forward so you can read it there.
- The transcript uses the full app width and shows the minimap.

### ON

- The current window remains active.
- The transcript stays on the left.
- A **GPT Answer** panel appears on the right and streams the detected answer.
- **Copy** copies the received answer.
- **Refresh** safely tries to recover monitoring for the current request.

Possible status labels are **Queued**, **Sending**, **Generating**, **Complete**, and **Response error**.

### How the answer is laid out

You have to start talking before you have read the whole thing, so the panel is arranged for that:

- The **opening sentence** is separated and shown heavier. Say that first and you have bought yourself the
  seconds to scan the rest.
- The short **confirmation question** the prompts ask for appears below a divider instead of disappearing
  into the paragraph.
- **A-** and **A+** change the text size. The setting is remembered.

### Going back to an earlier answer

Interviewers follow up on what you just said. The panel keeps every completed answer from this session,
with the question that produced it.

- The **‹ ›** controls step back and forward; the label shows your position, for example `2 / 4 · past`.
- While you are looking at an earlier answer, the status line names the question it came from.
- A new answer arriving does **not** pull the view away while you are reading an older one. Press **›**
  to return to the current answer.

The answers are saved with the session, so a later review shows what was asked and what came back, not
just the transcript.

### When to use Refresh

Use **Refresh** when the answer exists in ChatGPT but the app still shows Waiting or Response error. Refresh tries to reconnect to the same request without sending a duplicate. It may briefly wake a suspended ChatGPT tab.

Do not press Send many times. That can create duplicate questions and makes recovery less reliable. If Refresh cannot identify the answer safely, open the ChatGPT tab, confirm the question and answer, bind the tab again, and retry once.

ChatGPT generation time depends on the network, ChatGPT service, conversation length, and answer length. Caption assistance cannot remove that server-side delay.

## 12. GPT auto scroll (yellow button)

This is a read-along feature for the answer shown on the ChatGPT page.

1. Make sure the ChatGPT tab is bound and already contains an answer.
2. Turn on the yellow GPT auto-scroll button.
3. Read the answer aloud.
4. The extension matches your spoken words to the answer and scrolls the ChatGPT page as you progress.

Settings:

- **Scroll up at:** how far down the page the current reading line may travel before scrolling.
- **scroll to:** where the line should be placed after scrolling, measured from the top.
- **speed:** scroll/matching movement speed.
- **Auto scroll debug:** shows matching information on the ChatGPT tab for troubleshooting.

If it does not move, confirm the microphone permission, bound tab, existing answer, and correct microphone.

## 13. Privacy overlay

Privacy is **off by default**. Open it with the shield icon.

- **Capture protection:** asks Windows to exclude the app window from supported screen-capture methods. It is not guaranteed to work with every capture program or hardware capture device.
- **Click-through:** mouse clicks pass through the app to the window underneath. The app gives a 2-second warning before enabling it.
- **Ctrl+Shift+X:** default recovery shortcut to turn click-through on or off. It can be changed by clicking its key box and pressing a new shortcut.
- When Privacy is active, the app is hidden from the taskbar. Turn Privacy off to show it normally again.

Privacy does not include a separate **Hide app now** button. Keep-on-top is also not a Privacy feature; it is under the Eye menu.

Click-through state is not saved. Restarting clears it. If the shortcut fails, use `Run-Caption assistance-Safe.cmd`.

## 14. Eye menu

- **Original Live Captions opacity:** controls the Windows Live Captions window. The app starts it at 0% so the original captions are hidden.
- **This window opacity:** changes Caption assistance transparency. Each start returns to 100% to prevent an invisible window.
- **Keep window on top:** keeps Caption assistance above ordinary windows.

Keep-on-top does not provide capture protection. Use the Shield menu for privacy controls.

## 15. Settings (gear)

### Transcription engines

Speaker and microphone can use separate engines.

| Engine | Source | Free? | Notes |
|---|---|---|---|
| **System** | Speaker | Yes | Windows Live Captions. The default for the interviewer's voice |
| **Windows speech** | Mic | Yes | The default for your voice. Offline, no Python, no key. Needs one Windows setting - see below |
| **Browser** | Mic | Yes | Chrome's own recognition, via the extension. Works with mics Windows speech cannot use |
| **Local (Vosk)** | Both | Yes | Offline. Needs a one-time Python setup, and cannot open the mic on some hardware |
| **Deepgram** | Both | No | Cloud; API key + internet |
| **ElevenLabs** | Both | No | Cloud; API key + internet |
| **Speechmatics** | Both | No | Cloud; API key + internet |

The three free options need no account. Cloud engines are marked **API key** in the dropdown.

**Windows speech needs one OS setting.** Open Windows **Settings > Privacy & security > Speech** and turn
on **Online speech recognition**. Windows never asks for this by itself - it simply refuses - so the app
tells you instead: a notice appears on screen and an **Open Windows speech settings** button takes you
straight to that page. If your mic still does not work there, switch the Mic engine to **Browser**.

The line under the dropdowns is how you check the engine at a glance:

| Line | Meaning |
|---|---|
| `System · Windows speech — live` | The engine is armed and listening |
| `System · Windows speech` (no "live") | Selected, but not confirmed working yet |
| A message in red-ish text | It failed, and the text says why |

### Which microphone actually gets transcribed

**Windows speech** and **Browser** both capture whatever Windows calls the default recording device -
neither can be pointed at a device directly. So when you pick a microphone in this app, the app **changes
the Windows default recording device to match**. That is a system-wide change: other apps will use the
same microphone afterwards.

This matters on a machine with more than one input. A capture card or webcam often registers as a
microphone, and if that is the default you get a level meter that moves and a transcript that stays
empty. Pick the microphone you are actually speaking into and the app points the engine at it.

**Local (Vosk)** and the cloud engines are given the device directly and do not touch the Windows
default.

Click **Set up local model (one-time)** when Local asks for setup. For a cloud engine, enter and save the provider API key.

Important privacy distinction: Caption assistance has no external deployment-verification/telemetry server, but audio **is sent to the selected cloud transcription provider** when Deepgram, ElevenLabs, or Speechmatics is selected. ChatGPT requests are also sent to ChatGPT. Choose System, Browser, or Local if this difference matters to you.

### ChatGPT actions and hotkeys

- Click a hotkey box, then press the key or key combination to assign it.
- Press Backspace or Delete while capturing a hotkey to clear it.
- Press Esc to cancel the change.
- Fresh installations leave Standard-mode Send, `aa`, `zz`, Compact, and Mute hotkeys unassigned (`—`).
- **Latest sentence** can also be assigned a global hotkey. It selects the newest transcript sentence without sending it.
- **ss** (simple answer) can now be bound like `aa` and `zz`.
- **Send clipboard** and **Read screen (OCR)** are hotkey-only actions; they have no toolbar button.
- Edit the `aa` and `zz` fields to change those command words.
- Set a **Compact** URL to open a specific GPT/custom GPT; leave it blank for a new normal chat.
- Live Coding always reserves F1–F5 for plan, code, improve, edge, and complexity while that mode is active.

### Fix technical terms

On by default. Live captions are accurate on ordinary speech and wrong on exactly the words that matter -
"Postgres" becomes "post grass", "Kafka" becomes "coffca", "S3" becomes "S three". The app repairs those
before the question is sent, so both the transcript you read and the text ChatGPT receives are correct.

It only ever produces words it already knows: the technical terms found in **your documents** (see below)
plus a small built-in list, and a table of known spell-outs. A word it does not recognise is left exactly
as it was, so ordinary speech is never rewritten.

Settings shows the most recent corrections, for example `post grass → Postgres`. If one looks wrong, turn
the toggle off - the transcript is then left untouched.

Adding your CV and the job description makes this markedly better, because the terms that will come up in
the interview are the ones already written there.

### Your documents (CV, job description, notes)

Instead of pasting your background into the prompt, keep it as files and let the app attach only the part
each question needs.

1. In Settings, click **Open folder**. The app creates it and opens it in Explorer.
2. Drop in `.txt` or `.md` files - your CV, the job description, notes from earlier rounds.
3. Separate topics with a **blank line**. Each block between blank lines is matched on its own.

When you send a question, the app scores those blocks against it and attaches the best few (at most 4
blocks / 1800 characters) after the question. A Kubernetes question pulls your Kubernetes paragraph; a
question about hobbies pulls the paragraph about hobbies.

Settings shows how many files and paragraphs were found. **Use my documents** turns the whole thing off.

This runs entirely on this PC: no upload, no embeddings, no account. The attached text does go to ChatGPT
along with the question, exactly like the rest of the message.

### Detect questions

On by default. Changes what **Latest** selects - see section 9. No network, no key.

### Debug tools

- **Auto scroll debug:** diagnostic overlay on the ChatGPT page.
- **Debug console:** app logs and errors. It can also be toggled with `Ctrl+Shift+D`.

Leave debug options off during normal use.

## 16. Ending, saving, and reviewing a session

1. Click the red Stop button.
2. Enter a session name.
3. Choose **End and Save session** or **Delete session**.

Closing the window during a live transcript also asks whether to save or exit without saving.

When reviewing a saved session with audio:

- Play/pause the recording.
- Go back or forward 10 seconds.
- Drag the timeline.
- Change playback speed to 1×, 1.25×, 1.5×, or 2×.
- Use the down-arrow replay button to enable or disable transcript following.
- Click a transcript line to play from that line's recorded time.

The recording mixes the available system audio and selected microphone. If recording permission or a capture source was unavailable, the replay bar may not appear.

## 17. Data and network privacy

- Sessions, transcripts, prompt edits, settings, and recordings are stored locally on this PC.
- Deleting a saved session permanently removes its transcript and recording from this PC.
- The app does not send the PC name, Windows username, local IP, or distribution ID to an external verification server.
- The app-extension bridge uses only `127.0.0.1`, ports `17632-17636`, on this PC.
- The app runs on any network; there is no subnet restriction.
- Your documents folder, question detection, technical-term repair and screen OCR all run on this PC only. Nothing is uploaded by those features.
- ChatGPT features use ChatGPT's internet service. Anything you send - a selected question, the clipboard, OCR text, and the document blocks attached to it - goes to ChatGPT along with it.
- Windows speech recognition is a Microsoft service; Windows requires you to accept its speech privacy policy before it will run at all.
- Chrome speech (the Browser mic engine) sends audio to the browser's speech service while it is active.
- Cloud transcription sends audio to the cloud provider you explicitly select.

## 18. Common problems

### The app does not open

- Use `Run-Caption assistance-Local.cmd`, not an internal file.
- Check that `Caption assistance-1.0.2-local\Caption assistance.exe` still exists.
- Wait through the 5-second startup video.

### It says no bridge

1. Start the app.
2. Open `chrome://extensions`.
3. Confirm Caption assistance Bridge is enabled.
4. Click its **Reload** button.
5. Press F5 on ChatGPT.
6. Click the chain button to bind the tab.

### It says bind a tab

Open the ChatGPT tab you want to use and click the floating chain button.

### No transcript appears

- Check Windows microphone permission.
- Select the correct microphone.
- Check Speaker/You/Both view.
- Check the selected speaker and mic transcription engines.
- If using Local, complete the one-time model setup.
- If using a cloud engine, check its API key and internet connection.

### Answer in app stays on Waiting or shows an error

- Wait for ChatGPT to finish.
- Click **Refresh** once.
- Open ChatGPT and confirm the prompt was submitted.
- Re-bind the correct ChatGPT tab.
- Reload the extension and refresh ChatGPT if needed.
- Avoid repeatedly pressing Send.

### My voice is not transcribed

Work through these in order.

1. **Is the engine armed?** Open Settings and read the line under the engine dropdowns. If it says
   `Windows speech — live`, the engine is fine and the problem is the audio reaching it. If it shows a
   message instead, that message is the reason - and if the reason is the OS setting, use the **Open
   Windows speech settings** button next to it.
2. **Is the right microphone selected?** This is the common one on a machine with several inputs. Watch
   the microphone button while you speak: it fills like a level meter. If it does not move, the app is
   listening to the wrong device - pick another one from the microphone dropdown.
3. **Still nothing after the meter moves?** Switch the Mic engine to **Browser** (needs the extension and
   a bound tab), which uses Chrome's recogniser instead.

The interviewer's side is a separate engine (**System**, Windows Live Captions) and is unaffected by all
of this.

### A technical term was corrected to the wrong word

Open Settings and look at the line under **Fix technical terms** - it lists the most recent corrections.
Turn the toggle off to stop rewriting entirely.

The corrector only produces words from your documents plus a small built-in list, so it cannot invent a
word; a wrong result means two of your own terms sound alike. Removing the unused one from your documents
folder is usually enough.

### The app warns that the page layout was not recognised

The app checks the bound page when you bind it and reports which controls it found. This warning means
the site's markup changed, or you bound a site the app does not have a tested adapter for. chatgpt.com is
the tested one. Reload the extension on `chrome://extensions`, press F5 on the page, and bind again.

Sending will probably fail while this warning is showing, so treat it as a real error, not a hint.

### Read screen (OCR) finds no text

- Bring the window you want to read to the **front** first. The action refuses while Caption assistance
  itself is focused, and it only reads the front window.
- It reads text, not pictures of handwriting or heavily stylised graphics.
- Very small or very low-contrast text may not be recognised; zoom the page in and try again.

### Privacy made the window hard to control

- Press `Ctrl+Shift+X`.
- If that does not work, close/restart with `Run-Caption assistance-Safe.cmd`.

### Changes do not appear

- Restart the app for application-file changes.
- For extension changes, click Reload at `chrome://extensions`, then press F5 on ChatGPT.

## 19. Folder reference

| Folder/file | Purpose |
|---|---|
| `Caption assistance-1.0.2-local` | Runtime application; required to run |
| `extension` | Chrome extension for ChatGPT automation |
| `local-patch` | Modified source and rebuild resources; not needed for daily runtime, but keep it for future changes |
| `Run-Caption assistance-Local.cmd` | Normal launcher |
| `Run-Caption assistance-Safe.cmd` | Privacy-recovery launcher |
| `RUN_INSTRUCTIONS.txt` | Short installation/start notes |
| `CHANGELOG.md` | What changed in each release |
| `tools/smoke` | Automated checks that drive the app; not needed for daily use |

Your own data lives outside this folder, under `%APPDATA%/Caption assistance`:

| Folder | Contents |
|---|---|
| `context` | Your CV / job description / notes, used by **Use my documents** |
| `recordings` | Session audio |

## 20. One-minute daily checklist

1. Start with the Local launcher.
2. Open the prepared ChatGPT conversation.
3. Confirm **linked**; bind the tab if needed.
4. Choose the correct interview mode and microphone.
5. Check the engine line in Settings shows no error (Windows speech needs **Online speech recognition** on).
6. Start the session and confirm the correct transcript source.
7. Select a question and press the appropriate action - or **Latest** first, which picks out the question for you.
8. If using Answer in app, use Refresh once if monitoring is interrupted.
9. Stop and save the session when finished.
