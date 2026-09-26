export function speechRecognitionSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createListener({ onFinal, onInterim, onError }) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    return { start() {}, stop() {}, pause() {}, resume() {} };
  }

  let recognition = null;
  let wanted = false;
  let paused = false;

  const attach = () => {
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      let alternatives = [];
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const top = result[0]?.transcript || "";
        if (result.isFinal) {
          finalText += top;
          alternatives = [];
          for (let a = 0; a < result.length; a += 1) {
            const text = String(result[a].transcript || "").trim();
            if (!text) continue;
            alternatives.push({
              text,
              confidence: Number.isFinite(result[a].confidence) ? result[a].confidence : 0,
            });
          }
        } else {
          interim += top;
        }
      }
      if (interim) onInterim?.(interim.trim());
      if (finalText.trim()) {
        onFinal?.({
          text: finalText.trim(),
          alternatives: alternatives.length ? alternatives : [{ text: finalText.trim(), confidence: 0 }],
        });
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") {
        onError?.(event.error);
      }
    };
    recognition.onend = () => {
      if (wanted && !paused) {
        try {
          recognition.start();
        } catch {
          /* Chrome throws if start() is too soon */
        }
      }
    };
  };

  attach();

  return {
    start() {
      wanted = true;
      paused = false;
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    },
    stop() {
      wanted = false;
      paused = false;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    },
    pause() {
      paused = true;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    },
    resume() {
      if (!wanted) return;
      paused = false;
      try {
        recognition.start();
      } catch {
        /* ignore */
      }
    },
  };
}

export function browserSpeak(text) {
  return new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
}

let currentPreview = null;

/** Speaks a highlighted option. Replaces any preview already playing; `onDone` runs exactly once. */
export function previewSpeak(text, onDone) {
  stopPreview();
  if (!window.speechSynthesis) {
    onDone?.();
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (currentPreview === finish) currentPreview = null;
    onDone?.();
  };
  currentPreview = finish;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  utter.onend = finish;
  utter.onerror = finish;
  window.speechSynthesis.speak(utter);
}

/** Cancel events don't fire reliably in every browser, so the stopped preview is finished here. */
export function stopPreview() {
  const finish = currentPreview;
  if (!finish) return;
  currentPreview = null;
  window.speechSynthesis?.cancel();
  finish();
}

export async function grokSpeak(text) {
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("Grok Voice unavailable");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = resolve;
    audio.onerror = reject;
    audio.play().catch(reject);
  });
  URL.revokeObjectURL(url);
}
