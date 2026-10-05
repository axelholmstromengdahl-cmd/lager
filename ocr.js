/* Läser skriven eller tryckt kod med kameran (OCR) och matchar den mot
 * koderna som finns i lagret. Körs helt i webbläsaren – inga bilder skickas
 * någonstans. Motorn (Tesseract, öppen källkod) laddas först när kameran startas.
 */
(() => {
  "use strict";

  // ---------- Matchning (ren logik, går att testa utan kamera) ----------
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Tecken som lätt förväxlas vid läsning räknas som samma
  const CONFUSE = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
  const conf = (s) => s.replace(/[OQDILSBZG]/g, (c) => CONFUSE[c]);

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function prepare(codes) {
    const list = [...new Set(codes)].map((code) => ({ code, n: norm(code) })).filter((c) => c.n.length >= 3);
    for (const c of list) c.c = conf(c.n);
    // Koder som blir lika efter förväxling går inte att skilja åt säkert
    const seen = new Map();
    for (const c of list) seen.set(c.c, (seen.get(c.c) || 0) + 1);
    for (const c of list) c.ambiguous = seen.get(c.c) > 1;
    // Koder som bara skiljer sig på ett tecken (t.ex. storlek S/M/L) kräver extra säker läsning
    for (const c of list) c.sibling = list.some((o) => o !== c && lev(o.c, c.c) <= 1);
    return list;
  }

  /** Hittar vilken känd kod texten innehåller. Returnerar { code, quality } eller null.
   *  quality: "exact" (läst rätt), "near" (förväxlingstecken), "close" (ett tecken fel). */
  function match(text, codes) {
    const list = Array.isArray(codes) && codes[0] && codes[0].n ? codes : prepare(codes || []);
    if (!list.length) return null;
    const cands = new Set();
    for (const line of String(text || "").split(/\n+/)) {
      const joined = norm(line);
      if (joined.length >= 3) cands.add(joined);
      const toks = line.trim().split(/\s+/).map(norm).filter(Boolean);
      for (let i = 0; i < toks.length; i++) {
        let acc = "";
        for (let j = i; j < Math.min(toks.length, i + 4); j++) { acc += toks[j]; if (acc.length >= 3) cands.add(acc); }
      }
    }
    if (!cands.size) return null;

    // 1. Exakt
    for (const c of list) if (cands.has(c.n)) return { code: c.code, quality: "exact", sibling: c.sibling };
    // 2. Lika efter förväxlingstecken, eller koden ligger inuti en längre läst rad
    const cc = [...cands].map(conf);
    const near = list.filter((c) => !c.ambiguous && (cc.includes(c.c) || (c.c.length >= 5 && cc.some((x) => x.includes(c.c)))));
    if (near.length === 1) return { code: near[0].code, quality: "near" };
    if (near.length > 1) return null;
    // 3. Ett tecken fel (två för långa koder), och bara om en enda kod ligger så nära
    let best = null, bestD = 99, second = 99;
    for (const c of list) {
      if (c.ambiguous || c.c.length < 5) continue;
      const allow = c.c.length >= 9 ? 2 : 1;
      let d = 99;
      for (const x of cc) d = Math.min(d, lev(x, c.c));
      if (d <= allow) { if (d < bestD) { second = bestD; bestD = d; best = c; } else second = Math.min(second, d); }
      else second = Math.min(second, d);
    }
    if (best && second >= bestD + 2) return { code: best.code, quality: "close" };
    return null;
  }

  // ---------- Kameraläsning ----------
  let worker = null, loading = null, running = false, timer = null;
  let base = "vendor/ocr/";
  try { base = new URL("vendor/ocr/", (document.currentScript && document.currentScript.src) || location.href).href; } catch { /* inbäddad demo */ }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Kunde inte ladda " + src));
      document.head.append(s);
    });
  }

  async function getWorker() {
    if (worker) return worker;
    loading ||= (async () => {
      if (!window.Tesseract) await loadScript(base + "tesseract.min.js");
      const w = await window.Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js", corePath: base, langPath: base,
        workerBlobURL: false, gzip: true,
      });
      await w.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._ ",
        user_defined_dpi: "150",
      });
      worker = w;
      return w;
    })();
    return loading;
  }

  // ---------- Bildbehandling ----------
  const mkCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

  // Klipper ut mitten av bilden (samma ruta som sökaren visar), högst 1700 px bred
  function grab(src) {
    const vw = src.videoWidth || src.naturalWidth || src.width, vh = src.videoHeight || src.naturalHeight || src.height;
    if (!vw || !vh) return null;
    const cw = vw * 0.86, ch = Math.min(vh * 0.6, cw * 0.6);
    const scale = Math.min(1, 1700 / cw);
    const c = mkCanvas(Math.round(cw * scale), Math.round(ch * scale));
    c.getContext("2d", { willReadFrequently: true }).drawImage(src, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
    return c;
  }

  // Skalar, rätar upp och gör bilden gråskalig med utdragen kontrast.
  // Görs för hand (inte med canvas-filter) så att det blir lika i alla webbläsare.
  function prep(source, width, angle, binarize, thicken) {
    const sc = width / source.width;
    const c = mkCanvas(Math.round(source.width * sc), Math.round(source.height * sc));
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingQuality = "high";
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    if (angle) { x.translate(c.width / 2, c.height / 2); x.rotate(angle * Math.PI / 180); x.translate(-c.width / 2, -c.height / 2); }
    x.drawImage(source, 0, 0, c.width, c.height);
    x.setTransform(1, 0, 0, 1, 0, 0);
    const w = c.width, h = c.height, d = x.getImageData(0, 0, w, h), p = d.data, n = w * h;
    const g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (p[i * 4] * 3 + p[i * 4 + 1] * 6 + p[i * 4 + 2]) / 10 | 0; g[i] = v; hist[v]++; }
    if (binarize) {
      // Lokal tröskling: text blir svart på vitt även i ojämnt ljus
      const I = new Float64Array((w + 1) * (h + 1));
      for (let y = 1; y <= h; y++) { let row = 0; for (let xx = 1; xx <= w; xx++) { row += g[(y - 1) * w + xx - 1]; I[y * (w + 1) + xx] = I[(y - 1) * (w + 1) + xx] + row; } }
      const r = Math.max(8, Math.round(w / 28));
      for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
        const x0 = Math.max(0, xx - r), x1 = Math.min(w, xx + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        const mean = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
        const v = g[y * w + xx] < mean * 0.85 ? 0 : 255, i = (y * w + xx) * 4;
        p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
      }
      if (thicken) {
        // Gör tunna streck (blyerts, smal penna) lite tjockare
        const src = new Uint8Array(n);
        for (let i = 0; i < n; i++) src[i] = p[i * 4];
        for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
          const k = y * w + xx;
          if (src[k] && (!src[k - 1] || !src[k + 1] || !src[k - w] || !src[k + w])) { p[k * 4] = p[k * 4 + 1] = p[k * 4 + 2] = 0; }
        }
      }
    } else {
      // Dra ut kontrasten mellan de mörkaste och ljusaste 2 %
      let lo = 0, hi = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
      const k = 255 / Math.max(40, hi - lo);
      for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (g[i] - lo) * k)); p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v; p[i * 4 + 3] = 255; }
    }
    x.putImageData(d, 0, 0);
    return c;
  }

  // Uppskattar hur mycket lappen lutar: den vinkel där textraderna ger tydligast rader
  function skew(source) {
    const c = prep(source, 320, 0, true);
    const w = c.width, h = c.height, p = c.getContext("2d").getImageData(0, 0, w, h).data;
    const pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (p[(y * w + x) * 4] === 0) pts.push(x - w / 2, y - h / 2);
    if (pts.length < 60) return 0;
    let best = 0, bestScore = -1, zero = 0;
    for (let a = -24; a <= 24; a += 2) {
      const t = a * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t), rows = new Float32Array(h * 2);
      for (let i = 0; i < pts.length; i += 2) { const yy = Math.round(pts[i] * sn + pts[i + 1] * cs + h); if (yy >= 0 && yy < h * 2) rows[yy]++; }
      let score = 0;
      for (let i = 0; i < rows.length; i++) score += rows[i] * rows[i];
      if (a === 0) zero = score;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    // Lita bara på lutningen om den är tydlig. Skuggor och skrynklor kan annars lura mätningen.
    return bestScore > zero * CFG.skewGuard ? best : 0;
  }

  // Läsningarna växlar mellan olika storlek, vinkel och läge:
  // [bredd, vinkel utöver uppmätt lutning, sidläge, svartvit, tjockare streck, använd uppmätt lutning]
  const CFG = {
    skewGuard: 1.25,
    passes: [
      [1100, 0, "11", 1, 0, 1], [900, 0, "11", 0, 0, 1], [900, 0, "6", 1, 0, 0], [1400, 0, "11", 0, 0, 1],
      [1100, 0, "6", 1, 1, 1], [1100, 0, "6", 0, 0, 1], [1400, 0, "11", 1, 1, 0], [600, 0, "6", 0, 0, 1],
      [1100, 4, "6", 1, 0, 1], [1100, -4, "6", 1, 0, 1], [1700, 0, "11", 0, 0, 1], [700, 0, "11", 1, 0, 0],
    ],
  };

  async function readPass(w, source, angle, pass) {
    const [width, extra, psm, bin, thick, auto] = pass;
    const c = prep(source, width, (auto ? angle : 0) + extra, !!bin, !!thick);
    await w.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await w.recognize(c);
    return data.text || "";
  }

  // Avgör om rösterna räcker. En exakt läst, entydig kod godtas direkt.
  // Annars krävs två läsningar som är överens och tydligt fler än nästa kandidat.
  function decide(votes, latest) {
    const top = [...votes].sort((a, b) => b[1].n - a[1].n);
    if (!top.length) return null;
    const sure = latest && latest.quality === "exact" && !latest.sibling && norm(latest.code).length >= 4;
    if (sure && top.length === 1) return { code: latest.code, quality: "exact" };
    if (top[0][1].n >= 2 && (top.length === 1 || top[0][1].n >= top[1][1].n + 2)) {
      return { code: top[0][0], quality: top[0][1].exact ? "exact" : "close" };
    }
    return null;
  }
  function vote(votes, m) {
    const v = votes.get(m.code) || { n: 0, exact: true };
    v.n++; if (m.quality !== "exact") v.exact = false;
    votes.set(m.code, v);
  }

  // Det tydligaste "ordet" i en läsning, för att visa användaren vad kameran ser
  function glimpse(text) {
    const toks = String(text).toUpperCase().split(/\s+/).map((t) => t.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "")).filter((t) => t.replace(/[^A-Z0-9]/g, "").length >= 3);
    return toks.sort((a, b) => b.length - a.length)[0] || "";
  }

  /** Läser en stillbild (bild eller canvas). Används för test. Returnerar { code, quality, passes } eller null. */
  async function readImage(image, codes, trace) {
    const w = await getWorker(), prepared = prepare(codes), source = grab(image);
    if (!source) return null;
    const angle = skew(source), votes = new Map();
    for (let i = 0; i < CFG.passes.length; i++) {
      const text = await readPass(w, source, angle, CFG.passes[i]);
      const m = match(text, prepared);
      if (trace) trace.push({ pass: CFG.passes[i].join("/"), angle, text: text.trim(), match: m && m.code });
      if (!m) continue;
      vote(votes, m);
      const d = decide(votes, m);
      if (d) return { ...d, passes: i + 1 };
    }
    return null;
  }

  /** Startar läsning från kameran.
   *  opts: { video, getCodes, isPaused, onMatch(m), onStatus(text), onSeen(text) } */
  async function start(opts) {
    stop();
    running = true;
    let prepared = null, preparedFrom = null, i = 0, votes = [];
    opts.onStatus?.("Laddar textläsning …");
    let w;
    try { w = await getWorker(); }
    catch { opts.onStatus?.("Textläsning kunde inte laddas. QR och streckkod fungerar ändå."); running = false; return; }
    if (!running) return;
    opts.onStatus?.("Läser QR, streckkod och skriven kod");

    const tick = async () => {
      if (!running) return;
      let wait = 120;
      try {
        const codes = opts.getCodes?.() || [];
        if (codes !== preparedFrom) { prepared = prepare(codes); preparedFrom = codes; }
        const paused = opts.isPaused?.() || document.visibilityState !== "visible";
        if (paused) { votes = []; wait = 400; }
        const source = !paused && prepared.length ? grab(opts.video) : null;
        if (source) {
          const text = await readPass(w, source, skew(source), CFG.passes[i++ % CFG.passes.length]);
          if (!running) return;
          opts.onSeen?.(glimpse(text));
          const now = Date.now();
          votes = votes.filter((v) => now - v.t < 3000);     // bara läsningar från de senaste 3 sekunderna räknas
          const m = match(text, prepared);
          if (m) votes.push({ t: now, m });
          const tally = new Map();
          for (const v of votes) vote(tally, v.m);
          const d = decide(tally, m);
          if (d && !opts.isPaused?.()) { votes = []; opts.onMatch?.(d); }
        }
      } catch { wait = 400; }
      if (running) timer = setTimeout(tick, wait);
    };
    tick();
  }

  function stop() { running = false; clearTimeout(timer); timer = null; }

  window.LagerOCR = { match, prepare, start, stop, readImage, _cfg: CFG };
  if (typeof module !== "undefined") module.exports = { match, prepare };
})();
