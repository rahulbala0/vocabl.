# vocabl.

AI-enabled AAC board for nonverbal users. Someone talks (or you type what they said). vocabl. interprets that line, generates short first-person replies on a wheel, and speaks the one the user selects. Conversation history stays on screen and is saved so later replies can use recent turns.

You can run the full software loop with a keyboard. The ESP32 stick and programmable buttons are optional.

## Requirements

- Node.js 20 or newer
- **Chrome on desktop or Windows tablet** (not iOS). Web Bluetooth and this Speech Recognition stack need Chrome.
- Internet for the mic API and for Grok / ChatGPT
- Optional: xAI and/or OpenAI API keys. Without keys, replies still appear from offline heuristics.
- Optional hardware: ESP32, analog joystick, two buttons (select and mute/unmute)

## Run the app

From the repo root:

```bash
npm install
```

Create a `.env` file in the repo root (this file is gitignored):

```
XAI_API_KEY=
XAI_MODEL=grok-4.6
XAI_TTS_VOICE=eve
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_TTS_VOICE=nova
OPENAI_TTS_MODEL=tts-1
PORT=8787
```

Either key is enough. Leave both blank to use offline replies only.

Start the UI and the API proxy together:

```bash
npm run dev
```

Open Chrome to [http://localhost:5173](http://localhost:5173). Allow the microphone when asked.

You should see two processes: Vite on port 5173 and Express on port 8787. The browser talks to `/api/*`; Vite forwards those calls to the proxy so keys never sit in the page.

| Command | What it does |
| --- | --- |
| `npm run dev` | Frontend + proxy (use this) |
| `npm run web` | Vite only (`localhost:5173`) |
| `npm run server` | Proxy only (`localhost:8787`) |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |

`npm run web` alone cannot generate cloud replies or cloud speech. If the proxy is down, the gear menu will not see keys, and `/api/suggest` fails over to offline guesses.

### Keyboard-only loop (no hardware)

1. Click **Mic** (or press `L`) and talk, or type a line at the bottom and submit.
2. Wait for four replies on the wheel (hub shows **Thinking** while the request is in flight).
3. Arrow keys highlight a slice. Short **Enter** or **Space** speaks it.
4. The right pane shows what they said, the spoken reply, and the running conversation.

### Tablet on the same Wi-Fi

Run `npm run dev` on a laptop. On the tablet, open `http://LAPTOP_IP:5173` in Chrome (Vite is bound on all interfaces). Keep the laptop awake; the proxy has to stay up.

## Using the board

**Listen.** Mic on the left, or type into “They said.” A programmable hardware button (and `L`) mute and unmute listening. The mic pauses while the tablet is speaking so it does not hear itself.

**Interpret and generate.** The last line is sent with the user profile, custom prompt, recent history, saved facts, and past summaries. Grok and ChatGPT are raced by default. Replies must answer that line. Low speech confidence can add “Can you say that again?”

**Select.** Analog stick, arrows, or touch. Short click / programmable select / Enter speaks the highlight. Two clicks within about 400 ms (or `R`) requests a new set of replies. Hold the joystick click about 700 ms for four custom phrases.

**Output.** Cloud TTS (Grok and/or ChatGPT) or the browser voice. Volume is on the left.

**History.** The right pane is the live conversation. After a few minutes of silence, or when the tab hides, vocabl. stores a one-line summary and any new facts.

**Scanning.** In Settings, scanning walks the highlight so only select is required.

**Settings (gear).** Profile, custom prompt, AI provider (`race` / Grok-then-ChatGPT / ChatGPT-then-Grok), voice (same plus browser), read options aloud, scan speed, memory editor, joystick connect/calibrate/reset. Repeat last spoken line is here too.

Settings persist in the browser under `speakeasy-settings-v1`.

### Keyboard

| Key | Action |
| --- | --- |
| Arrow keys | Highlight a slice |
| Enter or Space (short) | Speak the highlight |
| Enter or Space (hold ~700 ms) | Custom phrases |
| `R` | New replies |
| `L` | Mute / unmute mic |
| Esc | Close settings |

## Hardware

Current firmware is the PlatformIO sketch under `firmware/` (ESP32 Dev Module, 115200 baud). It streams `x,y,sw,btn,alt` over Nordic UART BLE. The web app maps that to directions, select, hold, double-click, and mic toggle.

Joystick **VCC must be 3.3 V**, not 5 V. Power the ESP32 from USB **or** a pack on **5V/VIN + GND**, never both at once.

| Control | ESP32 | App |
| --- | --- | --- |
| Joystick GND | GND | |
| Joystick VCC | 3V3 | |
| VRx | GPIO 14 | Tilt |
| VRy | GPIO 12 | Tilt |
| Joystick SW | GPIO 13 | Click / hold (~700 ms) / double-click |
| Button A | GPIO 33 to GND | Select (programmable select) |
| Button B | GPIO 25 to GND | Mute / unmute mic |
| Status LED | GPIO 2 | Blinks when the tablet writes `SELECT` |

Buttons are INPUT_PULLUP (pressed = LOW). You can rewire pins in the firmware; the app treats **btn** as select and **alt** as mic.

Bluetooth device name in firmware is `SpeakEasy` (Chrome’s picker). Service UUID `6e400001-b5a3-f393-e0a9-e50e24dcca9e`. Notify characteristic sends the sample line; write characteristic accepts `SELECT` to blink the LED.

### Flash with PlatformIO

```bash
cd firmware
pio run -t upload
pio device monitor
```

Or Arduino IDE: open the equivalent sketch, board **ESP32 Dev Module**, ESP32 core (includes BLE).

If axes feel backwards, use the in-app calibration wizard (center, range, orientation, test) rather than guessing. `INVERT` flags exist on the older Arduino-only sketch if you still use that file.

### Connect in Chrome

1. Firmware running, stick at rest.
2. Click **Controller**.
3. Pick the BLE device named SpeakEasy.
4. Tilt should move the highlight. Button A selects. Button B toggles the mic. Hold joystick SW for custom phrases.

There is no Web Bluetooth on iOS.

An older Arduino sketch still lives as `firmware/speakeasy_esp32.ino` (different pins, direction tokens instead of raw ADC). Prefer the PlatformIO firmware above unless you know you flashed the older one.

## If something is wrong

| Symptom | What to check |
| --- | --- |
| Wheel stuck on generic replies / “offline” | `npm run dev` or `npm run server` is running. Keys in `.env` in the **repo root**. Restart the proxy after editing `.env`. |
| Mic does nothing | Chrome, not Edge-as-IE / Firefox / iOS. Permission granted. Internet. Press `L`. |
| No Bluetooth devices | Chrome desktop/Windows. `https` or `localhost`. Firmware advertising. Try the name filter; the app also matches the Nordic UART service. |
| Stick drifts or wrong slice | Run calibration in Settings. Do not move the stick for the first moment after connect (rest is sampled). |
| Board hears itself | Expected if you unmute during TTS. Mic should pause while speaking. |
| CORS / keys in the browser | Do not call xAI or OpenAI from the page. Always go through the proxy. |
| Upload + USB battery issues | Unplug VIN battery before USB, or run on battery only. |

`GET http://localhost:8787/api/health` reports whether Grok and OpenAI keys loaded.

## How it is put together

Two processes: Vite serves the React app; Express holds keys and calls xAI (`grok-4.6` by default) and OpenAI (`gpt-4o-mini`, `tts-1`). Suggest races both unless Settings pick one order. Speak can race, prefer one provider, or use the browser voice. A summarize call runs when a conversation ends.

The wheel is four slices. Custom phrases are a second wheel. Offline keyword replies fill in when the proxy or models fail.

## Repo map

```
.env                 API keys (you create this)
server/              Express proxy
src/                 React app, wheel, settings, BLE, speech
firmware/            PlatformIO ESP32 firmware
firmware/speakeasy_esp32.ino   older Arduino sketch
```

There are no automated tests.
