let ctx = null;
let ringing = false;
let beepTimer = null;

function beep() {
  if (!ringing || !ctx) return;
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = ctx.createGain();

  osc1.type = "square";
  osc2.type = "square";
  osc1.frequency.value = 880;
  osc2.frequency.value = 988;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + 0.01);
  gain.gain.setValueAtTime(1, now + 0.18);
  gain.gain.linearRampToValueAtTime(0, now + 0.2);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(ctx.destination);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + 0.2);
  osc2.stop(now + 0.2);
}

function startAlarm() {
  if (ringing) return;
  ringing = true;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  beep();
  beepTimer = setInterval(beep, 400);
}

function stopAlarm() {
  ringing = false;
  if (beepTimer) clearInterval(beepTimer);
  beepTimer = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "start-alarm-sound") startAlarm();
  if (msg.type === "stop-alarm-sound") stopAlarm();
});
