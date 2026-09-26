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
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      if (interim) onInterim?.(interim.trim());
      if (finalText.trim()) onFinal?.(finalText.trim());
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
