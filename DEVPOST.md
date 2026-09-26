# Devpost draft — SpeakEasy Board

## Inspiration

People with ALS, cerebral palsy, or stroke often cannot speak, and many cannot use a keyboard or touch screen well. Traditional AAC boards force them to assemble words letter by letter. Family members wait. Conversations shrink. We wanted a device that lets someone stay in the talk, not just request a bathroom.

## What it does

SpeakEasy listens to the other person, predicts four likely first-person replies with Grok, and lets the user choose one with a cheap analog joystick over Bluetooth. The tablet speaks the choice out loud. Quick words, custom phrases, conversation categories, and a scanning mode cover days when movement is very limited.

## How we built it

- ESP32 BLE joystick (ADC on GPIO 34/35, click on 32)
- React app in Chrome: Web Bluetooth, Web Speech API, large high-contrast tiles, Atkinson Hyperlegible
- Tiny Node proxy so API keys never sit in the browser and CORS cannot kill the demo
- xAI Grok for reply generation (`grok-4.6`) and Grok Voice for speech, with ChatGPT and browser TTS as fallbacks

## Challenges

Chrome-only Bluetooth and speech. Joystick noise vs. a clean UP/DOWN/LEFT/RIGHT protocol. Keeping replies short, distinct, and in the user’s voice instead of four paraphrases of “yes.” Never powering VIN and USB together.

## Accomplishments

A loop you can demo: speech in → four replies → joystick → speech out. Offline replies if the API is down. Scanning and categories without extra hardware.

## What we learned

Accessibility hardware fails if the software assumes a precise gesture. One click must be enough. AI is only useful here if it is fast, local to the conversation, and never the only path.

## What’s next

A 3D-printed enclosure, a large external button, a frequent-phrase list that learns, and Grok Voice as the default voice of the device rather than a fallback.

## Built with

ESP32, Arduino BLE, analog joystick, React, Vite, Express, Web Bluetooth, Web Speech API, xAI Grok, OpenAI (fallback), Chrome on Windows tablet.
