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
  let lastInterimAt = 0;

  const attach = () => {
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      let confidence = 0;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const top = result[0]?.transcript || "";
        if (result.isFinal) {
          finalText += top;
          confidence = Number.isFinite(result[0]?.confidence) ? result[0].confidence : 0;
        } else {
          interim += top;
        }
      }
      if (interim) {
        lastInterimAt = Date.now();
        onInterim?.(interim.trim());
      }
      if (finalText.trim()) {
        const recognizeMs = lastInterimAt ? Date.now() - lastInterimAt : 0;
        lastInterimAt = 0;
        onFinal?.({ text: finalText.trim(), confidence, recognizeMs });
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

export function logTiming(stage, ms, extra = "") {
  const rounded = Math.round(ms);
  console.log(`[timing] ${stage}: ${rounded}ms${extra ? ` · ${extra}` : ""}`);
  fetch("/api/timing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage, ms: rounded, extra }),
  }).catch(() => {});
}

function speakSignal(signal, ms = 20000) {
  if (typeof AbortSignal.timeout !== "function") return signal;
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

export function usesCloudVoice(voice) {
  return voice === "grok" || voice === "openai" || voice === "race" || voice === "both";
}

let speakProvider = "openai";

async function fetchSpeakUrl(text, signal, provider) {
  const t0 = performance.now();
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, provider }),
    signal: speakSignal(signal),
  });
  if (!res.ok) throw new Error("Voice unavailable");
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), ms: performance.now() - t0 };
}

function appendBuffer(sourceBuffer, chunk) {
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sourceBuffer.removeEventListener("updateend", onEnd);
      sourceBuffer.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      sourceBuffer.removeEventListener("updateend", onEnd);
      sourceBuffer.removeEventListener("error", onErr);
      reject(new Error("Could not append audio"));
    };
    sourceBuffer.addEventListener("updateend", onEnd);
    sourceBuffer.addEventListener("error", onErr);
    sourceBuffer.appendBuffer(chunk);
  });
}

/** Plays /api/speak as it arrives, then returns a blob URL for the finished clip. */
async function streamAndPlay(text, signal) {
  try {
    return await streamAndPlayInner(text, signal);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const { url, ms } = await fetchSpeakUrl(text, signal, speakProvider);
    logTiming("speak", ms, "on demand");
    await playUrl(url);
    return { url, ms };
  }
}

async function streamAndPlayInner(text, signal) {
  const t0 = performance.now();
  const res = await fetch("/api/speak?stream=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, provider: speakProvider }),
    signal: speakSignal(signal),
  });
  if (!res.ok || !res.body) throw new Error("Voice unavailable");

  const chunks = [];
  const reader = res.body.getReader();
  let firstMs = 0;

  const canStream = Boolean(window.MediaSource && MediaSource.isTypeSupported("audio/mpeg"));
  if (!canStream) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) chunks.push(value);
    }
    const blob = new Blob(chunks, { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    logTiming("speak", performance.now() - t0, "on demand");
    await playUrl(url);
    return { url, ms: performance.now() - t0 };
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio(objectUrl);

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      audio.onended = null;
      audio.onerror = null;
      reject(err);
    };
    mediaSource.addEventListener("sourceopen", async () => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        audio.onended = resolve;
        audio.onerror = () => fail(new Error("audio play failed"));
        const playOnce = () => {
          audio.play().catch(() => {});
        };
        playOnce();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          chunks.push(value);
          if (!firstMs) {
            firstMs = performance.now() - t0;
            logTiming("speak", firstMs, "stream first audio");
            playOnce();
          }
          await appendBuffer(sourceBuffer, value);
        }
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
        playOnce();
        if (audio.ended) {
          resolve();
          return;
        }
        const leftover = Number.isFinite(audio.duration)
          ? Math.max(400, (audio.duration - audio.currentTime) * 1000 + 400)
          : 15000;
        const timer = setTimeout(() => resolve(), leftover);
        const prevEnded = audio.onended;
        audio.onended = () => {
          clearTimeout(timer);
          prevEnded?.();
        };
      } catch (err) {
        fail(err);
      }
    }, { once: true });
  });

  URL.revokeObjectURL(objectUrl);
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  return { url: URL.createObjectURL(blob), ms: firstMs || performance.now() - t0 };
}

function createTtsQueue(limit = 2) {
  let active = 0;
  const waiting = [];

  function pump() {
    const extra = waiting.some((job) => job.urgent) ? 1 : 0;
    while (active < limit + extra && waiting.length) {
      const job = waiting.shift();
      if (job.cancelled) continue;
      active += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    enqueue(run, urgent = false) {
      let job;
      const promise = new Promise((resolve, reject) => {
        job = {
          run,
          resolve,
          reject,
          cancelled: false,
          urgent,
          promote() {
            job.urgent = true;
            const i = waiting.indexOf(job);
            if (i > 0) {
              waiting.splice(i, 1);
              waiting.unshift(job);
            }
            pump();
          },
        };
        if (urgent) waiting.unshift(job);
        else waiting.push(job);
        pump();
      });
      return { promise, promote: () => job?.promote?.() };
    },
  };
}

function playUrl(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = resolve;
    audio.onerror = reject;
    audio.play().catch(reject);
  });
}

export async function grokSpeak(text, signal) {
  const t0 = performance.now();
  try {
    const { url } = await streamAndPlay(text, signal);
    URL.revokeObjectURL(url);
  } catch (err) {
    logTiming("speak", performance.now() - t0, err?.name === "AbortError" ? "cancelled or timed out" : "failed");
    throw err;
  }
}

/**
 * Prefetches cloud TTS. Reply clips are dropped when the next set arrives; custom-phrase
 * clips stay until the phrase list or voice setting changes.
 */
export function createVoiceCache() {
  let replies = new Map();
  const custom = new Map();
  const queue = createTtsQueue(2);

  function begin(cache, text, urgent = false) {
    if (!text) return null;
    if (cache.has(text)) {
      const existing = cache.get(text);
      if (urgent) existing.promote?.();
      return existing;
    }
    const controller = new AbortController();
    const entry = { promise: null, url: null, ms: null, controller, promote: null };
    const queued = queue.enqueue(() => {
      if (controller.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return fetchSpeakUrl(text, controller.signal, speakProvider);
    }, urgent);
    entry.promote = queued.promote;
    entry.promise = queued.promise
      .then((result) => {
        entry.url = result.url;
        entry.ms = result.ms;
        return result.url;
      })
      .catch((err) => {
        if (!entry.keep) cache.delete(text);
        throw err;
      });
    cache.set(text, entry);
    return entry;
  }

  function drop(cache) {
    for (const entry of cache.values()) {
      entry.controller.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cache.clear();
  }

  return {
    setProvider(next) {
      speakProvider = next || "openai";
    },
    prefetch(texts) {
      for (const text of texts) begin(replies, String(text || "").trim());
    },
    prefetchCustom(texts) {
      const wanted = new Set((texts || []).map((line) => String(line || "").trim()).filter(Boolean));
      for (const [key, entry] of [...custom.entries()]) {
        if (wanted.has(key)) continue;
        entry.controller.abort();
        if (entry.url) URL.revokeObjectURL(entry.url);
        custom.delete(key);
      }
      for (const text of wanted) begin(custom, text);
    },
    clearReplies() {
      drop(replies);
      replies = new Map();
    },
    clearCustom() {
      drop(custom);
    },
    async play(text) {
      const cache = replies.has(text) ? replies : custom.has(text) ? custom : replies;
      const entry = cache.get(text);
      if (entry?.url) {
        logTiming("speak", entry.ms ?? 0, "prefetched");
        await playUrl(entry.url);
        return;
      }

      if (entry) {
        entry.keep = true;
        entry.controller.abort();
      }

      const t0 = performance.now();
      try {
        const result = await streamAndPlay(text);
        const next = cache.get(text) || entry || { promise: null, url: null, ms: null, controller: new AbortController(), promote: null };
        if (next.url && next.url !== result.url) URL.revokeObjectURL(next.url);
        next.url = result.url;
        next.ms = result.ms;
        next.promise = Promise.resolve(result.url);
        next.keep = true;
        cache.set(text, next);
      } catch (err) {
        if (entry && !entry.url) cache.delete(text);
        logTiming(
          "speak",
          performance.now() - t0,
          err?.name === "AbortError" ? "cancelled or timed out" : "failed"
        );
        throw err;
      }
    },
  };
}
