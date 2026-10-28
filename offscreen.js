// Hidden extension page. It does two things:
// 1) Reads sites without opening a tab: loads the site in an iframe; the
//    frame-reader.js script runs inside it and sends the text back.
// 2) Plays the alert: a soft synth arpeggio, generated on the fly.

const pending = new Map(); // iframe token -> function that receives the text

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'play') {
    playAlert();
    return false;
  }

  if (msg.type === 'frameText') {
    const done = pending.get(msg.token);
    if (done) done(msg.text);
    return false;
  }

  if (msg.type === 'scrape') {
    scrape(msg.url, msg.timeoutMs)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }

  return false;
});

function scrape(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const token = 'sentinel:' + crypto.randomUUID();
    const iframe = document.createElement('iframe');
    iframe.name = token;
    iframe.style.cssText = 'width:1280px;height:2000px;border:0';

    const timer = setTimeout(() => finish(new Error('The page did not respond in time.')), timeoutMs);
    function finish(err, text) {
      clearTimeout(timer);
      pending.delete(token);
      iframe.remove();
      if (err) reject(err);
      else resolve(text);
    }

    pending.set(token, (text) => finish(null, text));
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}

// ---------- sound ----------
// "Light cycle": a soft rising synth arpeggio (A minor) with a light echo.
// Retro in character, but quiet and short so it doesn't startle.

const ARPEGGIO = [440, 523.25, 659.25, 880, 1046.5, 1318.5]; // A4 C5 E5 A5 C6 E6

function playAlert() {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.2;
  master.connect(ctx.destination);

  const delay = ctx.createDelay();
  delay.delayTime.value = 0.24;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.3;
  const wet = ctx.createGain();
  wet.gain.value = 0.4;
  master.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(ctx.destination);

  const t0 = ctx.currentTime + 0.05;
  ARPEGGIO.forEach((freq, i) => synthNote(ctx, master, freq, t0 + i * 0.11, 0.42));

  setTimeout(() => ctx.close(), 3000);
}

// Two slightly detuned sawtooth waves through a closing low-pass filter.
function synthNote(ctx, out, freq, start, length) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(1600, start);
  filter.frequency.exponentialRampToValueAtTime(700, start + length);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
  filter.connect(amp).connect(out);

  for (const detune of [-6, 6]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }
}
