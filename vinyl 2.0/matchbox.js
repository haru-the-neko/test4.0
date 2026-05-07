/* ═══════════════════════════════════════════════════════════
   MATCHBOX.JS — state-machine driven (enhanced)

   Preserves original state machine + all 7 interactions.
   Adds:
   • Scoped drag-moved flags (no more cross-interaction race)
   • Viewport clamping on drag end
   • Touch scale-up while grabbed
   • Polaroid flip interaction
   • Dedicated striker strip for love matchbox (instead of whole-box drag)
   • Peak-moment focus dim on J+C note + polaroid flip
   • RAF-wrapped deviceorientation
   • Reset button + scoped savePositions (only when something moved)
   • Soft interaction sound hooks via WebAudio (no files)
═══════════════════════════════════════════════════════════ */
'use strict';

(function() {
const {
  qs, qsa, initModal, prefersReducedMotion, isTouch,
  makeLater, managedRaf, initOpening,
} = window.CzarinaSystem;

/* ══════════════════════════════════════════
   STATE MACHINE — single source of truth
══════════════════════════════════════════ */
const STATE = {
  IDLE: 'idle',
  DRAG_OBJ: 'drag-obj',
  DRAG_TICKET: 'drag-ticket',
  DRAG_STRIKE: 'drag-strike',
};
let state = STATE.IDLE;

/* Scoped timer set — auto-cleaned on beforeunload via makeLater */
const later = makeLater();

/* ══════════════════════════════════════════
   OPENING SEQUENCE
══════════════════════════════════════════ */
const opening = qs('#opening');
const openLine = qs('#openLine');
const openSub  = qs('#openSub');
const scene    = qs('#main');
const hintText = qs('#hintText');
const srLive   = qs('#srLive');

window.addEventListener('load', () => {
  /* On touch devices "drag" is disabled — update the opening sub-line
     before initOpening reads it so the correct text fades in */
  if (isTouch()) openSub.textContent = 'tap · open · explore';

  initOpening({
    sessionKey: 'czarina:matchbox-opened',
    openingEl:  opening,
    sceneEl:    scene,
    hintEl:     hintText,
    hintClass:  'is-on',
    textEls: [
      { el: openLine },
      { el: openSub, delay: 450 },
    ],
  });
});

/* ══════════════════════════════════════════
   OBJECTS — base transforms for parallax
══════════════════════════════════════════ */
const objs = qsa('.obj');
objs.forEach(obj => {
  const rotate = getComputedStyle(obj).rotate || '0deg';
  obj.dataset.baseTransform = `rotate(${rotate})`;
});

/* Helper: true when CSS mobile layout is active */
const isMobileLayout = () => window.matchMedia('(hover: none) and (max-width: 900px)').matches;

/* On mobile: drag is disabled, so labels that imply action should be
   descriptive instead. Runs synchronously so labels read correctly
   before the opening overlay fades. */
if (isMobileLayout()) {
  const receiptLabel = qs('#obj-receipt .obj-label');
  if (receiptLabel) receiptLabel.textContent = 'kept — june 21';
  /* cat label stays descriptive — no change needed */
}

/* ══════════════════════════════════════════
   PARALLAX — driven by managedRaf, skipped
   on mobile layout and reduced motion
══════════════════════════════════════════ */
let mx = 0, my = 0;

const parallaxLoop = managedRaf(function() {
  if (state !== STATE.IDLE || prefersReducedMotion() || isMobileLayout()) return;
  const cx = window.innerWidth  / 2;
  const cy = window.innerHeight / 2;
  const dx = (mx - cx) / cx;
  const dy = (my - cy) / cy;
  objs.forEach(obj => {
    if (obj === dragEl) return;
    if (obj.classList.contains('is-peak-target')) return;
    const layer = parseFloat(obj.dataset.layer || 1);
    const base  = obj.dataset.baseTransform || '';
    obj.style.transform = base + ' translate(' + (dx * layer * 6) + 'px,' + (dy * layer * 4) + 'px)';
  });
});

/* ══════════════════════════════════════════
   SINGLE POINTERMOVE — routes by state
══════════════════════════════════════════ */
document.addEventListener('pointermove', e => {
  mx = e.clientX;
  my = e.clientY;

  switch (state) {
    case STATE.DRAG_OBJ:    moveObjDrag(e.clientX, e.clientY); break;
    case STATE.DRAG_TICKET: moveTicketDrag(e.clientX, e.clientY); break;
    case STATE.DRAG_STRIKE: moveStrikeDrag(e.clientX, e.clientY); break;
    default:
      if (!isMobileLayout() && !parallaxLoop.running) parallaxLoop.start();
  }

  if (flameOn) {
    globalFlame.style.left = (e.clientX - 10) + 'px';
    globalFlame.style.top  = (e.clientY - 35) + 'px';
  }
}, { passive: true });

/* ══════════════════════════════════════════
   DRAG — generic object drag (scoped per drag)
══════════════════════════════════════════ */
let dragEl = null, dragOx = 0, dragOy = 0;
let dragStartX = 0, dragStartY = 0;
/* Scoped per-interaction flags */
let objDragMoved = false;

function startObjDrag(el, clientX, clientY, pointerId) {
  state = STATE.DRAG_OBJ;
  dragEl = el;
  objDragMoved = false;
  const rect = el.getBoundingClientRect();
  dragOx = clientX - rect.left;
  dragOy = clientY - rect.top;
  dragStartX = clientX;
  dragStartY = clientY;
  el.classList.add('is-grabbed');
  el.classList.add('is-touching');
  if (pointerId != null) try { el.setPointerCapture(pointerId); } catch {}
  playTick(0.03, 220);
}
function moveObjDrag(clientX, clientY) {
  if (!dragEl) return;
  const ddx = Math.abs(clientX - dragStartX);
  const ddy = Math.abs(clientY - dragStartY);
  if (ddx > 4 || ddy > 4) objDragMoved = true;

  const parent = dragEl.parentElement.getBoundingClientRect();
  const x = clientX - parent.left - dragOx;
  const y = clientY - parent.top  - dragOy;
  const px = (x / parent.width)  * 100;
  const py = (y / parent.height) * 100;
  dragEl.style.left = px + '%';
  dragEl.style.top  = py + '%';
  dragEl.style.transform = dragEl.dataset.baseTransform || '';
}
function endObjDrag() {
  if (!dragEl) return;
  const el = dragEl;
  el.classList.remove('is-grabbed');
  el.classList.remove('is-touching');

  /* Clamp to viewport so nothing is ever lost off-screen */
  clampElementToViewport(el);

  /* Tiny settle rotation after release — keeps the table feeling alive */
  if (objDragMoved && !prefersReducedMotion()) {
    const jitter = (Math.random() * 2 - 1) * 2; // ±2deg
    const base = el.dataset.baseTransform || '';
    el.style.transform = `${base} rotate(${jitter}deg)`;
    later(() => { el.style.transform = base; }, 500);
  }

  if (objDragMoved) savePositions();
  dragEl = null;
  state = STATE.IDLE;
}

/* Attach drag handler to any [data-draggable] obj — desktop only */
qsa('[data-draggable]').forEach(obj => {
  obj.addEventListener('pointerdown', e => {
    if (isMobileLayout()) return; // mobile uses tap-only, no drag
    if (state !== STATE.IDLE) return;
    /* Skip if press is on an interactive child:
       - matchbox cover (slide)
       - jar/polaroid tap zone
       - love box striker strip
       - ticket stub tear zone */
    if (e.target.closest(
      '[data-toggle] .mb-cover, [data-tap], [data-strike], [data-tear-zone]'
    )) return;
    e.preventDefault();
    startObjDrag(obj, e.clientX, e.clientY, e.pointerId);
  });
});

/* Global pointerup ends any drag state */
document.addEventListener('pointerup', () => {
  if (state === STATE.DRAG_OBJ)    endObjDrag();
  if (state === STATE.DRAG_TICKET) endTicketDrag();
  if (state === STATE.DRAG_STRIKE) endStrikeDrag();
});
document.addEventListener('pointercancel', () => {
  if (state === STATE.DRAG_OBJ)    endObjDrag();
  if (state === STATE.DRAG_TICKET) endTicketDrag();
  if (state === STATE.DRAG_STRIKE) endStrikeDrag();
});

/* Clamp: keeps at least 40px of the object inside the viewport on all sides */
function clampElementToViewport(el) {
  const rect = el.getBoundingClientRect();
  const parent = el.parentElement.getBoundingClientRect();
  const pad = 20;
  let leftPx = rect.left - parent.left;
  let topPx  = rect.top  - parent.top;
  const minLeft = pad - rect.width * 0.6;
  const maxLeft = parent.width - pad - rect.width * 0.4;
  const minTop  = pad - rect.height * 0.3;
  const maxTop  = parent.height - pad - rect.height * 0.5;
  leftPx = Math.max(minLeft, Math.min(maxLeft, leftPx));
  topPx  = Math.max(minTop,  Math.min(maxTop,  topPx));
  el.style.left = (leftPx / parent.width * 100)  + '%';
  el.style.top  = (topPx  / parent.height * 100) + '%';
}

/* ══════════════════════════════════════════
   POSITIONS — versioned key, scoped save
══════════════════════════════════════════ */
const STORAGE_KEY = 'czarina:table_v3';
const resetBtn = qs('#resetBtn');
function revealResetOnce() {
  if (resetBtn && !resetBtn.classList.contains('is-visible')) {
    resetBtn.classList.add('is-visible');
  }
}
function savePositions() {
  const s = {};
  objs.forEach(o => { s[o.id] = { left: o.style.left, top: o.style.top }; });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
  revealResetOnce();
}
function restorePositions() {
  // On mobile flow layout, absolute left/top are ignored by CSS (position:relative !important)
  // so skip the restore to avoid polluting inline styles
  if (isMobileLayout()) return;
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    Object.entries(s).forEach(([id, pos]) => {
      const el = document.getElementById(id);
      if (el && pos?.left && pos?.top) {
        el.style.left = pos.left;
        el.style.top  = pos.top;
        const rotate = getComputedStyle(el).rotate || '0deg';
        el.dataset.baseTransform = `rotate(${rotate})`;
      }
    });
    if (Object.keys(s).length) revealResetOnce();
  } catch {}
}
window.addEventListener('load', () => later(restorePositions, 100));

resetBtn?.addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  location.reload();
});

/* ══════════════════════════════════════════
   MATCHBOX SLIDE — click cover to toggle
══════════════════════════════════════════ */
qsa('[data-toggle]').forEach(mb => {
  const cover = mb.querySelector('.mb-cover');
  if (!cover) return;
  /* Scoped flag on the cover itself */
  let coverDownMoved = false;
  let coverDownX = 0, coverDownY = 0;
  cover.addEventListener('pointerdown', e => {
    coverDownMoved = false;
    coverDownX = e.clientX;
    coverDownY = e.clientY;
  });
  cover.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - coverDownX) > 5 ||
        Math.abs(e.clientY - coverDownY) > 5) coverDownMoved = true;
  });
  cover.addEventListener('click', e => {
    if (objDragMoved || coverDownMoved) return;
    e.stopPropagation();
    mb.classList.toggle('is-open');
    playSlide();
  });
  const obj = mb.closest('.obj');
  if (obj) {
    obj.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        /* Only toggle if the keydown is on a non-button draggable obj */
        if (obj.tagName === 'BUTTON') return; // let native click handle
        e.preventDefault();
        mb.classList.toggle('is-open');
        playSlide();
      }
    });
  }
});

/* ══════════════════════════════════════════
   TICKET — now supports BOTH drag-to-reposition
   AND drag-from-stub to tear.
══════════════════════════════════════════ */
const ticketObj = qs('#obj-ticket');
const ticket    = qs('#ticket');
const tearZone  = ticket?.querySelector('[data-tear-zone]');
let ticketTorn = false;
let ticketStartX = 0;

tearZone?.addEventListener('pointerdown', e => {
  if (isMobileLayout()) return; // mobile uses tap keyboard alternative instead
  if (ticketTorn || state !== STATE.IDLE) return;
  /* Claim this gesture for tearing, not for repositioning */
  state = STATE.DRAG_TICKET;
  ticketStartX = e.clientX;
  try { tearZone.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
});

/* Mobile tap-to-tear: single tap on the tear zone lights the ticket */
tearZone?.addEventListener('click', e => {
  if (!isMobileLayout()) return;
  if (ticketTorn) return;
  e.stopPropagation();
  ticketTorn = true;
  ticket.classList.add('is-torn');
  playTear();
  announce('ticket torn');
});
function moveTicketDrag(clientX) {
  if (ticketTorn) return;
  const dx = ticketStartX - clientX; // leftward tear
  if (dx > 40) {
    ticketTorn = true;
    ticket.classList.add('is-torn');
    playTear();
    announce('ticket torn');
    endTicketDrag();
  }
}
function endTicketDrag() { state = STATE.IDLE; }

ticketObj.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && !ticketTorn) {
    e.preventDefault();
    ticketTorn = true;
    ticket.classList.add('is-torn');
    playTear();
  }
});

/* ══════════════════════════════════════════
   LOVE MATCHBOX — dedicated striker strip
══════════════════════════════════════════ */
const loveObj = qs('#obj-love');
const loveStriker = qs('#loveStriker');
const globalFlame = qs('#globalFlame');
const FLAME_WORDS = ['forever','always','yours','warmth','june 21','us','home','still'];
let wordIdx = 0;
let struck = false;
let strikeStartX = 0, strikeStartY = 0;
let flameOn = false;
let extinguishTimer = null;

loveStriker?.addEventListener('pointerdown', e => {
  if (isMobileLayout()) return; // mobile uses tap-to-light instead
  if (state !== STATE.IDLE) return;
  state = STATE.DRAG_STRIKE;
  strikeStartX = e.clientX;
  strikeStartY = e.clientY;
  struck = false;
  try { loveStriker.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
});

/* Mobile tap-to-light: single tap on striker strip */
loveStriker?.addEventListener('click', e => {
  if (!isMobileLayout()) return;
  if (flameOn) return;
  e.stopPropagation();
  const rect = loveStriker.getBoundingClientRect();
  lightFlame(rect.left + rect.width / 2, rect.top + rect.height / 2);
});
function moveStrikeDrag(clientX, clientY) {
  if (struck) return;
  const dx = clientX - strikeStartX;
  const dy = Math.abs(clientY - strikeStartY);
  /* Require mostly horizontal motion of ≥50px and less than 30px vertical drift */
  if (Math.abs(dx) > 50 && dy < 30) {
    struck = true;
    lightFlame(clientX, clientY);
    endStrikeDrag();
  }
}
function endStrikeDrag() { state = STATE.IDLE; }

function lightFlame(x, y) {
  globalFlame.style.left = (x - 10) + 'px';
  globalFlame.style.top  = (y - 35) + 'px';
  globalFlame.classList.add('is-on');
  flameOn = true;
  playStrike();

  const word = document.createElement('div');
  word.className = 'flame-word';
  const w = FLAME_WORDS[wordIdx % FLAME_WORDS.length];
  word.textContent = w;
  wordIdx++;
  word.style.left = x + 'px';
  word.style.top  = (y - 40) + 'px';
  document.body.appendChild(word);
  announce(w);
  later(() => word.remove(), 1900);

  if (extinguishTimer) clearTimeout(extinguishTimer);
  extinguishTimer = later(() => {
    globalFlame.classList.remove('is-on');
    flameOn = false;
    struck = false;
    extinguishTimer = null;
  }, 3000);
}

loveObj.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && !flameOn) {
    e.preventDefault();
    const rect = loveObj.getBoundingClientRect();
    lightFlame(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
});

/* ══════════════════════════════════════════
   J+C NOTE MODAL — peak-moment focus
══════════════════════════════════════════ */
const jcObj = qs('#obj-jc');
const noteModal = qs('#noteModal');
const focusDim = qs('#focusDim');
const noteModalCtrl = initModal(noteModal);

function enterPeak(targetEl) {
  scene.classList.add('is-peak');
  focusDim.classList.add('is-on');
  if (targetEl) targetEl.classList.add('is-peak-target');
}
function exitPeak() {
  scene.classList.remove('is-peak');
  focusDim.classList.remove('is-on');
  qsa('.is-peak-target').forEach(e => e.classList.remove('is-peak-target'));
}

jcObj.addEventListener('click', e => {
  if (objDragMoved) return;
  enterPeak(jcObj);
  noteModalCtrl.open();
});
jcObj.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    enterPeak(jcObj);
    noteModalCtrl.open();
  }
});

/* Intercept close so we can exit peak */
noteModal.addEventListener('click', e => {
  if (e.target.matches('[data-close]') || e.target === noteModal) {
    exitPeak();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && noteModal.classList.contains('is-open')) {
    exitPeak();
  }
});

/* ══════════════════════════════════════════
   POLAROID — double-tap to flip, peak moment
══════════════════════════════════════════ */
const polaroidObj = qs('#obj-polaroid');
const polaroid    = qs('#polaroid');
let polaroidFlipped = false;

/* Use dblclick for clear semantics; single click is reserved for drag start */
polaroid?.addEventListener('dblclick', e => {
  e.stopPropagation();
  togglePolaroid();
});
/* Mobile: single tap flips the polaroid — dblclick is unreliable on touch */
polaroid?.addEventListener('click', e => {
  if (!isMobileLayout()) return;
  e.stopPropagation();
  togglePolaroid();
});
polaroidObj?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    togglePolaroid();
  }
});
function togglePolaroid() {
  polaroidFlipped = !polaroidFlipped;
  polaroid.classList.toggle('is-flipped', polaroidFlipped);
  playSlide();
  if (polaroidFlipped) {
    enterPeak(polaroidObj);
    later(() => exitPeak(), 5200);
  } else {
    exitPeak();
  }
}

/* ══════════════════════════════════════════
   JAR — double-click to tip
══════════════════════════════════════════ */
const jar = qs('#jar');
const spilled = qs('#spilled');
let jarTipped = false;
const jarWrapEl = qs('[data-tap="jar"]');

jarWrapEl.addEventListener('dblclick', e => {
  if (jarTipped) return;
  e.stopPropagation();
  tipJar();
});
/* Mobile: single tap tips the jar — dblclick is unreliable on touch */
jarWrapEl.addEventListener('click', e => {
  if (!isMobileLayout()) return;
  if (jarTipped) return;
  e.stopPropagation();
  tipJar();
});
qs('#obj-jar').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && !jarTipped) {
    e.preventDefault();
    tipJar();
  }
});

function tipJar() {
  jarTipped = true;
  jar.classList.add('is-tipped');
  playSlide();

  const words = ['2023','june','us','always','more','still','warm'];
  for (let i = 0; i < 7; i++) {
    const m = document.createElement('div');
    m.className = 'spilled-match';
    m.innerHTML = '<div class="match-head"></div>';
    const angle = -120 + i * 25 + (Math.random() * 15 - 7);
    const dist  = 20 + i * 12 + Math.random() * 10;
    const ex = 40 + Math.cos(angle * Math.PI / 180) * dist;
    const ey = -10 + Math.sin(angle * Math.PI / 180) * dist;
    m.style.cssText = `
      width:2px;height:${28 + Math.random() * 12}px;
      left:${ex}px;top:${ey}px;
      transform:rotate(${angle + 90}deg);
      position:absolute;`;
    spilled.appendChild(m);

    later(() => { m.style.opacity = '1'; }, i * 80 + 100);

    const head = m.querySelector('.match-head');
    if (head) {
      /* Desktop: reveal word on hover */
      head.addEventListener('mouseenter', () => {
        if (!words[i]) return;
        const w = document.createElement('div');
        w.className = 'flame-word';
        const r = m.getBoundingClientRect();
        w.style.left = r.left + 'px';
        w.style.top  = (r.top - 10) + 'px';
        w.style.color = 'rgba(245,220,160,.7)';
        w.textContent = words[i];
        document.body.appendChild(w);
        announce(words[i]);
        later(() => w.remove(), 1900);
      });
      /* Touch: reveal word on tap — same words, same animation */
      head.addEventListener('click', e => {
        if (!words[i]) return;
        e.stopPropagation();
        const w = document.createElement('div');
        w.className = 'flame-word';
        const r = m.getBoundingClientRect();
        w.style.left = r.left + 'px';
        w.style.top  = (r.top - 10) + 'px';
        w.style.color = 'rgba(245,220,160,.7)';
        w.textContent = words[i];
        document.body.appendChild(w);
        announce(words[i]);
        later(() => w.remove(), 1900);
      });
    }
  }
}

/* ══════════════════════════════════════════
   CAT — slow blink
══════════════════════════════════════════ */
const eyeL = qs('#cat-eye-l');
const eyeR = qs('#cat-eye-r');
function catBlink() {
  if (!eyeL || !eyeR) return;
  eyeL.classList.add('is-blinking');
  eyeR.classList.add('is-blinking');
  later(() => {
    eyeL.classList.remove('is-blinking');
    eyeR.classList.remove('is-blinking');
  }, 120);
  later(catBlink, 5000 + Math.random() * 7000);
}
later(catBlink, 8000);

/* ══════════════════════════════════════════
   HEARTBEAT — every ~72s
══════════════════════════════════════════ */
const hbGlow = qs('#hb-glow');
function heartbeat() {
  if (!hbGlow) return;
  hbGlow.classList.add('is-pulsing');
  later(() => hbGlow.classList.remove('is-pulsing'), 1200);
  later(heartbeat, 72000 + Math.random() * 8000);
}
later(heartbeat, 10000);

/* ══════════════════════════════════════════
   ANNIVERSARY
══════════════════════════════════════════ */
(function() {
  const today = new Date();
  const est = qs('#obj-est');
  if (!est) return;
  if (today.getMonth() === 5 && today.getDate() === 21) {
    est.style.filter = 'drop-shadow(0 0 14px rgba(255,180,80,.6)) brightness(1.18)';
    est.setAttribute('aria-label', 'est. June 21 — happy anniversary');
  }
})();

/* ══════════════════════════════════════════
   SCREEN-READER LIVE REGION
══════════════════════════════════════════ */
function announce(text) {
  if (!srLive) return;
  srLive.textContent = '';
  later(() => { srLive.textContent = text; }, 40);
}

/* ══════════════════════════════════════════
   AMBIENT AUDIO + interaction sounds
══════════════════════════════════════════ */
const soundBtn = qs('#soundBtn');
let audioCtx = null;
let ambientNodes = [];
let soundOn = false;

soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  soundBtn.classList.toggle('is-on', soundOn);
  soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  if (soundOn) startAmbient();
  else         stopAmbient();
});

function ensureCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { audioCtx = null; }
  }
  return audioCtx;
}

function startAmbient() {
  try {
    ensureCtx();
    if (!audioCtx) return;
    const master = audioCtx.createGain();
    master.gain.value = .22;
    const lpf = audioCtx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 620;
    lpf.Q.value = .7;
    master.connect(lpf);
    lpf.connect(audioCtx.destination);

    [55, 82.5, 110, 165].forEach(freq => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = .018 + Math.random() * .008;

      const lfo  = audioCtx.createOscillator();
      const lfoGain = audioCtx.createGain();
      lfo.frequency.value = .08 + Math.random() * .12;
      lfoGain.gain.value = 1.2;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start();

      osc.connect(gain);
      gain.connect(master);
      osc.start();
      ambientNodes.push(osc, gain, lfo, lfoGain);
    });
    ambientNodes.push(master, lpf);
  } catch { /* audio unavailable */ }
}

function stopAmbient() {
  ambientNodes.forEach(n => {
    try { n.stop?.(); } catch {}
    try { n.disconnect?.(); } catch {}
  });
  ambientNodes = [];
}

/* Short interaction sounds — only when ambient is on to respect user choice */
function playTick(vol = 0.05, dur = 120) {
  if (!soundOn || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1400;
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur/1000);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + dur/1000);
  } catch {}
}
function playSlide() {
  if (!soundOn || !audioCtx) return;
  try {
    /* filtered noise burst = paper slide */
    const bufLen = audioCtx.sampleRate * 0.18;
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = (Math.random()*2-1) * (1 - i/bufLen) * 0.3;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.value = 2200; filt.Q.value = 0.7;
    const g = audioCtx.createGain(); g.gain.value = 0.15;
    src.connect(filt); filt.connect(g); g.connect(audioCtx.destination);
    src.start();
  } catch {}
}
function playTear() {
  if (!soundOn || !audioCtx) return;
  try {
    const bufLen = audioCtx.sampleRate * 0.12;
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = (Math.random()*2-1) * (1 - i/bufLen) * 0.55;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'highpass'; filt.frequency.value = 1800;
    const g = audioCtx.createGain(); g.gain.value = 0.22;
    src.connect(filt); filt.connect(g); g.connect(audioCtx.destination);
    src.start();
  } catch {}
}
function playStrike() {
  if (!soundOn || !audioCtx) return;
  try {
    /* Scratch burst followed by a short soft 'whoosh' */
    const bufLen = audioCtx.sampleRate * 0.25;
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      const env = i < bufLen*0.15 ? i/(bufLen*0.15) : (1 - (i - bufLen*0.15)/(bufLen*0.85));
      d[i] = (Math.random()*2-1) * env * 0.7;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.value = 3200; filt.Q.value = 1.2;
    const g = audioCtx.createGain(); g.gain.value = 0.28;
    src.connect(filt); filt.connect(g); g.connect(audioCtx.destination);
    src.start();
  } catch {}
}

/* ══════════════════════════════════════════
   DEVICE ORIENTATION — managedRaf-wrapped
   Skipped on desktop / mobile flow layout
══════════════════════════════════════════ */
let lastGamma = 0, lastBeta = 0;
let orientationDirty = false;

const orientLoop = managedRaf(function() {
  if (!orientationDirty) return;
  if (isMobileLayout() || state !== STATE.IDLE || prefersReducedMotion()) return;
  orientationDirty = false;
  const dx = lastGamma / 30;
  const dy = lastBeta  / 30;
  objs.forEach(obj => {
    if (obj === dragEl) return;
    if (obj.classList.contains('is-peak-target')) return;
    const layer = parseFloat(obj.dataset.layer || 1);
    const base  = obj.dataset.baseTransform || '';
    obj.style.transform = base + ' translate(' + (dx * layer * 5) + 'px,' + (dy * layer * 3.5) + 'px)';
  });
});

window.addEventListener('deviceorientation', e => {
  if (isMobileLayout()) return;
  lastGamma = e.gamma || 0;
  lastBeta  = e.beta  || 0;
  orientationDirty = true;
  if (!orientLoop.running) orientLoop.start();
}, { passive: true });

})();