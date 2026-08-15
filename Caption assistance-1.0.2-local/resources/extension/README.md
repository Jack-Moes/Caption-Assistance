# Caption assistance Bridge (Chrome extension)

Lets Caption assistance drive ChatGPT in Chrome: send the selected transcript, run your
`aa`/`bb` prompts, and compact a long chat into a fresh window — all by hotkey.

## Install (one time)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension` folder beside the launcher.
4. Keep **Caption assistance running** and a **chatgpt.com** tab open.

That's it. The extension talks to Caption assistance over `http://127.0.0.1:17632` (local
only). Open Caption assistance's **⚙ settings** — the status line shows **"Extension:
connected ✓"** once it's talking.

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
