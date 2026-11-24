// darkmode.js - True Dynamic Perceptual Dark Mode Engine
// Preserves actual colors on buttons, badges, images, videos, and colored icons
// while making every background, text, border, and monochrome icon crisp and visible.
(() => {
  if (window.__arDarkModeLoaded) {
    // Already running in this document; trigger a fresh sync if re-injected
    window.dispatchEvent(new CustomEvent('__ar_dm_resync'));
    return;
  }
  window.__arDarkModeLoaded = true;

  const STORAGE_KEY = 'darkModeConfig';
  const BASE_STYLE_ID = '__ar-dm-base-style';
  const FILTER_STYLE_ID = '__ar-dm-filter-style';
  const SVG_FILTERS_ID = '__ar-dm-svg-filters';
  const ALPHA_LIFT_FILTER_ID = '__ar-dm-alpha-lift';
  const TOAST_ID = '__ar-dm-toast';
  const FAST_CACHE_KEY = '__ar_dm_fast_v2';

  const DEFAULT_CONFIG = {
    enabled: false,
    mode: 'smart', // 'smart' | 'amoled' | 'dim'
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    dimImages: false,
    skipNativeDark: true,
    followSystem: false,
    scheduleEnabled: false,
    scheduleStart: '19:00',
    scheduleEnd: '07:00',
    shortcut: {
      ctrlKey: false,
      altKey: true,
      shiftKey: true,
      metaKey: false,
      code: 'KeyD',
      key: 'D',
      label: 'Alt+Shift+D'
    },
    siteRules: {},
    pageRules: {}
  };

  const MULTI_PART_TLDS = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
    'com.au', 'net.au', 'org.au', 'edu.au',
    'com.bd', 'org.bd', 'net.bd', 'edu.bd', 'gov.bd',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
    'co.in', 'net.in', 'org.in', 'ac.in',
    'com.br', 'com.mx', 'com.cn', 'com.sg', 'com.hk', 'com.tw', 'co.nz', 'co.za', 'co.kr'
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'HEAD', 'TITLE',
    'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'TEMPLATE'
  ]);

  const SVG_SHAPE_TAGS = new Set([
    'svg', 'path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line', 'g', 'use', 'stop'
  ]);

  const STYLE_PROPS_TRACKED = [
    'background-color',
    'background-image',
    'color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'box-shadow',
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-opacity',
    'stop-color',
    'stop-opacity',
    'opacity',
    'mix-blend-mode',
    'isolation',
    'filter'
  ];

  let currentConfig = { ...DEFAULT_CONFIG };
  let isNativeDark = false;
  let currentlyApplied = false;
  let appliedMode = null;
  let lastUrl = location.href;
  let toastTimer = null;
  let isInternalMutation = false;

  // Reversible state tracking for instant, zero-refresh toggle off
  const originalInlineStyles = new WeakMap();
  const originalImgSrcs = new WeakMap();
  const modifiedElements = new Set();
  const elementContextMap = new WeakMap(); // el -> { keepText: boolean, bgLum: number }
  const observedRoots = new Set();
  const activeObservers = new Set();
  const imgProbeCache = new Map(); // src -> { kind, dataUri } | 'pending'
  const imgProbeWaiters = new Map(); // src -> Set<Element>

  // Batched processing queue: Map<Element, boolean> (value = forceReeval)
  const pendingElements = new Map();
  let rafHandle = 0;
  let headObserver = null;
  let rescanDebounceTimer = 0;
  let settleTimers = [];

  function clearSettleTimers() {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [];
    if (rescanDebounceTimer) {
      clearTimeout(rescanDebounceTimer);
      rescanDebounceTimer = 0;
    }
  }

  const isTopFrame = (() => {
    try {
      return window.self === window.top;
    } catch {
      return false;
    }
  })();

  // ---- Domain & Rule Matching ----

  function getMainDomain(hostname) {
    const clean = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (!clean || /^(\d+\.){3}\d+$/.test(clean) || clean === 'localhost' || !clean.includes('.')) {
      return clean;
    }
    const parts = clean.split('.');
    if (parts.length <= 2) return clean;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  }

  function getHostKey() {
    try {
      return location.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function getPageKey() {
    try {
      let path = location.pathname || '/';
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      return location.origin.toLowerCase() + path;
    } catch {
      return '';
    }
  }

  function findSiteRule(siteRules, hostKey) {
    if (!siteRules || !hostKey) return null;
    if (siteRules[hostKey]) return { key: hostKey, value: siteRules[hostKey] };
    const noWww = hostKey.replace(/^www\./, '');
    if (siteRules[noWww]) return { key: noWww, value: siteRules[noWww] };
    const mainDomain = getMainDomain(hostKey);
    if (mainDomain && siteRules[mainDomain]) {
      return { key: mainDomain, value: siteRules[mainDomain] };
    }
    const parts = noWww.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (siteRules[candidate]) return { key: candidate, value: siteRules[candidate] };
    }
    return null;
  }

  function isWithinSchedule(startStr, endStr) {
    const parseMins = (s) => {
      const [h, m] = String(s || '00:00').split(':').map(Number);
      return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
    };
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = parseMins(startStr);
    const end = parseMins(endStr);
    if (start === end) return true;
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  // ---- Perceptual Color Math ----

  function parseRgba(str) {
    if (!str || str === 'none' || str === 'transparent') return null;
    const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/i);
    if (!m) return null;
    const r = Math.max(0, Math.min(255, parseFloat(m[1])));
    const g = Math.max(0, Math.min(255, parseFloat(m[2])));
    const b = Math.max(0, Math.min(255, parseFloat(m[3])));
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
    return { r, g, b, a };
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) h = ((bn - rn) / d + 2) * 60;
      else h = ((rn - gn) / d + 4) * 60;
    }
    return { h, s, l, chroma: d };
  }

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; }
    else if (h < 120) { r1 = x; g1 = c; }
    else if (h < 180) { g1 = c; b1 = x; }
    else if (h < 240) { g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function relativeLuminance(r, g, b) {
    const lin = (v) => {
      const n = v / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function formatRgba(r, g, b, a) {
    return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }

  // Classify and transform a background color.
  // Pure Solid Black (#000000) is the default ('smart' / 'amoled'), with 'charcoal' as soft dark gray.
  // Returns { changed, css, keepText, bgLum }
  function transformBackgroundColor(rgba, isPureBlack, isInteractiveButton) {
    if (!rgba || rgba.a < 0.05) {
      return { changed: false, css: null, keepText: false, bgLum: null };
    }
    const { h, s, l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);
    const origLum = relativeLuminance(rgba.r, rgba.g, rgba.b);

    // 1. Vibrant / colored buttons, badges, brand headers, status pills -> KEEP 100% ACTUAL COLOR!
    const chromaThreshold = isInteractiveButton ? 0.14 : 0.19;
    if (chroma >= chromaThreshold && l <= 0.76) {
      return { changed: false, css: null, keepText: true, bgLum: origLum };
    }

    // 2. Already dark background -> keep unchanged, and preserve its foreground text!
    if (l <= 0.28) {
      // If a dark surface has very low alpha (e.g. rgba(0,0,0,0.08) subtle gray card/shape on white),
      // invert it into a visible subtle light tint on pure black so it never disappears!
      if (rgba.a <= 0.32 && chroma < 0.15) {
        const liftedAlpha = Math.min(0.32, rgba.a * 1.9 + 0.07);
        return {
          changed: true,
          css: formatRgba(235, 238, 246, liftedAlpha),
          keepText: false,
          bgLum: liftedAlpha * 0.18
        };
      }
      return { changed: false, css: null, keepText: true, bgLum: origLum };
    }

    // 3. Light pastel / tinted alert surface (e.g., Apple light-blue info banner #eaf4ff, light-red alert)
    if (l > 0.72 && chroma >= 0.04) {
      const targetL = isPureBlack
        ? 0.14 + (1 - l) * 0.28
        : 0.16 + (1 - l) * 0.26;
      const targetS = Math.max(0.28, Math.min(0.60, s * 0.65));
      const rgb = hslToRgb(h, targetS, Math.min(0.26, targetL));
      return {
        changed: true,
        css: formatRgba(rgb.r, rgb.g, rgb.b, rgba.a),
        keepText: false,
        bgLum: relativeLuminance(rgb.r, rgb.g, rgb.b)
      };
    }

    // 4. Light neutral surface (white, off-white, light gray) -> Pure solid #000000 base
    if (l > 0.50) {
      if (isPureBlack) {
        // Pure solid #000000 for page backgrounds, outer margins, off-white & light gray wrappers
        if (l >= 0.82) {
          return {
            changed: true,
            css: formatRgba(0, 0, 0, rgba.a),
            keepText: false,
            bgLum: 0
          };
        }
        // Slightly elevated dark slate (#0d0f14) for cards
        const inv = 1 - l;
        const targetL = Math.min(0.12, 0.04 + inv * 0.15);
        const rgb = hslToRgb(225, 0.08, targetL);
        return {
          changed: true,
          css: formatRgba(rgb.r, rgb.g, rgb.b, rgba.a),
          keepText: false,
          bgLum: relativeLuminance(rgb.r, rgb.g, rgb.b)
        };
      } else {
        // Soft Charcoal mode
        const inv = 1 - l;
        const targetL = Math.min(0.27, 0.085 + inv * 0.38);
        const targetS = s > 0.03 ? Math.min(0.14, s * 0.45) : 0.08;
        const targetH = s > 0.03 ? h : 225;
        const rgb = hslToRgb(targetH, targetS, targetL);
        return {
          changed: true,
          css: formatRgba(rgb.r, rgb.g, rgb.b, rgba.a),
          keepText: false,
          bgLum: relativeLuminance(rgb.r, rgb.g, rgb.b)
        };
      }
    }

    // 5. Mid-gray neutral surface (0.28 < l <= 0.50)
    if (chroma < 0.14) {
      const targetL = isPureBlack ? Math.max(0.08, l * 0.35) : Math.max(0.17, l * 0.58);
      const rgb = hslToRgb(h, Math.min(0.12, s), targetL);
      return {
        changed: true,
        css: formatRgba(rgb.r, rgb.g, rgb.b, rgba.a),
        keepText: false,
        bgLum: relativeLuminance(rgb.r, rgb.g, rgb.b)
      };
    }

    // Saturated mid-dark tone -> preserve actual color
    return { changed: false, css: null, keepText: true, bgLum: origLum };
  }

  // Transform text or monochrome icon foreground color for full visibility on dark surfaces
  function transformForegroundColor(rgba, keepText, bgLum) {
    if (!rgba || rgba.a < 0.05) return null;

    const { h, s, l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);
    const lum = relativeLuminance(rgba.r, rgba.g, rgba.b);
    const effectiveBgLum = typeof bgLum === 'number' ? bgLum : 0.015;

    // Inside a preserved colored button/badge or bright banner:
    // Only keep exact original text if the background itself is actually bright enough
    if (keepText && effectiveBgLum > 0.18) {
      return null;
    }

    // Contrast ratio helper (WCAG)
    const contrastRatio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    // Already well-visible light or bright color on dark surface -> keep exact original color!
    if (contrastRatio(lum, effectiveBgLum) >= 4.5 && l >= 0.55) {
      return null;
    }

    // Colored text / links / colored icons (blue links, red errors, green statuses, orange warnings)
    if (chroma >= 0.14 || s >= 0.30) {
      // Preserve exact hue & vividness, only lift lightness until cleanly visible on dark!
      if (l >= 0.60 && contrastRatio(lum, effectiveBgLum) >= 4.2) {
        return null;
      }
      const targetL = Math.max(0.64, Math.min(0.76, 0.62 + (0.55 - Math.min(0.55, l)) * 0.22));
      const targetS = Math.min(0.95, Math.max(s, 0.55));
      const rgb = hslToRgb(h, targetS, targetL);
      return formatRgba(rgb.r, rgb.g, rgb.b, rgba.a);
    }

    // Dark or mid-gray neutral text -> crisp high-visibility light text
    if (l < 0.68) {
      const targetL = Math.max(0.72, Math.min(0.95, 0.95 - l * 0.35));
      const rgb = hslToRgb(220, 0.08, targetL);
      return formatRgba(rgb.r, rgb.g, rgb.b, rgba.a);
    }

    return null;
  }

  function transformBorderColor(rgba, keepText) {
    if (!rgba || rgba.a < 0.05) return null;
    if (keepText) return null;
    const { h, s, l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);

    // Colored border (e.g., blue focus ring, red error border, green badge outline) -> preserve hue!
    if (chroma >= 0.16) {
      if (l > 0.75) {
        // Very pale pastel border (e.g. light blue border around info banner) -> rich dark tinted border
        const rgb = hslToRgb(h, Math.max(0.35, s * 0.75), 0.30);
        return formatRgba(rgb.r, rgb.g, rgb.b, rgba.a);
      }
      if (l < 0.30) {
        const rgb = hslToRgb(h, Math.min(0.9, Math.max(s, 0.5)), 0.52);
        return formatRgba(rgb.r, rgb.g, rgb.b, rgba.a);
      }
      return null;
    }

    // Light neutral border (#e5e7eb, #d2d2d7, #fff) -> refined dark border
    if (l > 0.55) {
      const targetL = Math.max(0.18, Math.min(0.30, 0.20 + (1 - l) * 0.25));
      const rgb = hslToRgb(225, 0.08, targetL);
      return formatRgba(rgb.r, rgb.g, rgb.b, Math.min(rgba.a, 0.85));
    }

    // Very dark neutral border (#000, #222) -> lift slightly so borders remain visible
    if (l < 0.18) {
      const rgb = hslToRgb(225, 0.08, 0.34);
      return formatRgba(rgb.r, rgb.g, rgb.b, rgba.a);
    }

    return null;
  }

  function transformGradientBackground(bgImage, isAmoled) {
    if (!bgImage || bgImage === 'none' || !bgImage.includes('gradient(')) return null;
    const matches = bgImage.match(/rgba?\([^)]+\)/gi);
    if (!matches || matches.length === 0) return null;

    // If any stop is a vibrant non-pastel color, keep the entire gradient authentic!
    let hasLightNeutralStop = false;
    for (const m of matches) {
      const rgba = parseRgba(m);
      if (!rgba || rgba.a < 0.05) continue;
      const { l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);
      if (chroma >= 0.22 && l <= 0.74) {
        return { keepText: true, css: null };
      }
      if (l > 0.62) hasLightNeutralStop = true;
    }

    if (!hasLightNeutralStop) return null;

    const transformed = bgImage.replace(/rgba?\([^)]+\)/gi, (token) => {
      const rgba = parseRgba(token);
      if (!rgba) return token;
      const res = transformBackgroundColor(rgba, isAmoled, false);
      return res.changed && res.css ? res.css : token;
    });

    if (transformed === bgImage) return null;
    return { keepText: false, css: transformed };
  }

  function transformBoxShadow(shadow) {
    if (!shadow || shadow === 'none') return null;
    // Mute bright white glow/inset shadows that create harsh halos on dark mode
    let changed = false;
    const next = shadow.replace(/rgba?\([^)]+\)/gi, (token) => {
      const rgba = parseRgba(token);
      if (!rgba || rgba.a < 0.05) return token;
      const { l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);
      if (l > 0.72 && chroma < 0.12) {
        changed = true;
        return formatRgba(255, 255, 255, Math.min(rgba.a, 0.09));
      }
      return token;
    });
    return changed ? next : null;
  }

  // ---- Inline Style Save / Restore (Zero-Refresh Instant Reversal) ----

  function setTrackedStyle(el, prop, value) {
    if (!el || !el.style) return;
    let saved = originalInlineStyles.get(el);
    if (!saved) {
      saved = {};
      originalInlineStyles.set(el, saved);
    }
    if (!(prop in saved)) {
      saved[prop] = {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop)
      };
    }
    isInternalMutation = true;
    try {
      el.style.setProperty(prop, value, 'important');
      modifiedElements.add(el);
    } finally {
      isInternalMutation = false;
    }
  }

  function setTrackedImgSrc(img, newSrc) {
    if (!img || !newSrc) return;
    if (!originalImgSrcs.has(img)) {
      originalImgSrcs.set(img, img.getAttribute('src') || img.src);
    }
    isInternalMutation = true;
    try {
      img.src = newSrc;
      modifiedElements.add(img);
    } finally {
      isInternalMutation = false;
    }
  }

  function restoreElementStyles(el) {
    if (!el) return;
    isInternalMutation = true;
    try {
      if (originalImgSrcs.has(el)) {
        const origSrc = originalImgSrcs.get(el);
        if (origSrc) el.src = origSrc;
        originalImgSrcs.delete(el);
      }
      const saved = originalInlineStyles.get(el);
      if (saved && el.style) {
        for (const [prop, orig] of Object.entries(saved)) {
          if (orig.value) {
            el.style.setProperty(prop, orig.value, orig.priority || '');
          } else {
            el.style.removeProperty(prop);
          }
        }
        originalInlineStyles.delete(el);
      }
      modifiedElements.delete(el);
      elementContextMap.delete(el);
    } finally {
      isInternalMutation = false;
    }
  }

  function restoreAllElements() {
    isInternalMutation = true;
    try {
      for (const el of modifiedElements) {
        if (!el) continue;
        if (originalImgSrcs.has(el)) {
          const origSrc = originalImgSrcs.get(el);
          if (origSrc) el.src = origSrc;
          originalImgSrcs.delete(el);
        }
        const saved = originalInlineStyles.get(el);
        if (saved && el.style) {
          for (const [prop, orig] of Object.entries(saved)) {
            if (orig.value) {
              el.style.setProperty(prop, orig.value, orig.priority || '');
            } else {
              el.style.removeProperty(prop);
            }
          }
        }
        originalInlineStyles.delete(el);
        elementContextMap.delete(el);
      }
      modifiedElements.clear();
    } finally {
      isInternalMutation = false;
    }
  }

  // ---- Smart Image / Graphic / Illustration Visibility Probe ----

  function applyGraphicVerdictFilter(el, verdict, dataUri) {
    if (!el || !currentlyApplied || currentConfig.mode === 'dim') return;
    if (verdict === 'svg-transformed' && dataUri) {
      if (el.tagName === 'IMG') {
        setTrackedImgSrc(el, dataUri);
      }
      return;
    }
    if (verdict === 'dark-mono') {
      setTrackedStyle(el, 'filter', 'invert(1) brightness(1.08)');
    } else if (verdict === 'alpha-dark') {
      setTrackedStyle(el, 'filter', 'brightness(1.15) contrast(1.05)');
    }
  }

  function analyzeSvgMarkupKind(svgText) {
    if (!svgText || svgText.length > 120000) return 'normal';
    const hexMatches = svgText.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi) || [];
    const rgbMatches = svgText.match(/rgba?\([^)]+\)/gi) || [];
    let hasDark = false;
    let hasLowAlphaDark = false;
    let hasColor = false;
    let hasLight = false;
    const hasMultiply = /mix-blend-mode\s*:\s*(multiply|darken|color-burn)/i.test(svgText);
    const hasLowOpacityAttr = /(?:fill-opacity|stroke-opacity|opacity)\s*[:=]\s*["']?\s*0?\.(0\d|[1-4]\d?)/i.test(svgText);

    const checkColor = (r, g, b, a = 1) => {
      const { l, chroma } = rgbToHsl(r, g, b);
      if (a < 0.55 && l < 0.55) {
        hasLowAlphaDark = true;
      } else if (chroma >= 0.16) {
        hasColor = true;
      } else if (l >= 0.52) {
        hasLight = true;
      } else {
        hasDark = true;
      }
    };

    for (const hex of hexMatches) {
      let h = hex.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      checkColor(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    }
    for (const rgb of rgbMatches) {
      const p = parseRgba(rgb);
      if (p && p.a >= 0.03) checkColor(p.r, p.g, p.b, p.a);
    }

    if (/\b(red|blue|green|orange|yellow|purple|cyan|pink|gold)\b/i.test(svgText)) hasColor = true;
    if (/\b(white|silver|lightgray|lightgrey)\b/i.test(svgText)) hasLight = true;
    if (/\bblack\b/i.test(svgText)) hasDark = true;

    if (!hasColor && !hasLight && !hasLowAlphaDark) {
      if (hasDark) return 'dark-mono';
      if (/<(path|circle|rect|polygon|polyline|line|ellipse|text)\b/i.test(svgText) && !/fill\s*=\s*["']none["']/i.test(svgText)) {
        return 'dark-mono';
      }
    }
    if (hasLowAlphaDark || (hasLowOpacityAttr && (hasDark || hasColor))) {
      return 'alpha-dark';
    }
    if ((hasDark || hasMultiply) && (hasColor || hasLight)) {
      return 'dark-mixed';
    }
    return 'normal';
  }

  function classifySvgDataUri(src) {
    try {
      const idx = src.indexOf(',');
      if (idx === -1) return 'normal';
      const meta = src.slice(0, idx).toLowerCase();
      let svgText = src.slice(idx + 1);
      svgText = meta.includes('base64') ? atob(svgText) : decodeURIComponent(svgText);
      return analyzeSvgMarkupKind(svgText);
    } catch {
      return 'normal';
    }
  }

  function classifyCanvasPixels(data, totalPixels) {
    let transparentCount = 0;
    let visibleCount = 0;
    let semiAlphaDarkCount = 0;
    let opaqueDarkCount = 0;
    let colorCount = 0;
    let brightNeutralCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 6) {
        transparentCount++;
        continue;
      }
      visibleCount++;
      const { l, chroma } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const alphaNorm = a / 255;

      if (alphaNorm < 0.72 && l < 0.55) {
        semiAlphaDarkCount++;
      } else if (chroma >= 0.16 && alphaNorm >= 0.45) {
        colorCount++;
      } else if (l * alphaNorm < 0.34) {
        opaqueDarkCount++;
      } else {
        brightNeutralCount++;
      }
    }

    if (visibleCount === 0) return 'normal';
    const hasTransparency = (transparentCount / totalPixels >= 0.05) || (semiAlphaDarkCount / visibleCount >= 0.12);
    if (!hasTransparency) return 'normal';

    const semiRatio = semiAlphaDarkCount / visibleCount;
    const darkRatio = (opaqueDarkCount + semiAlphaDarkCount) / visibleCount;
    const colorRatio = colorCount / visibleCount;
    const brightRatio = brightNeutralCount / visibleCount;

    if (darkRatio >= 0.78 && colorRatio < 0.10 && brightRatio < 0.15) {
      return 'dark-mono';
    }
    if (semiRatio >= 0.08) {
      return 'alpha-dark';
    }
    if (opaqueDarkCount / visibleCount >= 0.16 && (colorRatio >= 0.05 || brightRatio >= 0.05)) {
      return 'dark-mixed';
    }
    return 'normal';
  }

  function probeDrawSourceForGraphicVisibility(source, srcW, srcH) {
    try {
      if (!srcW || !srcH) return null;
      const canvas = document.createElement('canvas');
      const cw = Math.min(40, Math.max(1, srcW));
      const ch = Math.min(40, Math.max(1, srcH));
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      return classifyCanvasPixels(data, cw * ch);
    } catch {
      return null; // CORS-tainted canvas
    }
  }

  function probeRemoteImageUrl(el, url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/\.(jpe?g)(\?|#|$)/i.test(url)) return;

    const cached = imgProbeCache.get(url);
    if (cached && cached !== 'pending') {
      applyGraphicVerdictFilter(el, cached.kind, cached.dataUri);
      return;
    }
    if (cached === 'pending') {
      let waiters = imgProbeWaiters.get(url);
      if (!waiters) {
        waiters = new Set();
        imgProbeWaiters.set(url, waiters);
      }
      waiters.add(el);
      return;
    }

    imgProbeCache.set(url, 'pending');
    imgProbeWaiters.set(url, new Set([el]));
    try {
      chrome.runtime.sendMessage({ type: 'darkmode-probe-image', url }, (res) => {
        const payload = (!chrome.runtime.lastError && res && res.kind) ? res : { kind: 'normal' };
        imgProbeCache.set(url, payload);
        const waiters = imgProbeWaiters.get(url);
        imgProbeWaiters.delete(url);
        if (waiters) {
          for (const targetEl of waiters) {
            if (targetEl && targetEl.isConnected) {
              applyGraphicVerdictFilter(targetEl, payload.kind, payload.dataUri);
            }
          }
        }
      });
    } catch {
      imgProbeCache.set(url, { kind: 'normal' });
      imgProbeWaiters.delete(url);
    }
  }

  function ensureImageIconVisibility(img, keepText) {
    if (!img || keepText || !currentlyApplied || currentConfig.mode === 'dim') return;
    const rect = img.getBoundingClientRect();
    const w = rect.width || img.width || 0;
    const h = rect.height || img.height || 0;
    if (w === 0 || h === 0 || w > 900 || h > 900) return;

    const src = img.currentSrc || img.src || '';
    if (!src) return;

    const cached = imgProbeCache.get(src);
    if (cached && cached !== 'pending') {
      applyGraphicVerdictFilter(img, cached.kind, cached.dataUri);
      return;
    }

    // 1. Data-URI SVG (instant, zero CORS)
    if (src.startsWith('data:image/svg+xml')) {
      const verdict = classifySvgDataUri(src);
      imgProbeCache.set(src, { kind: verdict });
      applyGraphicVerdictFilter(img, verdict);
      return;
    }

    // 2. Same-origin / CORS-enabled canvas probe
    if (img.complete && img.naturalWidth > 0) {
      const canvasVerdict = probeDrawSourceForGraphicVisibility(img, img.naturalWidth, img.naturalHeight);
      if (canvasVerdict) {
        imgProbeCache.set(src, { kind: canvasVerdict });
        applyGraphicVerdictFilter(img, canvasVerdict);
        return;
      }
    }

    // 3. Cross-origin PNG / WebP / SVG / extensionless CDN graphic -> probe via background.js (zero CORS!)
    probeRemoteImageUrl(img, src);
  }

  function ensureBgImageGraphicVisibility(el, bgImg, keepText) {
    if (!el || !bgImg || !currentlyApplied || currentConfig.mode === 'dim') return;
    // Only inspect graphic/icon/illustration containers (not full-screen hero banners with text)
    if (el.innerText && el.innerText.trim().length > 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.width > 900 || rect.height > 900) return;

    const match = bgImg.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (!match || !match[1]) return;
    const url = match[1].trim();
    if (!url) return;

    if (url.startsWith('data:image/svg+xml')) {
      const verdict = classifySvgDataUri(url);
      applyGraphicVerdictFilter(el, verdict);
      return;
    }

    if (/^https?:\/\//i.test(url)) {
      probeRemoteImageUrl(el, url);
    }
  }

  // ---- Core Element Processor ----

  function getParentContext(el) {
    let p = el.parentElement;
    if (!p && el.parentNode && el.parentNode.host) {
      p = el.parentNode.host;
    }
    while (p) {
      if (elementContextMap.has(p)) {
        return elementContextMap.get(p);
      }
      p = p.parentElement || (p.parentNode && p.parentNode.host) || null;
    }
    return { keepText: false, bgLum: 0.015 };
  }

  function isInteractiveButtonElement(el) {
    const tag = el.tagName;
    if (tag === 'BUTTON') return true;
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      return t === 'submit' || t === 'button' || t === 'reset';
    }
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'button' || role === 'tab' || role === 'switch') return true;
    return false;
  }

  function processElement(el, isAmoled, forceReeval = false) {
    if (!el || el.nodeType !== 1 || el.id === TOAST_ID || el.id === SVG_FILTERS_ID) return;
    if (el.closest && el.closest(`#${SVG_FILTERS_ID}`)) return;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;

    // Never touch video/iframe/embed/object/picture directly
    if (tag === 'VIDEO' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'PICTURE') {
      return;
    }

    // Probe 2D/Lottie canvas graphics for dark-mono or semi-transparent dark shapes
    if (tag === 'CANVAS') {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.width <= 900 && rect.height > 0 && rect.height <= 900) {
        const verdict = probeDrawSourceForGraphicVisibility(el, el.width || rect.width, el.height || rect.height);
        if (verdict && verdict !== 'normal') {
          applyGraphicVerdictFilter(el, verdict);
        }
      }
      return;
    }

    // Flicker-free re-evaluation: restore ONLY this element synchronously right before
    // reading getComputedStyle and re-applying, so no unpainted white frame ever appears.
    if (forceReeval && originalInlineStyles.has(el)) {
      restoreElementStyles(el);
    }

    const parentCtx = getParentContext(el);

    if (tag === 'IMG') {
      // Neutralize multiply/darken blend modes on images so graphics never vanish into pure black!
      try {
        const ics = getComputedStyle(el);
        if (ics && (ics.mixBlendMode === 'multiply' || ics.mixBlendMode === 'darken' || ics.mixBlendMode === 'color-burn')) {
          setTrackedStyle(el, 'mix-blend-mode', 'normal');
        }
      } catch {}

      const handleImg = () => {
        ensureImageIconVisibility(el, parentCtx.keepText);
        // Optional gentle dimming ONLY for large photos if user enabled dimImages
        if (currentConfig.dimImages && !parentCtx.keepText) {
          const w = el.naturalWidth || el.width || 0;
          const h = el.naturalHeight || el.height || 0;
          if (w > 220 && h > 120 && !originalInlineStyles.has(el)) {
            setTrackedStyle(el, 'filter', 'brightness(0.92)');
          }
        }
      };
      if (el.complete) {
        handleImg();
      } else {
        el.addEventListener('load', handleImg, { once: true });
      }
      return;
    }

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return;
    }
    if (!cs) return;

    // Neutralize darken/multiply blend modes designed for white backgrounds (they multiply with #000000 -> invisible!)
    if (cs.mixBlendMode === 'multiply' || cs.mixBlendMode === 'darken' || cs.mixBlendMode === 'color-burn') {
      setTrackedStyle(el, 'mix-blend-mode', 'normal');
    }

    const lowerTag = tag.toLowerCase();

    // Helper for SVG fill / stroke / stop-color visibility
    // Handles dark fills, low fill-opacity, element opacity, and tinted semi-transparent shapes!
    const elemOpacity = parseFloat(cs.opacity);
    const effElemOpacity = isNaN(elemOpacity) ? 1 : elemOpacity;

    const transformSvgPaint = (paintStr, opacityStr, prop, opacityProp) => {
      if (!paintStr || paintStr === 'none' || paintStr.startsWith('url(')) return;
      const rgba = parseRgba(paintStr);
      if (!rgba || rgba.a < 0.02) return;
      const paintOp = parseFloat(opacityStr);
      const effectiveOp = isNaN(paintOp) ? 1 : paintOp;
      const combinedAlpha = rgba.a * effectiveOp * effElemOpacity;
      const { l, chroma } = rgbToHsl(rgba.r, rgba.g, rgba.b);

      // Semi-transparent dark/slate vector shape (EVEN if slightly blue/tinted, e.g. rgba(15,35,65,0.14)!)
      // On white this looks like crisp light gray (#dadce0), on #000000 it vanishes -> lift cleanly!
      if (combinedAlpha < 0.48 && l < 0.58) {
        const boostedAlpha = Math.min(0.68, combinedAlpha * 2.7 + 0.18);
        setTrackedStyle(el, prop, formatRgba(220, 226, 236, Math.min(1, rgba.a < 0.9 ? boostedAlpha : 1)));
        if (opacityProp && !isNaN(paintOp) && paintOp < 0.48) {
          setTrackedStyle(el, opacityProp, String(Number(boostedAlpha.toFixed(2))));
        }
        if (effElemOpacity < 0.48 && effElemOpacity > 0.02) {
          setTrackedStyle(el, 'opacity', String(Number(boostedAlpha.toFixed(2))));
        }
        return;
      }

      // Opaque colored vector shape -> preserve 100% actual color! Only lift very dark saturated tones slightly
      if (chroma >= 0.16) {
        if (l < 0.36) {
          const next = transformForegroundColor(rgba, false, parentCtx.bgLum);
          if (next) setTrackedStyle(el, prop, next);
        }
        return;
      }

      // Opaque dark neutral gray vector shape (#000, #202124, #3c4043) -> crisp light gray/white
      if (l < 0.50) {
        const next = transformForegroundColor({ r: rgba.r, g: rgba.g, b: rgba.b, a: 1 }, false, parentCtx.bgLum);
        if (next) {
          const parsedNext = parseRgba(next);
          if (parsedNext) {
            setTrackedStyle(el, prop, formatRgba(parsedNext.r, parsedNext.g, parsedNext.b, rgba.a));
          }
        }
      }
    };

    // Handle SVG elements & shapes cleanly:
    // Dark monochrome SVGs become crisp light; colored SVGs and semi-transparent illustrations stay 100% visible!
    if (SVG_SHAPE_TAGS.has(lowerTag)) {
      if (lowerTag === 'stop') {
        transformSvgPaint(cs.stopColor, cs.stopOpacity, 'stop-color', 'stop-opacity');
        return;
      }
      if (lowerTag === 'svg') {
        let svgKeepText = parentCtx.keepText;
        // Only treat SMALL icons (<= 48px) with an opaque bright backdrop + dark glyph as self-contained badges.
        // Never skip large illustrations (like Google Play Console graphics)!
        if (!svgKeepText) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width <= 48 && rect.height > 0 && rect.height <= 48) {
            const shapes = el.querySelectorAll('rect, circle, ellipse, path, polygon');
            let hasBrightBackdrop = false;
            let hasDarkGlyph = false;
            for (let i = 0; i < shapes.length && i < 16; i++) {
              const scs = getComputedStyle(shapes[i]);
              const f = parseRgba(scs.fill);
              if (!f || f.a < 0.6) continue;
              const hsl = rgbToHsl(f.r, f.g, f.b);
              if (hsl.l > 0.88 && hsl.chroma < 0.10) hasBrightBackdrop = true;
              else if (hsl.l < 0.25 && hsl.chroma < 0.15) hasDarkGlyph = true;
            }
            if (hasBrightBackdrop && hasDarkGlyph) {
              svgKeepText = true;
            }
          }
        }
        const svgCtx = { keepText: svgKeepText, bgLum: parentCtx.bgLum };
        elementContextMap.set(el, svgCtx);

        if (!svgKeepText) {
          const cRgba = parseRgba(cs.color);
          const nextC = transformForegroundColor(cRgba, false, parentCtx.bgLum);
          if (nextC) setTrackedStyle(el, 'color', nextC);
          transformSvgPaint(cs.fill, cs.fillOpacity, 'fill', 'fill-opacity');
          transformSvgPaint(cs.stroke, cs.strokeOpacity, 'stroke', 'stroke-opacity');
        }
        return;
      }

      elementContextMap.set(el, parentCtx);
      if (!parentCtx.keepText) {
        transformSvgPaint(cs.fill, cs.fillOpacity, 'fill', 'fill-opacity');
        transformSvgPaint(cs.stroke, cs.strokeOpacity, 'stroke', 'stroke-opacity');
      }
      return;
    }

    let myKeepText = parentCtx.keepText;
    let myBgLum = parentCtx.bgLum;

    // Detect CSS mask-image icons (background-color is actually the icon ink color!)
    const hasMaskIcon = (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
    const bgRgba = parseRgba(cs.backgroundColor);

    if (hasMaskIcon) {
      if (bgRgba && bgRgba.a >= 0.05) {
        const nextIconColor = transformForegroundColor(bgRgba, parentCtx.keepText, parentCtx.bgLum);
        if (nextIconColor) setTrackedStyle(el, 'background-color', nextIconColor);
      }
      elementContextMap.set(el, parentCtx);
      return;
    }

    // Check background-image (photo vs gradient)
    const bgImg = cs.backgroundImage;
    const hasPhotoBg = bgImg && bgImg !== 'none' && /url\(/i.test(bgImg);
    const hasGradientBg = bgImg && bgImg !== 'none' && bgImg.includes('gradient(');

    if (hasPhotoBg) {
      // Element has a background image/pattern: probe graphic illustrations
      ensureBgImageGraphicVisibility(el, bgImg, false);
    } else if (hasGradientBg) {
      const gradRes = transformGradientBackground(bgImg, isAmoled);
      if (gradRes) {
        if (gradRes.keepText) {
          myKeepText = true;
        } else if (gradRes.css) {
          setTrackedStyle(el, 'background-image', gradRes.css);
          myKeepText = false;
          myBgLum = isAmoled ? 0.005 : 0.02;
        }
      }
    }

    // Transform background-color if present
    if (bgRgba && bgRgba.a >= 0.08) {
      const isBtn = isInteractiveButtonElement(el);
      const bgRes = transformBackgroundColor(bgRgba, isAmoled, isBtn);
      if (bgRes.changed && bgRes.css) {
        setTrackedStyle(el, 'background-color', bgRes.css);
        myKeepText = false;
        if (bgRes.bgLum !== null) myBgLum = bgRes.bgLum;
      } else if (bgRes.keepText) {
        myKeepText = true;
        if (bgRes.bgLum !== null) myBgLum = bgRes.bgLum;
        // Keep solid black/very-dark CTA buttons clearly visible against dark surfaces
        if (isBtn && bgRes.bgLum !== null && bgRes.bgLum < 0.02) {
          const { chroma } = rgbToHsl(bgRgba.r, bgRgba.g, bgRgba.b);
          if (chroma < 0.10) {
            setTrackedStyle(el, 'background-color', isAmoled ? '#1c1e26' : '#262934');
            setTrackedStyle(el, 'border-top-color', 'rgba(255, 255, 255, 0.22)');
            setTrackedStyle(el, 'border-right-color', 'rgba(255, 255, 255, 0.22)');
            setTrackedStyle(el, 'border-bottom-color', 'rgba(255, 255, 255, 0.22)');
            setTrackedStyle(el, 'border-left-color', 'rgba(255, 255, 255, 0.22)');
          }
        }
      }
    }

    // Store resolved context for descendants
    elementContextMap.set(el, { keepText: myKeepText, bgLum: myBgLum });

    // Transform text color
    const colorRgba = parseRgba(cs.color);
    const nextColor = transformForegroundColor(colorRgba, myKeepText, myBgLum);
    if (nextColor) {
      setTrackedStyle(el, 'color', nextColor);
    }

    // Transform visible borders
    if (cs.borderTopWidth && cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
      const next = transformBorderColor(parseRgba(cs.borderTopColor), myKeepText);
      if (next) setTrackedStyle(el, 'border-top-color', next);
    }
    if (cs.borderRightWidth && cs.borderRightWidth !== '0px' && cs.borderRightStyle !== 'none') {
      const next = transformBorderColor(parseRgba(cs.borderRightColor), myKeepText);
      if (next) setTrackedStyle(el, 'border-right-color', next);
    }
    if (cs.borderBottomWidth && cs.borderBottomWidth !== '0px' && cs.borderBottomStyle !== 'none') {
      const next = transformBorderColor(parseRgba(cs.borderBottomColor), myKeepText);
      if (next) setTrackedStyle(el, 'border-bottom-color', next);
    }
    if (cs.borderLeftWidth && cs.borderLeftWidth !== '0px' && cs.borderLeftStyle !== 'none') {
      const next = transformBorderColor(parseRgba(cs.borderLeftColor), myKeepText);
      if (next) setTrackedStyle(el, 'border-left-color', next);
    }
    if (cs.outlineWidth && cs.outlineWidth !== '0px' && cs.outlineStyle !== 'none') {
      const next = transformBorderColor(parseRgba(cs.outlineColor), myKeepText);
      if (next) setTrackedStyle(el, 'outline-color', next);
    }

    // Clean harsh white glow shadows
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      const nextShadow = transformBoxShadow(cs.boxShadow);
      if (nextShadow) setTrackedStyle(el, 'box-shadow', nextShadow);
    }

    // Walk open Shadow DOM if present
    if (el.shadowRoot) {
      attachRootObserver(el.shadowRoot);
      queueSubtree(el.shadowRoot);
    }
  }

  function queueElement(el, forceReeval = false) {
    if (!el || el.nodeType !== 1 || el.id === TOAST_ID || el.id === SVG_FILTERS_ID || SKIP_TAGS.has(el.tagName)) return;
    const prev = pendingElements.get(el);
    pendingElements.set(el, Boolean(prev || forceReeval));
  }

  function queueSubtree(root, forceReeval = false, maxNodes = 0) {
    if (!root) return;
    let count = 0;
    if (root.nodeType === 1) {
      queueElement(root, forceReeval);
      count++;
    }
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        if (!SKIP_TAGS.has(node.tagName)) {
          queueElement(node, forceReeval);
          count++;
          if (maxNodes > 0 && count >= maxNodes) break;
        }
        node = walker.nextNode();
      }
    } catch {
      // Ignore detached nodes
    }
    scheduleFlush();
  }

  function flushPendingQueue(syncLimit = 0) {
    if (!currentlyApplied || currentConfig.mode === 'dim') {
      pendingElements.clear();
      return;
    }
    const isPureBlack = currentConfig.mode !== 'charcoal';
    const budget = syncLimit > 0 ? syncLimit : 220;
    let count = 0;

    for (const [el, forceReeval] of pendingElements) {
      pendingElements.delete(el);
      if (!el.isConnected) continue;
      try {
        processElement(el, isPureBlack, forceReeval);
      } catch {}
      count++;
      if (count >= budget) break;
    }

    if (pendingElements.size > 0) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = 0;
      flushPendingQueue(0);
    });
  }

  // Flicker-free full page rescan (used after route changes, lazy CSS loads, and window.load)
  function rescanPage(immediateSync = true) {
    if (!currentlyApplied || currentConfig.mode === 'dim') return;
    const root = document.body || document.documentElement;
    if (!root) return;
    queueSubtree(root, true);
    if (immediateSync) {
      flushPendingQueue(300);
    }
  }

  function scheduleDebouncedRescan(delayMs = 110) {
    if (!currentlyApplied || currentConfig.mode === 'dim') return;
    if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
    rescanDebounceTimer = setTimeout(() => {
      rescanDebounceTimer = 0;
      rescanPage(true);
    }, delayMs);
  }

  function triggerNavigationRescan() {
    if (!currentlyApplied || currentConfig.mode === 'dim') return;
    clearSettleTimers();
    rescanPage(true);
    // Catch async SPA data rendering and lazy route CSS chunks cleanly
    settleTimers.push(setTimeout(() => rescanPage(true), 220));
    settleTimers.push(setTimeout(() => rescanPage(true), 650));
    settleTimers.push(setTimeout(() => rescanPage(false), 1400));
  }

  // ---- Head Stylesheet Observer (catches CSS-in-JS & lazy route CSS chunks) ----

  function watchStylesheetLinks(root) {
    if (!root) return;
    const links = root.querySelectorAll ? root.querySelectorAll('link[rel="stylesheet"]') : [];
    for (const link of links) {
      if (!link.__arDmLoadBound) {
        link.__arDmLoadBound = true;
        link.addEventListener('load', () => scheduleDebouncedRescan(60), { once: true });
      }
    }
  }

  function attachHeadObserver() {
    if (headObserver) return;
    const target = document.head || document.documentElement;
    if (!target) return;

    watchStylesheetLinks(target);

    headObserver = new MutationObserver((mutations) => {
      if (isInternalMutation || !currentlyApplied || currentConfig.mode === 'dim') return;
      let stylesheetChanged = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.id === BASE_STYLE_ID || node.id === FILTER_STYLE_ID) continue;
            if (node.tagName === 'STYLE') {
              stylesheetChanged = true;
            } else if (node.tagName === 'LINK' && /stylesheet/i.test(node.rel || '')) {
              stylesheetChanged = true;
              if (!node.__arDmLoadBound) {
                node.__arDmLoadBound = true;
                node.addEventListener('load', () => scheduleDebouncedRescan(60), { once: true });
              }
            }
          }
        } else if (m.type === 'characterData') {
          const parent = m.target && m.target.parentNode;
          if (parent && parent.tagName === 'STYLE' && parent.id !== BASE_STYLE_ID && parent.id !== FILTER_STYLE_ID) {
            stylesheetChanged = true;
          }
        }
      }
      if (stylesheetChanged) {
        scheduleDebouncedRescan(90);
      }
    });

    headObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ---- MutationObserver for Dynamic SPAs, Modals, Dropdowns, Infinite Scroll ----

  function attachRootObserver(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver((mutations) => {
      if (isInternalMutation || !currentlyApplied || currentConfig.mode === 'dim') return;

      // Detect SPA route changes even when history.pushState ran in the page's MAIN world
      if (isTopFrame && location.href !== lastUrl) {
        lastUrl = location.href;
        handleUrlChanged();
        return;
      }

      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1 || node.id === TOAST_ID) continue;
            if (node.tagName === 'STYLE' || (node.tagName === 'LINK' && /stylesheet/i.test(node.rel || ''))) {
              if (node.id !== BASE_STYLE_ID && node.id !== FILTER_STYLE_ID) {
                scheduleDebouncedRescan(90);
              }
              continue;
            }
            if (!SKIP_TAGS.has(node.tagName)) {
              queueSubtree(node, true);
            }
          }
        } else if (m.type === 'attributes') {
          const target = m.target;
          if (target && target.nodeType === 1 && target.id !== TOAST_ID && !SKIP_TAGS.has(target.tagName)) {
            if (target === document.documentElement || target === document.body) {
              scheduleDebouncedRescan(90);
            } else {
              // Re-evaluate target and its descendants since class changes often affect child CSS rules
              queueSubtree(target, true, 160);
            }
          }
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-expanded', 'aria-selected', 'data-state', 'data-theme']
    });
    activeObservers.add(observer);
  }

  function disconnectAllObservers() {
    clearSettleTimers();
    for (const obs of activeObservers) {
      try { obs.disconnect(); } catch {}
    }
    activeObservers.clear();
    observedRoots.clear();
    if (headObserver) {
      try { headObserver.disconnect(); } catch {}
      headObserver = null;
    }
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    pendingElements.clear();
  }

  // ---- Base & Filter Stylesheets ----

  function buildBaseCss(config) {
    const mode = config.mode || 'smart';
    if (mode === 'dim') {
      const brightness = Math.max(50, Math.min(150, Number(config.brightness) || 100));
      const contrast = Math.max(50, Math.min(150, Number(config.contrast) || 100));
      const sepia = Math.max(0, Math.min(60, Number(config.sepia) || 0));
      const grayscale = Math.max(0, Math.min(100, Number(config.grayscale) || 0));
      const dimBrightness = Math.round(brightness * 0.82);
      const dimSepia = Math.min(60, sepia + 8);
      const filters = [`brightness(${dimBrightness}%)`, `contrast(${contrast}%)`, `sepia(${dimSepia}%)`];
      if (grayscale > 0) filters.push(`grayscale(${grayscale}%)`);
      return `
        html {
          filter: ${filters.join(' ')} !important;
        }
      `;
    }

    const isPureBlack = mode !== 'charcoal';
    const bgBase = isPureBlack ? '#000000' : '#141519';
    const bgInput = isPureBlack ? '#101218' : '#1d1f26';
    const textMain = isPureBlack ? '#f4f5f8' : '#eceef2';
    const textMuted = '#9ea6b8';
    const borderSubtle = isPureBlack ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.14)';

    return `
      html {
        color-scheme: dark !important;
        background-color: ${bgBase} !important;
        color: ${textMain} !important;
      }
      body {
        background-color: ${bgBase} !important;
        color: ${textMain} !important;
      }
      /* Prevent multiply/darken blend modes from turning images & illustrations black */
      img, svg, canvas, [role="img"], g, path, rect, circle {
        mix-blend-mode: normal !important;
      }
      input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="submit"]):not([type="button"]):not([type="reset"]),
      textarea,
      select {
        background-color: ${bgInput} !important;
        color: ${textMain} !important;
        border-color: ${borderSubtle} !important;
        caret-color: #60a5fa !important;
      }
      ::placeholder {
        color: ${textMuted} !important;
        opacity: 1 !important;
      }
      hr {
        border-color: ${borderSubtle} !important;
      }
      ::selection {
        background-color: rgba(59, 130, 246, 0.42) !important;
        color: #ffffff !important;
      }
      ::-webkit-scrollbar {
        background-color: ${bgBase};
      }
      ::-webkit-scrollbar-thumb {
        background-color: #363945;
        border-radius: 6px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background-color: #4c5061;
      }
    `;
  }

  function buildFilterTuningCss(config) {
    if (config.mode === 'dim') return '';
    const brightness = Math.max(50, Math.min(150, Number(config.brightness) || 100));
    const contrast = Math.max(50, Math.min(150, Number(config.contrast) || 100));
    const sepia = Math.max(0, Math.min(60, Number(config.sepia) || 0));
    const grayscale = Math.max(0, Math.min(100, Number(config.grayscale) || 0));

    const parts = [];
    if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
    if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
    if (sepia > 0) parts.push(`sepia(${sepia}%)`);
    if (grayscale > 0) parts.push(`grayscale(${grayscale}%)`);

    if (parts.length === 0) return '';
    return `
      html {
        filter: ${parts.join(' ')} !important;
      }
    `;
  }

  function setOrRemoveStyle(id, cssText) {
    const existing = document.getElementById(id);
    if (!cssText) {
      if (existing) existing.remove();
      return;
    }
    let el = existing;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== cssText) {
      el.textContent = cssText;
    }
  }

  // ---- Native Dark Mode Detection ----

  function detectNativeDarkMode() {
    try {
      const html = document.documentElement;
      const body = document.body;
      if (!html) return false;

      // Only inspect true native state when our styles aren't overriding body/html
      if (currentlyApplied) return isNativeDark;

      const metaScheme = document.querySelector('meta[name="color-scheme"]');
      if (metaScheme) {
        const content = (metaScheme.getAttribute('content') || '').trim().toLowerCase();
        if (content === 'dark' || content === 'only dark') return true;
      }

      if (body) {
        const bodyRgba = parseRgba(getComputedStyle(body).backgroundColor);
        if (bodyRgba && bodyRgba.a >= 0.35) {
          return relativeLuminance(bodyRgba.r, bodyRgba.g, bodyRgba.b) < 0.16;
        }
        const htmlRgba = parseRgba(getComputedStyle(html).backgroundColor);
        if (htmlRgba && htmlRgba.a >= 0.35) {
          return relativeLuminance(htmlRgba.r, htmlRgba.g, htmlRgba.b) < 0.16;
        }
        const themeAttr = (
          html.getAttribute('data-theme') ||
          html.getAttribute('data-color-mode') ||
          html.getAttribute('data-bs-theme') ||
          body.getAttribute('data-theme') ||
          ''
        ).toLowerCase();
        if (themeAttr === 'dark' || themeAttr === 'night') return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function evaluateShouldApply(config) {
    if (!config || !config.enabled) {
      return { active: false, source: 'disabled' };
    }

    const pageKey = getPageKey();
    const hostKey = getHostKey();

    // Priority 1: Specific page rule
    if (pageKey && config.pageRules && config.pageRules[pageKey]) {
      return { active: config.pageRules[pageKey] === 'on', source: 'page' };
    }

    // Priority 2: Main domain / site rule
    const matchedSite = findSiteRule(config.siteRules, hostKey);
    if (matchedSite) {
      return { active: matchedSite.value === 'on', source: 'site', matchedKey: matchedSite.key };
    }

    // Priority 3: Optional automation (System Dark, Night Schedule); by default does nothing
    let globalActive = false;
    if (config.followSystem) {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          globalActive = true;
        }
      } catch {}
    }
    if (!globalActive && config.scheduleEnabled) {
      if (isWithinSchedule(config.scheduleStart, config.scheduleEnd)) {
        globalActive = true;
      }
    }

    if (globalActive && config.skipNativeDark && isNativeDark) {
      return { active: false, source: 'native-dark' };
    }

    return { active: globalActive, source: globalActive ? 'global' : 'off' };
  }

  function writeFastCache(active, mode) {
    try {
      if (!isTopFrame) return;
      if (active) {
        localStorage.setItem(FAST_CACHE_KEY, mode || 'smart');
      } else {
        localStorage.removeItem(FAST_CACHE_KEY);
      }
    } catch {}
  }

  // ---- Main Apply / Revert Lifecycle ----

  function startDynamicEngine(config) {
    const html = document.documentElement;
    if (!html) return;

    setOrRemoveStyle(BASE_STYLE_ID, buildBaseCss(config));
    setOrRemoveStyle(FILTER_STYLE_ID, buildFilterTuningCss(config));

    if (config.mode === 'dim') {
      disconnectAllObservers();
      restoreAllElements();
      return;
    }

    const runWalk = () => {
      if (!currentlyApplied || currentConfig.mode === 'dim') return;
      const root = document.body || document.documentElement;
      if (!root) return;
      attachHeadObserver();
      attachRootObserver(document.documentElement);
      queueSubtree(root, true);
      // Immediately transform the first ~300 visible elements synchronously so toggling feels instant
      flushPendingQueue(300);
    };

    if (document.body) {
      runWalk();
    } else {
      document.addEventListener('DOMContentLoaded', runWalk, { once: true });
      attachHeadObserver();
      attachRootObserver(document.documentElement);
    }

    // Also rescan once external stylesheets and full page resources finish loading
    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => {
        if (currentlyApplied && currentConfig.mode !== 'dim') {
          triggerNavigationRescan();
        }
      }, { once: true });
    }
  }

  function applyDarkMode(active, config) {
    const html = document.documentElement;
    if (!html) return;

    // Clean up any legacy style tag left over from an earlier extension reload
    const legacyStyle = document.getElementById('__ar-darkmode-style');
    if (legacyStyle) legacyStyle.remove();

    const modeChanged = appliedMode !== (config.mode || 'smart');
    const stateChanged = currentlyApplied !== active;

    html.setAttribute('data-ar-dm-ready', '1');

    if (active) {
      // If switching between Smart <-> AMOLED <-> Dim while active, cleanly reset inline overrides first
      if (currentlyApplied && modeChanged) {
        disconnectAllObservers();
        restoreAllElements();
      }
      currentlyApplied = true;
      appliedMode = config.mode || 'smart';
      html.setAttribute('data-ar-dm', 'on');
      writeFastCache(true, appliedMode);

      if (stateChanged || modeChanged) {
        startDynamicEngine(config);
      } else {
        // Just update filter sliders / base styles smoothly without re-walking everything
        setOrRemoveStyle(BASE_STYLE_ID, buildBaseCss(config));
        setOrRemoveStyle(FILTER_STYLE_ID, buildFilterTuningCss(config));
      }
    } else {
      currentlyApplied = false;
      appliedMode = null;
      html.removeAttribute('data-ar-dm');
      html.removeAttribute('data-ar-dm-ready');
      disconnectAllObservers();
      restoreAllElements();
      removeSvgFilterDefs();
      setOrRemoveStyle(BASE_STYLE_ID, '');
      setOrRemoveStyle(FILTER_STYLE_ID, '');
      writeFastCache(false);
    }
  }

  function refreshDarkMode() {
    const decision = evaluateShouldApply(currentConfig);
    applyDarkMode(decision.active, currentConfig);
  }

  // Clear any legacy localStorage fast-cache so disabled Dark Mode never leaks onto pages
  try {
    if (isTopFrame) localStorage.removeItem(FAST_CACHE_KEY);
  } catch {}

  async function loadAndApply() {
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      const saved = res[STORAGE_KEY] || {};
      currentConfig = {
        ...DEFAULT_CONFIG,
        ...saved,
        shortcut: { ...DEFAULT_CONFIG.shortcut, ...(saved.shortcut || {}) },
        siteRules: { ...(saved.siteRules || {}) },
        pageRules: { ...(saved.pageRules || {}) }
      };

      // Check native dark mode once body exists (if not already applied)
      const checkNative = () => {
        if (!currentlyApplied) {
          isNativeDark = detectNativeDarkMode();
        }
        refreshDarkMode();
      };

      if (document.readyState === 'loading') {
        refreshDarkMode();
        document.addEventListener('DOMContentLoaded', () => {
          if (!currentlyApplied) {
            isNativeDark = detectNativeDarkMode();
            refreshDarkMode();
          } else if (currentConfig.mode !== 'dim') {
            triggerNavigationRescan();
          }
        }, { once: true });
      } else {
        checkNative();
        if (currentlyApplied && currentConfig.mode !== 'dim') {
          triggerNavigationRescan();
        }
      }
    } catch {
      // Extension context invalidated
    }
  }

  loadAndApply();
  window.addEventListener('__ar_dm_resync', loadAndApply);

  // Live instant reaction to storage changes from popup, shortcut, or other tabs
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const next = changes[STORAGE_KEY].newValue || {};
        currentConfig = {
          ...DEFAULT_CONFIG,
          ...next,
          shortcut: { ...DEFAULT_CONFIG.shortcut, ...(next.shortcut || {}) },
          siteRules: { ...(next.siteRules || {}) },
          pageRules: { ...(next.pageRules || {}) }
        };
        refreshDarkMode();
      }
    });
  } catch {}

  // Follow OS color-scheme changes
  try {
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentConfig.followSystem) refreshDarkMode();
      });
    }
  } catch {}

  // ---- Toast Notification ----

  function showToast(message) {
    if (!isTopFrame || !document.body) return;
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '2147483647',
        padding: '9px 14px',
        borderRadius: '10px',
        background: 'rgba(15, 5, 30, 0.94)',
        color: '#ffffff',
        border: '1px solid rgba(0, 240, 255, 0.4)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.48)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '12px',
        fontWeight: '600',
        letterSpacing: '0.2px',
        backdropFilter: 'blur(12px)',
        pointerEvents: 'none',
        opacity: '0',
        transform: 'translateY(6px)',
        transition: 'opacity 0.18s ease, transform 0.18s ease'
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(6px)';
      }
    }, 1500);
  }

  async function toggleCurrentSiteViaShortcut() {
    if (!currentConfig || !currentConfig.enabled) return;
    const hostKey = getHostKey();
    const pageKey = getPageKey();
    if (!hostKey) return;

    const mainDomain = getMainDomain(hostKey) || hostKey;
    const nextActive = !currentlyApplied;
    const updatedConfig = {
      ...currentConfig,
      siteRules: { ...(currentConfig.siteRules || {}) },
      pageRules: { ...(currentConfig.pageRules || {}) }
    };

    if (pageKey && updatedConfig.pageRules[pageKey]) {
      delete updatedConfig.pageRules[pageKey];
    }
    const existingSite = findSiteRule(updatedConfig.siteRules, hostKey);
    const targetDomain = existingSite ? existingSite.key : mainDomain;
    updatedConfig.siteRules[targetDomain] = nextActive ? 'on' : 'off';

    currentConfig = updatedConfig;
    applyDarkMode(nextActive, updatedConfig);
    showToast(nextActive ? `Dark Mode: ON (${targetDomain})` : `Dark Mode: OFF (${targetDomain})`);

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: updatedConfig });
    } catch {}
  }

  function matchesShortcut(event, sc) {
    if (!sc || (!sc.code && !sc.key)) return false;
    if (!sc.ctrlKey && !sc.altKey && !sc.metaKey && !sc.shiftKey) return false;
    if (Boolean(event.ctrlKey) !== Boolean(sc.ctrlKey)) return false;
    if (Boolean(event.altKey) !== Boolean(sc.altKey)) return false;
    if (Boolean(event.shiftKey) !== Boolean(sc.shiftKey)) return false;
    if (Boolean(event.metaKey) !== Boolean(sc.metaKey)) return false;
    if (sc.code && event.code === sc.code) return true;
    if (sc.key && event.key && event.key.toUpperCase() === sc.key.toUpperCase()) return true;
    return false;
  }

  function handleUrlChanged() {
    const decision = evaluateShouldApply(currentConfig);
    if (decision.active !== currentlyApplied) {
      applyDarkMode(decision.active, currentConfig);
    } else if (currentlyApplied && currentConfig.mode !== 'dim') {
      // Same domain stays active across SPA page transition -> automatically rescan the new view!
      triggerNavigationRescan();
    }
  }

  // Customizable keyboard shortcut listener runs across all frames (main page + iframes/web apps)
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (!currentConfig || !currentConfig.enabled) return;
    if (matchesShortcut(e, currentConfig.shortcut)) {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      const isEditable = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
      if (isEditable && !e.altKey && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (isTopFrame) {
        toggleCurrentSiteViaShortcut();
      } else {
        chrome.runtime.sendMessage({ type: 'darkmode-toggle-shortcut' }).catch(() => {});
      }
    }
  }, true);

  if (isTopFrame) {
    const checkUrlChange = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        handleUrlChanged();
      }
    };

    // Standard Chromium Navigation API catches EVERY main-world SPA navigation across isolated worlds!
    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigatesuccess', () => {
          lastUrl = location.href;
          handleUrlChanged();
        });
        window.navigation.addEventListener('currententrychange', checkUrlChange);
      }
    } catch {}

    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('hashchange', checkUrlChange);

    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'darkmode-ping') {
          sendResponse({ ok: true, active: currentlyApplied });
          return true;
        }
        if (msg.type === 'darkmode-page-navigated') {
          lastUrl = location.href;
          handleUrlChanged();
          sendResponse({ ok: true });
          return true;
        }
        if (msg.type === 'darkmode-force-sync') {
          loadAndApply().then(() => sendResponse({ ok: true, active: currentlyApplied }));
          return true;
        }
        if (msg.type === 'darkmode-toggle-shortcut') {
          toggleCurrentSiteViaShortcut().then(() => sendResponse({ ok: true, active: currentlyApplied }));
          return true;
        }
        if (msg.type === 'darkmode-show-toast' && msg.message) {
          showToast(String(msg.message));
          sendResponse({ ok: true });
          return true;
        }
        if (msg.type === 'darkmode-get-page-state') {
          const decision = evaluateShouldApply(currentConfig);
          sendResponse({
            active: currentlyApplied,
            source: decision.source,
            isNativeDark,
            hostKey: getHostKey(),
            pageKey: getPageKey()
          });
          return true;
        }
      });
    } catch {}
  }
})();
