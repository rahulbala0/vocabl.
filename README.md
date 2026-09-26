# SpeakEasy Board

AI communication board for nonverbal people with motor disabilities (ALS, cerebral palsy, stroke, and similar). The other person talks. SpeakEasy predicts four likely replies. The user picks one with a joystick. The tablet speaks it out loud.

The goal is a real conversation in seconds instead of spelling letter by letter.

## Who does what

| Person | Work |
| --- | --- |
| Hardware | Flash the ESP32, wire the joystick, battery, enclosure |
| Web | Chrome app on the Dell Venue 10 Pro |
| AI | `.env` keys, Grok replies + Grok Voice |
| Demo | 2–3 minute video + Devpost (`DEVPOST.md`) |

## Quick start (no hardware)

1. Install Node.js 20+.
2. In this folder:

```bash
npm install
```

3. Paste keys into `.env` (copy from `.env.example` if needed):

```
XAI_API_KEY=xai-...
OPENAI_API_KEY=sk-...
```

4. Run:

```bash
npm run dev
```

5. Open Chrome to `http://localhost:5173`. Use **arrow keys + Enter**. Click **Listen**, talk, wait for four replies, highlight one, press Enter. The board speaks.

You can demo the full software loop without the ESP32.

## Hardware

Joystick → ESP32:

| Joystick | ESP32 |
| --- | --- |
| GND | GND |
| +5V | **3V3 only** (not 5V) |
| VRx | GPIO 34 |
| VRy | GPIO 35 |
| SW | GPIO 32 |

Battery: 3–4 AA into **5V/VIN** and GND. Never USB and battery at the same time.

Firmware: `firmware/speakeasy_esp32.ino`

Arduino IDE: board **ESP32 Dev Module**, install **ESP32 BLE Arduino** (comes with the ESP32 core). Serial 115200. If directions are swapped, set `INVERT_X` / `INVERT_Y` at the top of the sketch.

BLE name: `SpeakEasy`  
Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`  
Notify `6e400003-...` sends `UP` `DOWN` `LEFT` `RIGHT` `SELECT`  
Write `6e400002-...` blinks GPIO 2 twice (selection feedback)

On the tablet: Chrome → **Connect joystick**. Web Bluetooth does **not** work on iOS.

## What the board does

- **Row 1:** four AI replies from Grok (`grok-4.6`), ChatGPT fallback, or offline guesses
- **Row 2:** Yes / No / Help / Wait
- **Row 3:** Listen, New replies, Repeat last, Thank you
- **Row 4:** four custom phrases from Settings
- **Categories:** Food, Feelings, People, Help — for starting a conversation
- **Scanning mode:** highlight walks by itself; one click selects (limited movement)
- Mic pauses while speaking so the board does not transcribe itself

API keys stay on the Node proxy (`server/index.js`) so Chrome does not hit xAI/OpenAI directly (CORS + leaked keys).

## Hackathon risks

- Chrome only for Web Bluetooth and Speech Recognition; needs internet for the mic API
- If `.env` keys are empty, replies still work (offline) but they are generic
- Joystick axes may be inverted — fix in firmware, not the app
- `grok-4.6` can be slower than expected; the proxy asks for low reasoning. If it is still slow, set `XAI_MODEL` to a faster model your key can use
- Grok Voice is best-effort; browser `speechSynthesis` is the fallback
- Dell Venue 10 Pro: use Chrome, allow mic + Bluetooth prompts, keep the laptop proxy running on the same Wi‑Fi if the tablet is not hosting Node

For judging, run the proxy on the tablet if Node is installed there. Otherwise run `npm run dev` on a laptop and open `http://LAPTOP_IP:5173` from the tablet (same network). Vite already proxies `/api`.

## Demo script

See `DEMO.md`. Devpost draft: `DEVPOST.md`.
