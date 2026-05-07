/* ═══════════════════════════════════════════════════════════
   CZARINA SYSTEM — shared.js  v5.0
   ─────────────────────────────────────────────────────────
   Architecture: four namespaced modules behind one object.

     Czarina.env    — feature detection, debug, env config
     Czarina.motion — rAF lifecycle, timer factory
     Czarina.ui     — cursor, preloader, reveal, iframes,
                      exclusive-active, modal, embed builder
     Czarina.page   — navigate, opening, hero reveal, nav

   All modules are frozen at init time; pages extend behavior
   through options, not by monkey-patching the system.

   Debug mode: ?debug=czarina in URL, or localStorage flag.
   Lifecycle events: CustomEvents on document.
═══════════════════════════════════════════════════════════ */
'use strict';

(function(root) {

/* ─────────────────────────────────────────────────────────
   0. GUARD — prevent double-init if script is loaded twice
───────────────────────────────────────────────────────── */
if (root.Czarina) return;

/* ─────────────────────────────────────────────────────────
   1. INTERNALS — not exported; used across all modules
───────────────────────────────────────────────────────── */

/** DOM helpers */
const qs  = (s, r)  => (r || document).querySelector(s);
const qsa = (s, r)  => Array.from((r || document).querySelectorAll(s));

/** HTML-escape a value before inserting into innerHTML */
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Emit a CustomEvent on document so pages can observe
 * lifecycle milestones without importing anything.
 * Payload is always { detail: { stage, ...data } }.
 */
function emit(stage, data) {
  try {
    document.dispatchEvent(new CustomEvent('czarina:lifecycle', {
      detail: Object.assign({ stage: stage }, data || {}),
      bubbles: false,
    }));
  } catch (_) { /* IE11 fallback — event fires but detail is empty */ }
}

/* ─────────────────────────────────────────────────────────
   2. ENV MODULE
   Responsible for: feature detection, debug mode, env config.
   All other modules read from Env — they never call
   matchMedia directly, which makes mocking trivial.
───────────────────────────────────────────────────────── */
const Env = (function() {

  /* Resolve debug flag once at parse time.
     Priority: URL param > localStorage > default off. */
  const _debugActive = (function() {
    try {
      if (new URLSearchParams(location.search).get('debug') === 'czarina') return true;
      if (localStorage.getItem('czarina:debug') === '1') return true;
    } catch (_) {}
    return false;
  })();

  /* Cached MediaQueryList objects — evaluated lazily. */
  const _mql = {};
  function _mq(query) {
    if (!_mql[query]) _mql[query] = window.matchMedia(query);
    return _mql[query];
  }

  /**
   * Log a debug message. No-ops unless debug mode is active.
   * level: 'info' | 'warn' | 'error'
   */
  function log(level, msg, data) {
    if (!_debugActive) return;
    const prefix = '[Czarina]';
    if (level === 'warn')  console.warn(prefix, msg, data !== undefined ? data : '');
    else if (level === 'error') console.error(prefix, msg, data !== undefined ? data : '');
    else console.log(prefix, msg, data !== undefined ? data : '');
  }

  /**
   * Assert a condition in debug mode. If the condition is
   * false a console.warn is emitted with the message.
   * In production this is a no-op.
   */
  function assert(condition, msg) {
    if (!_debugActive) return;
    if (!condition) log('warn', 'ASSERTION FAILED: ' + msg);
  }

  return Object.freeze({
    /** True when ?debug=czarina or localStorage flag is set */
    get debug() { return _debugActive; },

    /** True when (prefers-reduced-motion: reduce) matches */
    get reducedMotion() { return _mq('(prefers-reduced-motion: reduce)').matches; },

    /** True when the primary pointer is coarse (touch device) */
    get touch() { return _mq('(hover: none)').matches; },

    /** True when the page is currently hidden */
    get hidden() { return document.hidden; },

    /** Enable debug mode at runtime (stored in localStorage) */
    enableDebug() {
      try { localStorage.setItem('czarina:debug', '1'); } catch (_) {}
      log('info', 'Debug mode enabled. Reload to see all startup logs.');
    },

    /** Disable debug mode */
    disableDebug() {
      try { localStorage.removeItem('czarina:debug'); } catch (_) {}
    },

    log,
    assert,
  });
})();

/* ─────────────────────────────────────────────────────────
   3. MOTION MODULE
   Responsible for: managedRaf loops, timer factory.

   Design decisions:
   • A registry of all active loops enables a global budget
     check: if more than MAX_LOOPS are running simultaneously
     debug mode warns. We never kill loops automatically —
     the budget is a diagnostic, not a hard limit.
   • makeLater() is a factory; the module also exposes a
     global later() for short-lived one-off timers.
   • visibilitychange is registered once on the module, not
     once per loop, eliminating O(n) listeners.
───────────────────────────────────────────────────────── */
const Motion = (function() {

  const MAX_LOOPS = 6; // warn in debug if exceeded

  /* Central registry of all managed loops */
  const _registry = new Set();

  /* Single visibilitychange listener for all loops */
  document.addEventListener('visibilitychange', function() {
    _registry.forEach(function(loop) {
      if (document.hidden) loop._pause();
      else if (loop._autoResume) loop._resume();
    });
    Env.log('info', 'visibilitychange →', document.hidden ? 'paused' : 'resumed',
      '(' + _registry.size + ' loops)');
  });

  /**
   * managedRaf(tickFn, opts) → loop handle
   *
   * opts:
   *   name        — string label for debug logging (recommended)
   *   guard       — () => boolean  skips tick when false (loop stays alive)
   *   priority    — 'normal' | 'low'  (low yields one frame when tab returns)
   *   autoResume  — boolean (default true)  resume on tab-visible
   *
   * Returns: { start, stop, running, name }
   *
   * Loops do NOT start automatically — call loop.start() explicitly.
   * This makes startup order visible and intentional in each page.
   */
  function managedRaf(tickFn, opts) {
    opts = opts || {};
    var name       = opts.name       || 'unnamed';
    var guard      = opts.guard      || null;
    var priority   = opts.priority   || 'normal';
    var autoResume = opts.autoResume !== false;

    Env.assert(typeof tickFn === 'function',
      'managedRaf: tickFn must be a function (name: ' + name + ')');

    var _id = null;
    var _skippedFrame = false; // for low-priority yield on resume

    function _tick() {
      if (guard && !guard()) {
        _id = requestAnimationFrame(_tick);
        return;
      }
      tickFn();
      _id = requestAnimationFrame(_tick);
    }

    var handle = {
      name: name,
      _autoResume: autoResume,

      _pause: function() {
        if (_id === null) return;
        cancelAnimationFrame(_id);
        _id = null;
      },

      _resume: function() {
        if (_id !== null) return;
        if (priority === 'low' && !_skippedFrame) {
          // Yield one frame before resuming low-priority loops
          _skippedFrame = true;
          _id = requestAnimationFrame(function() {
            _skippedFrame = false;
            if (_id !== null) { _id = requestAnimationFrame(_tick); }
          });
          return;
        }
        _id = requestAnimationFrame(_tick);
      },

      start: function() {
        if (_id !== null) return this;
        _registry.add(this);

        if (_registry.size > MAX_LOOPS) {
          Env.log('warn',
            'managedRaf: ' + _registry.size + ' concurrent loops running. ' +
            'Budget is ' + MAX_LOOPS + '. Consider stopping unused loops. ' +
            'Active: [' + Array.from(_registry).map(function(l) { return l.name; }).join(', ') + ']'
          );
        }

        _id = requestAnimationFrame(_tick);
        Env.log('info', 'loop start →', name);
        emit('motion:start', { loop: name });
        return this;
      },

      stop: function() {
        if (_id === null) return this;
        cancelAnimationFrame(_id);
        _id = null;
        _registry.delete(this);
        Env.log('info', 'loop stop →', name);
        emit('motion:stop', { loop: name });
        return this;
      },

      get running() { return _id !== null; },
    };

    return handle;
  }

  /**
   * makeLater() → scoped timer factory
   *
   * Returns a later(fn, ms) function backed by its own Set
   * of timer IDs. Registers a single beforeunload handler
   * that cancels all pending timers from this scope.
   *
   * later.cancel(id)   — cancel one timer
   * later.cancelAll()  — cancel all timers in this scope
   * later.pending      — count of outstanding timers
   */
  function makeLater() {
    var timers = new Set();

    function later(fn, ms) {
      Env.assert(typeof fn === 'function', 'later: fn must be a function');
      var id = setTimeout(function() {
        timers.delete(id);
        fn();
      }, ms || 0);
      timers.add(id);
      return id;
    }

    later.cancel = function(id) {
      clearTimeout(id);
      timers.delete(id);
    };

    later.cancelAll = function() {
      timers.forEach(clearTimeout);
      timers.clear();
    };

    Object.defineProperty(later, 'pending', {
      get: function() { return timers.size; },
    });

    window.addEventListener('beforeunload', later.cancelAll);
    return later;
  }

  /* Module-level later for shared utilities */
  var _later = makeLater();

  return Object.freeze({
    managedRaf : managedRaf,
    makeLater  : makeLater,

    /** Module-level later — for use within shared utilities only */
    later: _later,
  });

})();

/* ─────────────────────────────────────────────────────────
   4. UI MODULE
   Responsible for: cursor, preloader, scroll reveal, lazy
   iframes, exclusive-active toggle, modal, embed builder.

   Each function is self-contained: it reads from Env,
   uses Motion.managedRaf where needed, and emits lifecycle
   events for observability. No function mutates shared state
   outside its own closure.
───────────────────────────────────────────────────────── */
const UI = (function() {

  /* ── Cursor ─────────────────────────────────────────── */

  /**
   * initCursor()
   * Creates custom cursor dot + ring elements.
   * No-ops on touch and reduced-motion.
   * Uses a managedRaf loop that only starts after the first
   * mousemove, so zero rAF cost on pages with no mouse.
   */
  function initCursor() {
    if (Env.touch || Env.reducedMotion) return;

    var dot  = document.createElement('div');
    var ring = document.createElement('div');
    dot.className  = 'cursor-dot';
    ring.className = 'cursor-ring';
    dot.setAttribute('aria-hidden', 'true');
    ring.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    document.body.appendChild(ring);

    var tx = 0, ty = 0, moved = false;

    var loop = Motion.managedRaf(function() {
      dot.style.left  = tx + 'px';
      dot.style.top   = ty + 'px';
      ring.style.left = tx + 'px';
      ring.style.top  = ty + 'px';
    }, { name: 'cursor', priority: 'normal' });

    document.addEventListener('mousemove', function(e) {
      tx = e.clientX;
      ty = e.clientY;
      if (!moved) { moved = true; loop.start(); }
    }, { passive: true });

    document.addEventListener('mouseover', function(e) {
      var hov = !!e.target.closest(
        'a, button, [role="button"], [data-hover], [tabindex]:not([tabindex="-1"])'
      );
      dot.classList.toggle('is-hover', hov);
      ring.classList.toggle('is-hover', hov);
    });

    document.addEventListener('mouseleave', function() {
      dot.style.opacity = '0';
      ring.style.opacity = '0';
      loop.stop();
    });

    document.addEventListener('mouseenter', function() {
      dot.style.opacity = '';
      ring.style.opacity = '';
      if (moved) loop.start();
    });

    /* Restore native cursor over focusable embedded elements */
    qsa('iframe, input, textarea').forEach(function(el) {
      el.addEventListener('mouseenter', function() {
        dot.style.opacity = '0'; ring.style.opacity = '0';
      });
      el.addEventListener('mouseleave', function() {
        dot.style.opacity = ''; ring.style.opacity = '';
      });
    });

    Env.log('info', 'cursor initialised');
  }

  /* ── Preloader ──────────────────────────────────────── */

  /**
   * initPreloader(opts) → Promise<void>
   *
   * opts:
   *   duration  — ms before dismissing (default 1400; 500 on repeat)
   *   fadeTime  — ms for the fade-out transition (default 1000)
   *
   * Returns a Promise that resolves after the preloader is removed.
   * Uses sessionStorage key 'czarina:preloader-seen' for repeat detection.
   */
  function initPreloader(opts) {
    opts = opts || {};
    var duration = opts.duration || 1400;
    var fadeTime = opts.fadeTime || 1000;

    var pre = qs('.preloader');
    if (!pre) {
      Env.log('info', 'initPreloader: no .preloader element found, resolving immediately');
      return Promise.resolve();
    }

    var seen = sessionStorage.getItem('czarina:preloader-seen');
    var d    = seen ? 500 : duration;

    return new Promise(function(resolve) {
      var bar = qs('.preloader-bar', pre);
      if (bar) setTimeout(function() { bar.classList.add('is-full'); }, 80);

      setTimeout(function() {
        pre.classList.add('is-done');
        sessionStorage.setItem('czarina:preloader-seen', '1');
        setTimeout(function() {
          pre.remove();
          emit('ui:preloader-done');
          Env.log('info', 'preloader done');
          resolve();
        }, fadeTime);
      }, d);
    });
  }

  /* ── Scroll reveal ──────────────────────────────────── */

  /**
   * initReveal()
   * Adds .is-revealed to .js-reveal elements as they scroll
   * into the viewport. Immediately reveals all on reduced-motion
   * or when IntersectionObserver is unavailable.
   */
  function initReveal() {
    var els = qsa('.js-reveal');
    if (!els.length) return;

    if (!('IntersectionObserver' in window) || Env.reducedMotion) {
      els.forEach(function(el) { el.classList.add('is-revealed'); });
      Env.log('info', 'initReveal: immediate (reduced-motion or no IO)');
      return;
    }

    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '-3% 0px' });

    els.forEach(function(el) { io.observe(el); });
    Env.log('info', 'initReveal: observing', els.length, 'elements');
  }

  /* ── Lazy iframes ───────────────────────────────────── */

  /**
   * initLazyIframes()
   * Loads iframe[data-src] on the first interaction with its
   * closest container. Falls back to IntersectionObserver then
   * immediate load. Handles PLACEHOLDER sentinel values.
   *
   * Container selector covers every Spotify wrapper pattern
   * used across all volume pages — add new patterns here, not
   * in individual pages.
   */
  var IFRAME_TRIGGER_SELECTOR = [
    '[data-interactive]', '.card', '.frame', '.track', '.pc-wrap',
    '.tv-card', '.sp-holder', '.spotify-wrap', '.am-sp-wrap',
    '.tv-sp-wrap', '.memory-sp', '.spotify-drawer', '.am-row',
  ].join(', ');

  function initLazyIframes() {
    qsa('iframe[data-src]').forEach(function(iframe) {
      /* Ensure title for screen readers */
      if (!iframe.title) {
        var parent = iframe.closest('[data-song]');
        iframe.title = (parent && parent.dataset.song)
          ? 'Spotify player: ' + parent.dataset.song
          : 'Spotify player';
      }

      function load() {
        if (iframe.src || !iframe.dataset.src) return;

        if (/PLACEHOLDER/i.test(iframe.dataset.src)) {
          var ph = document.createElement('div');
          ph.className = 'iframe-placeholder';
          ph.innerHTML = '<span>track \u00b7 coming soon</span>';
          iframe.replaceWith(ph);
          return;
        }

        iframe.src = iframe.dataset.src;
        Env.log('info', 'iframe loaded →', iframe.title);
      }

      var trigger = iframe.closest(IFRAME_TRIGGER_SELECTOR);

      if (trigger) {
        trigger.addEventListener('mouseenter', load, { once: true });
        trigger.addEventListener('focusin',    load, { once: true });
        trigger.addEventListener('touchstart', load, { once: true, passive: true });
      } else if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function(entries) {
          entries.forEach(function(e) {
            if (e.isIntersecting) { load(); io.unobserve(iframe); }
          });
        }, { rootMargin: '200px' });
        io.observe(iframe);
      } else {
        load();
      }
    });
  }

  /* ── Exclusive active toggle ────────────────────────── */

  /**
   * initExclusiveActive(selector, opts) → { toggle, deactivateAll }
   *
   * Handles the repeated pattern of toggling .is-active on one
   * element at a time while deactivating all siblings.
   * Binds touchstart (always) and keyboard Enter/Space (opt-in).
   *
   * opts:
   *   groupSelector  — sibling scope (defaults to selector)
   *   ariaAttr       — aria attribute to mirror state e.g. 'aria-expanded'
   *   onActivate(el, isNowActive) — callback for side effects
   *   keyboard       — boolean (default true)
   */
  function initExclusiveActive(selector, opts) {
    opts = opts || {};
    var groupSel   = opts.groupSelector || selector;
    var ariaAttr   = opts.ariaAttr   || null;
    var onActivate = opts.onActivate || null;
    var keyboard   = opts.keyboard !== false;

    var items = qsa(selector);
    if (!items.length) {
      Env.log('warn', 'initExclusiveActive: no elements matched "' + selector + '"');
      return { toggle: function() {}, deactivateAll: function() {} };
    }

    function deactivateAll(except) {
      qsa(groupSel).forEach(function(el) {
        if (el === except) return;
        if (!el.classList.contains('is-active')) return;
        el.classList.remove('is-active');
        if (ariaAttr) el.setAttribute(ariaAttr, 'false');
        if (onActivate) onActivate(el, false);
      });
    }

    function toggle(el) {
      var next = !el.classList.contains('is-active');
      deactivateAll(next ? el : null);
      el.classList.toggle('is-active', next);
      if (ariaAttr) el.setAttribute(ariaAttr, next ? 'true' : 'false');
      if (onActivate) onActivate(el, next);
      Env.log('info', 'exclusive-active toggle →',
        el.className.split(' ')[0], '| active:', next);
    }

    items.forEach(function(el) {
      el.addEventListener('touchstart', function() { toggle(el); }, { passive: true });
      if (keyboard) {
        el.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(el);
          }
        });
      }
    });

    Env.log('info', 'initExclusiveActive: bound', items.length, 'items for "' + selector + '"');
    return { toggle: toggle, deactivateAll: deactivateAll };
  }

  /* ── Modal ──────────────────────────────────────────── */

  /**
   * initModal(el) → { open, close }
   *
   * Full focus-trap modal with Escape close, backdrop click,
   * [data-close] buttons, and focus restoration on close.
   * Emits 'czarina:lifecycle' events for open and close.
   */
  function initModal(el) {
    if (!el) {
      Env.log('warn', 'initModal: called with null element');
      return { open: function() {}, close: function() {} };
    }

    var lastFocus = null;
    var FOCUSABLE = 'button, a, input, textarea, [tabindex]:not([tabindex="-1"])';

    function open() {
      lastFocus = document.activeElement;
      el.classList.add('is-open');
      el.setAttribute('aria-hidden', 'false');
      var first = el.querySelector(FOCUSABLE);
      if (first) first.focus();
      document.addEventListener('keydown', _handleKey);
      emit('ui:modal-open', { id: el.id || '(no id)' });
      Env.log('info', 'modal open →', el.id || '(no id)');
    }

    function close() {
      el.classList.remove('is-open');
      el.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', _handleKey);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      emit('ui:modal-close', { id: el.id || '(no id)' });
      Env.log('info', 'modal close →', el.id || '(no id)');
    }

    function _handleKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        var focusable = qsa(FOCUSABLE, el).filter(function(x) { return !x.disabled; });
        if (!focusable.length) return;
        var first = focusable[0];
        var last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }

    el.addEventListener('click', function(e) { if (e.target === el) close(); });
    qsa('[data-close]', el).forEach(function(btn) {
      btn.addEventListener('click', close);
    });

    return { open: open, close: close };
  }

  /* ── Spotify embed builder ──────────────────────────── */

  /**
   * buildSpotifyEmbed(url, songTitle, opts) → HTML string
   *
   * Produces either a lazy-loaded Spotify iframe or a
   * placeholder div. Safe to set as innerHTML.
   *
   * opts.height — iframe height in px (default 80)
   */
  function buildSpotifyEmbed(url, songTitle, opts) {
    var height = (opts && opts.height) ? opts.height : 80;
    if (!url) {
      return '<div class="iframe-placeholder">'
        + '<span>track \u00b7 coming soon</span></div>';
    }
    Env.assert(url.startsWith('https://open.spotify.com/embed/'),
      'buildSpotifyEmbed: URL does not look like a Spotify embed URL: ' + url);
    return '<iframe data-src="' + esc(url) + '"'
      + ' title="Spotify player: ' + esc(songTitle) + '"'
      + ' width="100%" height="' + height + '" loading="lazy"'
      + ' allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture">'
      + '</iframe>';
  }

  return Object.freeze({
    initCursor,
    initPreloader,
    initReveal,
    initLazyIframes,
    initExclusiveActive,
    initModal,
    buildSpotifyEmbed,
    IFRAME_TRIGGER_SELECTOR,
  });

})();

/* ─────────────────────────────────────────────────────────
   5. PAGE MODULE
   Responsible for: navigation, opening sequence, hero reveal,
   volume nav, back nav, click nav.

   Design decisions:
   • navigate() is the single exit point for all page changes.
     Pages call navigate(); they do not touch window.location.
   • The touch+click double-fire guard is internal state in
     Page, exposed as markTouchNavigated() / isTouchNavigating()
     for index.html's touch handler which must record the event
     before the setTimeout fires.
   • initOpening and initHeroReveal represent the two lifecycle
     phases (intro → content) that every page goes through in
     sequence. Both emit lifecycle events.
───────────────────────────────────────────────────────── */
const Page = (function() {

  /* ── Volume manifest ────────────────────────────────── */

  const VOLUMES = [
    { id: 1, vol: 'I',   href: 'czarina.html',      artist: 'Cigarettes After Sex' },
    { id: 2, vol: 'II',  href: 'czarina-vol2.html', artist: 'Daniel Caesar'        },
    { id: 3, vol: 'III', href: 'czarina-vol3.html', artist: 'Mac DeMarco'          },
    { id: 4, vol: 'IV',  href: 'czarina-vol4.html', artist: 'The 1975'             },
    { id: 5, vol: 'V',   href: 'czarina-vol5.html', artist: 'Frank Ocean'          },
    { id: 6, vol: 'VI',  href: 'czarina-vol6.html', artist: 'The Neighbourhood'    },
    { id: 7, vol: 'VII', href: 'czarina-vol7.html', artist: 'Arctic Monkeys'       },
  ];

  /* ── Opening timing constants ───────────────────────── */

  /**
   * Canonical timing values shared between index.html and
   * matchbox.js. One place to change the feel of the intro.
   *
   * First visit:  ~1350ms of visible text, 2200ms total overlay
   * Repeat visit:  ~250ms of visible text,  700ms total overlay
   */
  const OPENING_TIMING = Object.freeze({
    firstTotal:    3200,
    firstFadeOut:  2400,
    repeatTotal:    700,
    repeatFadeOut:  400,
    textFadeIn:     150,
    removePause:    950,
  });

  /* ── Navigate ───────────────────────────────────────── */

  /* Touch+click double-fire guard.
     When a touch navigation fires, the browser synthesises
     a click ~300ms later. This guard suppresses it. */
  var _lastTouchNavAt = 0;

  function markTouchNavigated() {
    _lastTouchNavAt = Date.now();
  }

  function isTouchNavigating() {
    return Date.now() - _lastTouchNavAt < 600;
  }

  /**
   * navigate(url, event)
   *
   * The single exit point for all inter-page navigation.
   * • Creates a ripple from the event coordinates.
   * • Uses View Transitions API where available.
   * • Falls back to a .page-overlay fade.
   * • No-ops on same URL and hash-only anchors.
   */
  function navigate(url, event) {
    if (!url) return;
    if (url === '#' || url === location.href) return;

    Env.log('info', 'navigate →', url);
    emit('page:navigate', { url: url });

    /* Ripple from pointer coordinates */
    if (event && typeof event.clientX === 'number' && !Env.reducedMotion) {
      var r = document.createElement('div');
      r.style.cssText =
        'position:fixed; left:' + event.clientX + 'px; top:' + event.clientY + 'px;'
        + 'width:8px; height:8px; border-radius:50%;'
        + 'background:rgba(255,210,140,.15); pointer-events:none;'
        + 'transform:translate(-50%,-50%) scale(0);'
        + 'animation: ripple 700ms var(--ease-out) forwards;'
        + 'z-index:8999;';
      document.body.appendChild(r);
      r.addEventListener('animationend', function() { r.remove(); });
    }

    /* View Transitions (Chrome 111+) */
    if ('startViewTransition' in document && !Env.reducedMotion) {
      document.startViewTransition(function() {
        window.location.href = url;
      });
      return;
    }

    /* Overlay fallback */
    var overlay = qs('.page-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'page-overlay';
      document.body.appendChild(overlay);
    }
    setTimeout(function() { overlay.classList.add('is-on'); }, 200);
    setTimeout(function() { window.location.href = url; }, 520);
  }

  /* ── Click nav ──────────────────────────────────────── */

  /**
   * initClickNav()
   * Wires [data-transition] anchor clicks to navigate(),
   * suppressing the click if it fires within 600ms of a
   * touch navigation (Android double-fire guard).
   *
   * Called automatically in DOMContentLoaded. Pages do not
   * need to call this explicitly.
   */
  function initClickNav() {
    document.addEventListener('click', function(e) {
      if (isTouchNavigating()) {
        Env.log('info', 'click nav suppressed (touch guard active)');
        return;
      }
      var link = e.target.closest('[data-transition]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      navigate(href, e);
    });
    Env.log('info', 'initClickNav: bound');
  }

  /* ── Back nav ───────────────────────────────────────── */

  /**
   * initBackNav()
   * Wires [data-action="back"] elements to navigate().
   * Uses data-href attribute for target; defaults to index.html.
   */
  function initBackNav() {
    qsa('[data-action="back"]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        navigate(btn.dataset.href || 'index.html', e);
      });
    });
  }

  /* ── Volume nav ─────────────────────────────────────── */

  /**
   * initVolumeNav()
   * Finds the current page in VOLUMES and wires prev/next
   * buttons and arrow key shortcuts. No-ops on non-volume pages.
   */
  function initVolumeNav() {
    var page = location.pathname.split('/').pop() || 'index.html';
    var idx  = VOLUMES.findIndex(function(v) { return v.href === page; });
    if (idx === -1) {
      Env.log('info', 'initVolumeNav: not a volume page, skipping');
      return;
    }

    var prev = VOLUMES[idx - 1];
    var next = VOLUMES[idx + 1];

    Env.log('info', 'initVolumeNav: vol', VOLUMES[idx].vol,
      '| prev:', prev ? prev.artist : 'none',
      '| next:', next ? next.artist : 'none');

    var nav = qs('.vol-nav');
    if (nav) {
      var prevBtn = qs('[data-vol-prev]', nav);
      var nextBtn = qs('[data-vol-next]', nav);

      if (prevBtn) {
        prevBtn.setAttribute('aria-label',
          prev ? 'Previous volume: ' + prev.artist : 'No previous volume');
        if (prev) prevBtn.addEventListener('click', function(e) { navigate(prev.href, e); });
        else prevBtn.disabled = true;
      }
      if (nextBtn) {
        nextBtn.setAttribute('aria-label',
          next ? 'Next volume: ' + next.artist : 'No next volume');
        if (next) nextBtn.addEventListener('click', function(e) { navigate(next.href, e); });
        else nextBtn.disabled = true;
      }
    }

    /* Arrow key shortcuts (Left/Right = prev/next, Escape = index) */
    document.addEventListener('keydown', function(e) {
      if (e.target.matches('input, textarea, [contenteditable]')) return;
      if      (e.key === 'ArrowLeft'  && prev) { e.preventDefault(); navigate(prev.href); }
      else if (e.key === 'ArrowRight' && next) { e.preventDefault(); navigate(next.href); }
      else if (e.key === 'Escape' && !qs('[role="dialog"].is-open')) {
        e.preventDefault(); navigate('index.html');
      }
    });
  }

  /* ── Opening sequence ───────────────────────────────── */

  /**
   * initOpening(opts)
   *
   * Runs the full-screen intro overlay lifecycle:
   *   1. Show scene immediately beneath overlay
   *   2. Fade text in, then out
   *   3. Dismiss overlay, remove from DOM
   *   4. Call onDone
   *
   * opts:
   *   sessionKey  — sessionStorage key for repeat detection (required)
   *   openingEl   — the overlay element (required)
   *   sceneEl     — element to show immediately
   *   textEls     — [{ el, delay? }] text elements to animate
   *   hintEl      — element to show immediately
   *   hintClass   — class to add to hintEl (default 'is-on')
   *   onDone      — callback after overlay is removed
   *
   * Emits: 'czarina:lifecycle' { stage: 'page:opening-start' }
   *        'czarina:lifecycle' { stage: 'page:opening-done' }
   */
  function initOpening(opts) {
    opts = opts || {};
    Env.assert(opts.sessionKey, 'initOpening: sessionKey is required');
    Env.assert(opts.openingEl,  'initOpening: openingEl is required');

    var sessionKey = opts.sessionKey;
    var openingEl  = opts.openingEl;
    var sceneEl    = opts.sceneEl   || null;
    var textEls    = opts.textEls   || [];
    var hintEl     = opts.hintEl    || null;
    var hintClass  = opts.hintClass || 'is-on';
    var onDone     = opts.onDone    || null;

    var seen    = sessionStorage.getItem(sessionKey);
    var T       = OPENING_TIMING;
    var total   = seen ? T.repeatTotal   : T.firstTotal;
    var fadeOut = seen ? T.repeatFadeOut : T.firstFadeOut;

    var L = Motion.later; // use module-level later

    Env.log('info', 'initOpening start | seen:', !!seen, '| total:', total + 'ms');
    emit('page:opening-start', { seen: !!seen, duration: total });

    /* Scene visible immediately beneath overlay */
    if (sceneEl) sceneEl.classList.add('is-visible');
    if (hintEl)  hintEl.classList.add(hintClass);

    /* Stagger text elements in and out */
    textEls.forEach(function(item) {
      var el    = item.el;
      var delay = item.delay || 0;
      if (!el) {
        Env.log('warn', 'initOpening: textEls entry has no .el');
        return;
      }
      L(function() { el.classList.add('is-visible'); },    T.textFadeIn + delay);
      L(function() { el.classList.remove('is-visible'); }, fadeOut      + delay);
    });

    /* Dismiss overlay */
    L(function() {
      openingEl.classList.add('is-gone');
      sessionStorage.setItem(sessionKey, '1');
      L(function() {
        openingEl.remove();
        emit('page:opening-done');
        Env.log('info', 'initOpening done');
        if (onDone) onDone();
      }, T.removePause);
    }, total);
  }

  /* ── Hero reveal ────────────────────────────────────── */

  /**
   * initHeroReveal(opts) → Promise<void>
   *
   * Runs the preloader then reveals hero elements.
   * Every volume page calls this instead of chaining
   * initPreloader manually.
   *
   * opts:
   *   duration  — preloader duration ms (default 1400)
   *   reveals   — [{ el, cls?, delay? }]
   *                 el    — element to reveal
   *                 cls   — class to add (default 'is-on')
   *                 delay — ms after preloader done (default 0)
   *
   * Returns the Promise so callers can .then() for extra work.
   *
   * Emits: 'czarina:lifecycle' { stage: 'page:hero-reveal' }
   */
  function initHeroReveal(opts) {
    opts = opts || {};
    var duration = opts.duration || 1400;
    var reveals  = opts.reveals  || [];

    return UI.initPreloader({ duration: duration }).then(function() {
      reveals.forEach(function(item) {
        var el    = item.el;
        var cls   = item.cls   || 'is-on';
        var delay = item.delay || 0;
        if (!el) {
          Env.log('warn', 'initHeroReveal: reveals entry has no .el');
          return;
        }
        if (delay === 0) {
          el.classList.add(cls);
        } else {
          setTimeout(function() { el.classList.add(cls); }, delay);
        }
      });
      emit('page:hero-reveal', { count: reveals.length });
      Env.log('info', 'hero reveal complete | elements:', reveals.length);
    });
  }

  return Object.freeze({
    VOLUMES,
    OPENING_TIMING,
    navigate,
    markTouchNavigated,
    isTouchNavigating,
    initClickNav,
    initBackNav,
    initVolumeNav,
    initOpening,
    initHeroReveal,
  });

})();

/* ─────────────────────────────────────────────────────────
   6. BOOT — DOMContentLoaded auto-init
   Runs the four always-on subsystems. Pages extend behavior
   by calling additional methods after the script loads.
───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  Env.log('info', '─── Czarina System boot ───');
  Env.log('info', 'debug:', Env.debug, '| touch:', Env.touch,
    '| reducedMotion:', Env.reducedMotion);

  UI.initCursor();
  UI.initLazyIframes();
  UI.initReveal();
  Page.initBackNav();
  Page.initVolumeNav();
  Page.initClickNav();

  emit('system:ready');
  Env.log('info', 'system:ready');
});

/* ─────────────────────────────────────────────────────────
   7. PUBLIC API
   Namespaced under window.Czarina (primary).
   window.CzarinaSystem is kept as a flat compatibility alias
   so all existing page destructures continue to work without
   any changes to those files.
───────────────────────────────────────────────────────── */
var Czarina = Object.freeze({
  /** Environment — feature detection, debug, logging */
  env: Env,

  /** Motion — rAF lifecycle, timers */
  motion: Motion,

  /** UI — cursor, preloader, reveal, iframes, components */
  ui: UI,

  /** Page — navigation, opening, hero reveal, nav systems */
  page: Page,
});

root.Czarina = Czarina;

/* ── Flat compatibility shim (window.CzarinaSystem) ── */
/* All existing page scripts destructure from CzarinaSystem.
   This alias maps every previously-exported name to the new
   namespaced location so pages work without modification. */
root.CzarinaSystem = Object.freeze({
  /* manifest + helpers */
  VOLUMES              : Page.VOLUMES,
  qs                   : qs,
  qsa                  : qsa,
  esc                  : esc,
  prefersReducedMotion : function() { return Env.reducedMotion; },
  isTouch              : function() { return Env.touch; },

  /* motion */
  later                : Motion.later,
  makeLater            : Motion.makeLater,
  managedRaf           : Motion.managedRaf,

  /* ui */
  initExclusiveActive  : UI.initExclusiveActive,
  buildSpotifyEmbed    : UI.buildSpotifyEmbed,
  initCursor           : UI.initCursor,
  initPreloader        : UI.initPreloader,
  initLazyIframes      : UI.initLazyIframes,
  initReveal           : UI.initReveal,
  initModal            : UI.initModal,

  /* page */
  OPENING_TIMING       : Page.OPENING_TIMING,
  initOpening          : Page.initOpening,
  initHeroReveal       : Page.initHeroReveal,
  navigate             : Page.navigate,
  markTouchNavigated   : Page.markTouchNavigated,
  isTouchNavigating    : Page.isTouchNavigating,
  initClickNav         : Page.initClickNav,
  initBackNav          : Page.initBackNav,
  initVolumeNav        : Page.initVolumeNav,
});

})(window);