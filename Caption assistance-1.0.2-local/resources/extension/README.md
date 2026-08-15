# Caption assistance Bridge (Chrome extension)

Lets Caption assistance drive ChatGPT in Chrome: send the selected transcript, run interview
commands, optionally stream the answer back into the app, and compact a long chat.

## Install (one time)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension` folder beside the launcher.
4. Keep **Caption assistance running** and a **chatgpt.com** tab open.

That's it. The extension talks to Caption assistance over `http://127.0.0.1:17632` (local
only). Open Caption assistance's **⚙ settings** — the status line shows **"Extension:
connected ✓"** once it's talking.

After updating this extension, click **Reload** on `chrome://extensions`, then refresh the bound
ChatGPT tab once so the new content script is active.

## Answer in app

The chat-bubble button in the live-session title bar controls where replies appear:

- **Off:** the bound ChatGPT tab is focused and the reply stays there.
- **On:** the current window keeps focus and the bound tab streams the reply to Caption assistance.

When it is on, the transcript stays on the left and the streamed GPT answer appears on the right.
The ChatGPT tab must remain open, signed in, and bound. Normal background sends keep the current
window and web tab unchanged. Answers are observed from the ChatGPT page and returned over localhost;
no extra external server is used.

Chrome can suspend a long-idle tab. If the app reports that the bound tab is suspended, use the
**Refresh** button beside Copy. Refresh first checks whether the original question already exists,
reconnects answer monitoring, and only resends when the request is confirmed absent. A suspended tab
is activated briefly without focusing its Chrome window, then the previously active tab is restored.

## Actions (default hotkeys — all rebindable in ⚙ settings)

| Hotkey | Action | What it sends to ChatGPT |
| ------ | ------ | ------------------------ |
| **F1** | Send selection | the highlighted transcript text |
| **F2** | `aa` + selection | a line with your `aa` keyword, then the selection |
| **F3** | `bb` only | just your `bb` keyword |
| **F6** | Compact | scrapes the current chat, opens a new window at your chosen URL, and pastes the history there |

The hotkeys are global — they work even while Chrome is focused. You can also click
the **↑ / aa / bb** buttons in Caption assistance's caption toolbar.

## Notes

- The **compact URL** (⚙ settings) is the project/GPT you want the fresh window to
  open, e.g. `https://chatgpt.com/g/g-p-XXXX/project`. Leave it blank for a new chat.
- If ChatGPT changes its page markup, the composer/scrape selectors in `content.js`
  may need a tweak.
- The token in `background.js` (`captionassistance-bridge-7f3a`) must match Caption assistance's
  `BRIDGE_TOKEN` in `main.js`.
