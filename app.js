/* Lagerapp – all logik i webbläsaren.
 * Viktigt: rollkontrollen här styr bara vad som VISAS. Den riktiga säkerheten
 * ligger i databasen (schema.sql) och serverfunktionen (admin-users).
 * Användardata skrivs alltid in med textContent – aldrig som HTML.
 */
(() => {
  "use strict";

  const cfg = window.LAGER_CONFIG || {};

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const $ = (sel) => document.querySelector(sel);
  // edit: namn, färg och storlek som visas i skannern (kan ändras innan man sparar)
  const state = { me: null, scanner: null, scanning: false, current: null, busy: false, photo: null, edit: null, editing: false };

  // ---------- Små hjälpare ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2600);
  }

  const fmt = (n) => new Intl.NumberFormat("sv-SE").format(n ?? 0);
  const fmtDate = (d) => new Date(d).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

  // Visa begripliga fel, men aldrig tekniska detaljer som kan läcka info
  function errMsg(error) {
    const m = error?.message || "";
    const known = ["Ingen behörighet", "Endast admin", "Ogiltigt antal", "Ogiltig kod", "Ogiltigt foto", "Ogiltigt namn", "Ogiltigt värde", "Ogiltigt pris",
      "Klänningen är reserverad", "Det finns ingen ledig att reservera", "Priset är lägre än lägsta tillåtna pris",
      "Reservationen hittades inte", "Reservationen är redan avslutad", "Okänt fält", "Det finns ingen ledig", "Händelsen hittades inte", "Kan inte ångras", "Försäljning från webbshoppen",
      "Produkten hittades inte", "Det finns inte så många kvar i lager", "Artikelnumret eller streckkoden används redan", "Ogiltig streckkod"];
    return known.find((k) => m.includes(k)) || "Något gick fel. Försök igen.";
  }

  function qrSvg(code) {
    const qr = window.qrcode(0, "M");
    qr.addData(code);
    qr.make();
    const tpl = document.createElement("template");
    tpl.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); // bara genererad kod, ingen användardata
    return tpl.content.firstElementChild;
  }

  const variantText = (p) => [p.color, p.size && `Stl ${p.size}`].filter(Boolean).join(" · ");
  // Namn på en variant i listor: färg/storlek, annars streckkoden eller koden
  const desc = (p) => variantText(p) || p.barcode || p.code || "";

  function label(p) {
    return h("div", { class: "lbl" }, qrSvg(p.code),
      h("div", { class: "label-name", text: p.name }),
      variantText(p) ? h("div", { class: "label-variant", text: variantText(p) }) : null,
      h("div", { class: "label-code", text: p.code }));
  }

  function confirmBox(title, text) {
    return new Promise((resolve) => {
      const dlg = $("#dlg-confirm");
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      dlg.returnValue = "";
      dlg.onclose = () => resolve(dlg.returnValue === "yes");
      dlg.showModal();
    });
  }

  function ask(title, { type = "text", value = "", min, max, required = true } = {}) {
    return new Promise((resolve) => {
      const dlg = $("#dlg-input"), input = $("#input-value"), form = $("#input-form");
      $("#input-title").textContent = title;
      input.type = type; input.value = value; input.required = required;
      type === "number" ? (input.min = min ?? "", input.max = max ?? "") : (input.removeAttribute("min"), input.removeAttribute("max"));
      const done = (v) => { form.onsubmit = null; dlg.onclose = null; dlg.close(); resolve(v); };
      form.onsubmit = (e) => { e.preventDefault(); done(input.value); };
      dlg.onclose = () => resolve(null);
      dlg.showModal();
      input.focus(); input.select?.();
    });
  }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  // Ett meddelande som står kvar tills man stänger det. Fel skrivs också till konsolen
  // action: valfri knapp i meddelandet, { label, run }
  function notice(text, isError = false, action = null) {
    if (isError) console.error(text);
    $("#notice-text").textContent = text;
    $("#notice").classList.toggle("error", isError);
    document.querySelectorAll("#notice .notice-action").forEach((b) => b.remove());
    if (action) $("#notice").insertBefore(h("button", { class: "btn small notice-action", type: "button", text: action.label, onclick: () => { $("#notice").hidden = true; action.run(); } }), $("#notice-close"));
    $("#notice").hidden = false;
  }
  $("#notice-close").addEventListener("click", () => { $("#notice").hidden = true; });

  // ---------- Inloggning ----------
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button"), err = $("#login-error");
    err.hidden = true; btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: f.email.value.trim(), password: f.password.value,
    });
    btn.disabled = false;
    if (error) {
      err.textContent = error.status === 429 ? "För många försök. Vänta en stund." : "Fel e-post eller lösenord.";
      err.hidden = false;
      return;
    }
    f.password.value = "";
    await boot();
  });

  $("#logout").addEventListener("click", () => logout());

  async function logout(msg) {
    await stopScanner();
    await sb.auth.signOut();
    state.me = null;
    showLogin();
    if (msg) toast(msg);
  }

  function showLogin() {
    $("#view-app").hidden = true;
    $("#view-login").hidden = false;
  }

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();

    const { data: me, error } = await sb.from("profiles")
      .select("id, full_name, role").eq("id", session.user.id).single();
    if (error || !me) return logout("Kontot saknar behörighet.");

    state.me = me;
    $("#who-name").textContent = me.full_name;
    $("#who-role").textContent = me.role === "admin" ? "Admin" : "Arbetare";
    $("#tabs").hidden = false;
    document.querySelectorAll("[data-admin]").forEach((b) => (b.hidden = me.role !== "admin"));
    $("#view-login").hidden = true;
    $("#view-app").hidden = false;
    showTab("scan");
  }

  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") showLogin(); });

  // Automatisk utloggning vid inaktivitet (bra på delade enheter)
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (!state.me) return;
    idleTimer = setTimeout(() => logout("Du loggades ut efter inaktivitet."), (cfg.IDLE_LOGOUT_MINUTES || 30) * 60000);
  };
  ["pointerdown", "keydown", "visibilitychange"].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

  // ---------- Flikar ----------
  const loaders = { reserved: loadReserved, overview: loadOverview, products: loadProducts, accounts: loadAccounts, history: loadHistory, shop: loadShop };
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  function showTab(name) {
    if (name !== "scan" && name !== "reserved" && state.me?.role !== "admin") name = "scan";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + name));
    if (name !== "scan") stopScanner();
    if (name === "scan" && pref.get("lager-mode") === "list" && $("#picker").hidden) setMode("list");
    loaders[name]?.();
    resetIdle();
  }

  // ---------- Välj i listan (för den som saknar etiketter/skrivare) ----------
  const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                 set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  let pickerItems = [];

  function setMode(mode) {
    const list = mode === "list";
    $("#mode-scan").classList.toggle("active", !list); $("#mode-scan").setAttribute("aria-selected", String(!list));
    $("#mode-list").classList.toggle("active", list); $("#mode-list").setAttribute("aria-selected", String(list));
    $(".scan-card").classList.toggle("list-mode", list);
    $("#picker").hidden = !list;
    pref.set("lager-mode", mode);
    if (list) { stopScanner(); loadPicker(); }
  }
  $("#mode-scan").addEventListener("click", () => setMode("scan"));
  $("#mode-list").addEventListener("click", () => setMode("list"));

  async function loadPicker() {
    const { data, error } = await sb.rpc("staff_products");
    if (error) return toast(errMsg(error), true);
    pickerItems = data || [];
    renderPicker();
  }

  function renderPicker() {
    const q = $("#picker-search").value.trim().toLowerCase();
    const items = pickerItems.filter((p) => !q || `${p.name} ${p.color} ${p.size}`.toLowerCase().includes(q));
    const list = $("#picker-list");
    if (!items.length) {
      return list.replaceChildren(h("p", { class: "empty-state", text: pickerItems.length ? "Ingen klänning matchar sökningen." : "Inga klänningar inlagda än." }));
    }
    const models = new Map();
    for (const p of items) {
      if (!models.has(p.name)) models.set(p.name, new Map());
      const colors = models.get(p.name);
      if (!colors.has(p.color)) colors.set(p.color, []);
      colors.get(p.color).push(p);
    }
    list.replaceChildren(...[...models].map(([name, colors]) =>
      h("section", { class: "pick-model" }, h("h3", { text: name }),
        ...[...colors].flatMap(([color, variants]) => [
          color ? h("p", { class: "pick-color", text: color }) : null,
          h("div", { class: "pick-sizes" }, ...variants.sort((a, b) => bySize(a.size, b.size)).map((p) =>
            h("button", {
              class: "pick-size" + (p.quantity === 0 ? " out" : p.quantity <= 2 ? " low" : ""), type: "button",
              "aria-label": `${name} ${color} storlek ${p.size || "–"}, ${p.quantity} i lager`,
              onclick: () => openProduct(p.code),
            }, h("span", { class: "sz", text: p.size || "–" }), h("span", { class: "q", text: p.quantity === 0 ? "slut" : `${p.quantity} st` })))),
        ]))));
  }
  $("#picker-search").addEventListener("input", renderPicker);

  // ---------- Skanner ----------
  $("#start-scan").addEventListener("click", startScanner);

  async function startScanner() {
    if (!window.isSecureContext && !window.__demo) return toast("Kameran kräver https.", true);
    try {
      const F = window.Html5QrcodeSupportedFormats;
      // QR + vanliga streckkoder på klädlappar (EAN/UPC/Code 128/Code 39)
      const formats = ["QR_CODE", "EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "CODE_39"]
        .map((k) => F[k]).filter((v) => v !== undefined);
      state.scanner ||= new window.Html5Qrcode("reader", {
        formatsToSupport: formats, verbose: false,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      await state.scanner.start(
        { facingMode: "environment" },
        // Brett fönster så att både QR-koder och avlånga streckkoder får plats
        { fps: 10, videoConstraints: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, qrbox: (w, hgt) => ({ width: Math.floor(w * 0.82), height: Math.floor(Math.min(hgt * 0.6, w * 0.6)) }) },
        onScan, () => {}
      );
      state.scanning = true;
      $("#scan-idle").hidden = true;
      $("#cam-tools").hidden = false;
      setTimeout(updateTorchButton, 600);   // kamerans egenskaper är inte kända direkt
      startTextReading();
    } catch {
      toast("Kunde inte starta kameran. Tillåt kameraåtkomst i webbläsaren.", true);
    }
  }

  // ---------- Lampa ----------
  // Fungerar på telefoner där webbläsaren får styra kamerans lampa (främst Android).
  // Knappen visas bara när lampan går att styra.
  function torchTrack() {
    const track = $("#reader video")?.srcObject?.getVideoTracks?.()[0];
    return track && track.getCapabilities?.().torch ? track : null;
  }
  function updateTorchButton() {
    const btn = $("#torch");
    btn.hidden = !state.scanning || !torchTrack();
    btn.textContent = state.torch ? "Släck lampan" : "Tänd lampan";
    btn.setAttribute("aria-pressed", String(!!state.torch));
  }
  async function setTorch(on) {
    const track = torchTrack();
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); state.torch = on; }
    catch { toast("Lampan kunde inte ändras.", true); }
    updateTorchButton();
  }
  $("#torch").addEventListener("click", () => setTorch(!state.torch));
  $("#stop-scan").addEventListener("click", () => stopScanner());

  // Läser skriven kod i samma kamerabild (se ocr.js)
  async function startTextReading() {
    if (cfg.READ_WRITTEN_CODES === false) return;
    const status = $("#ocr-status");
    if (!status) return;
    const say = (t) => { status.textContent = t; status.hidden = false; };
    if (!window.LagerOCR) return say("Textläsningen är inte laddad. Ladda om sidan med Cmd + Shift + R.");
    say("Startar textläsning …");
    const { data, error } = await sb.rpc("staff_codes");
    if (!state.scanning) return;
    if (error) return say("Läsning av skriven kod är inte påslagen i databasen än. QR och streckkod fungerar.");
    state.ocrCodes = (data || []).map((r) => r.barcode).filter(Boolean);
    if (!state.ocrCodes.length) return say("Ingen klänning har en egen kod än. Skanna lappen en gång, så läggs den in.");
    let base = "";
    window.LagerOCR.start({
      video: $("#reader video"),
      getCodes: () => state.ocrCodes,
      isPaused: () => !state.scanning || !!state.current || state.busy,
      onStatus: (t) => { base = t; say(t); },
      // Visar vad kameran uppfattar, så att man ser om koden går att läsa
      onSeen: (seen) => say(seen ? `${base} · ser: ${seen.slice(0, 24)}` : `${base} · ser ingen text`),
      onMatch: (m) => {
        if (state.current || state.busy) return;
        pauseScanner();
        state.readNote = m.quality === "exact"
          ? `Läste koden ${m.code}`
          : `Koden var otydlig och tolkades som ${m.code}. Kontrollera att modell och storlek stämmer.`;
        openProduct(m.code);
      },
    });
  }

  async function stopScanner() {
    window.LagerOCR?.stop();
    $("#ocr-status").hidden = true;
    $("#cam-tools").hidden = true;
    state.torch = false;   // lampan släcks när kameran stängs
    if (state.scanner && state.scanning) {
      try { await state.scanner.stop(); } catch {}
      try { state.scanner.clear(); } catch {}
    }
    state.scanning = false;
    state.current = null;
    state.edit = null; state.editing = false;
    resetPhoto();
    $(".scan-card").classList.remove("has-result");
    $("#scan-result").hidden = true;
    $("#scan-idle").hidden = false;
  }

  function pauseScanner() { try { if (state.scanning) state.scanner.pause(true); } catch {} }
  function resumeScanner() { try { if (state.scanning) state.scanner.resume(); } catch {} }

  async function onScan(text) {
    if (state.current || state.busy) return;
    pauseScanner();
    await openProduct(text.trim());
  }

  $("#manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pauseScanner();
    await openProduct(e.target.code.value.trim());
    e.target.reset();
  });

  const isAdmin = () => state.me?.role === "admin";
  // Koder: 3–120 tecken, bokstäver (också å ä ö), siffror, mellanslag och tecken som . _ - (inga styrtecken)
  const CODE_RE = /^[^\x00-\x1F\x7F]{3,120}$/;

  // ---------- Foto på utskick ----------
  // PHOTO_ON_SHIP i config.js: "required" (standard), "optional" eller "off"
  const photoMode = () => (["required", "optional", "off"].includes(cfg.PHOTO_ON_SHIP) ? cfg.PHOTO_ON_SHIP : "required");
  const isThumb = (s) => typeof s === "string" && s.startsWith("data:image/jpeg;base64,");

  // Krymper bilden i webbläsaren: en uppladdning (längsta sidan 1280 px) och en miniatyr (160 px)
  async function shrinkPhoto(file) {
    const img = await createImageBitmap(file, { imageOrientation: "from-image" });
    const draw = (max) => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c;
    };
    const blob = await new Promise((res) => draw(1280).toBlob(res, "image/jpeg", 0.72));
    if (!blob) throw new Error("ingen bild");
    const thumb = draw(160).toDataURL("image/jpeg", 0.6);
    img.close?.();
    return { blob, thumb };
  }

  async function uploadPhoto(blob) {
    const d = new Date();
    const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.jpg`;
    const { error } = await sb.storage.from("utskick").upload(path, blob, { contentType: "image/jpeg", upsert: false });
    return error ? null : path;
  }

  function resetPhoto() {
    if (state.photo) URL.revokeObjectURL(state.photo.url);
    state.photo = null;
    $("#photo-preview").removeAttribute("src");
    renderPhotoStep();
  }

  function renderPhotoStep() {
    const mode = photoMode(), has = !!state.photo;
    $("#photo-step").hidden = mode === "off";
    $("#photo-take").hidden = has;
    $("#photo-view").hidden = !has;
  }

  $("#photo-take").addEventListener("click", () => $("#photo-input").click());
  $("#photo-retake").addEventListener("click", () => $("#photo-input").click());
  $("#photo-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { blob, thumb } = await shrinkPhoto(file);
      resetPhoto();
      state.photo = { blob, thumb, url: URL.createObjectURL(blob) };
      $("#photo-preview").src = state.photo.url;
      renderPhotoStep();
    } catch {
      toast("Bilden kunde inte läsas. Prova en annan bild.", true);
    }
  });

  // ---------- Visa skannad klänning ----------
  async function openProduct(code) {
    if (!CODE_RE.test(code)) {
      toast("Koden kunde inte läsas. Försök igen eller skriv in den.", true);
      return resumeScanner();
    }
    state.busy = true;
    const { data, error } = await sb.rpc("scan_info", { p_code: code });
    state.busy = false;
    if (error || !data) {
      toast(errMsg(error), true);
      return resumeScanner();
    }
    resetPhoto();
    state.current = { code, ...data };
    loadSuggestions();
    showResult();
    if (navigator.vibrate) navigator.vibrate(60);
  }

  // Ritar rutan för den skannade koden. Även en ny kod visas, med märket "Ny"
  function showResult() {
    const c = state.current;
    const track = c.known && c.track_stock;
    // Namn, färg och storlek visas som text och kan ändras innan man sparar
    if (state.edit?.code !== c.code) {
      state.edit = { code: c.code, name: c.name, color: c.color || "", size: c.size || "" };
      state.editing = !c.known && (!c.color || !c.size);   // ny kod utan färg eller storlek: fälten visas direkt
    }
    renderFields();
    $("#res-price").textContent = c.price == null ? "Inget pris" : [`${fmt(c.price)} kr`, c.material].filter(Boolean).join(" · ");
    $("#res-status").textContent = c.status || "";
    $("#res-status").hidden = !c.known || !c.status;
    const avail = c.reserved > 0 ? `${fmt(c.reserved)} reserverad · ${fmt(c.available)} lediga` : "";
    $("#res-avail").textContent = avail;
    $("#res-avail").hidden = !avail;
    $("#sold-price").value = c.price ?? "";
    state.soldPrice0 = c.price ?? null;
    $("#res-go-reserved").hidden = true;
    $("#reserve-box").hidden = true;
    $("#res-stock").replaceChildren(...(track
      ? ["I lager: ", h("strong", { text: fmt(c.quantity) }), " st"]
      : ["Lagret räknas inte för den här"]));
    $("#res-new").hidden = c.known;
    $("#res-new").textContent = c.new_group ? "Ny grupp" : "Ny";
    $("#res-rename").hidden = !(isAdmin() && c.known);
    $("#res-note").textContent = state.readNote || ""; $("#res-note").hidden = !state.readNote; state.readNote = null;
    $("#qty").value = 1;
    $("#qty").max = 1000;
    $("#scan-result").hidden = false;
    $("#scan-idle").hidden = true;
    $(".scan-card").classList.add("has-result");
    renderPhotoStep();
  }

  // Namn, färg och storlek i skannern: text med knappen Ändra, eller fält när man redigerar
  function renderFields() {
    const c = state.current, e = state.edit;
    $("#res-name").textContent = e.name;
    $("#res-code").textContent = c.code;
    $("#res-color").textContent = e.color || "–";
    $("#res-size").textContent = e.size || "–";
    $("#fields-view").hidden = state.editing;
    $("#fields-edit-box").hidden = !state.editing;
    $("#edit-name-label").hidden = c.known;   // namnet för en känd kod ändras med Byt namn
    $("#edit-name").value = e.name;
    $("#edit-color").value = e.color;
    $("#edit-size").value = e.size;
  }

  // Läser in ändringarna från fälten till state.edit
  function commitFields() {
    const c = state.current, e = state.edit;
    if (state.editing) {
      e.name = c.known ? e.name : ($("#edit-name").value.trim() || c.name);
      e.color = $("#edit-color").value.trim();
      e.size = $("#edit-size").value.trim();
      state.editing = false;
    }
    renderFields();
  }

  $("#fields-edit").addEventListener("click", () => {
    state.editing = true;
    renderFields();
    $("#edit-color").focus();
  });
  $("#fields-done").addEventListener("click", commitFields);

  // Förslag för fälten Namn och Färg, från klänningar som redan finns
  async function loadSuggestions() {
    const { data, error } = await sb.rpc("staff_products");
    if (error || !data) return;
    const uniq = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, "sv"));
    $("#name-options").replaceChildren(...uniq(data.map((p) => p.name)).map((v) => h("option", { value: v })));
    $("#color-options").replaceChildren(...uniq(data.map((p) => p.color)).map((v) => h("option", { value: v })));
  }

  // Hämtar infon igen, till exempel efter ett namnbyte
  async function refreshCurrent() {
    const code = state.current?.code;
    if (!code) return;
    const { data } = await sb.rpc("scan_info", { p_code: code });
    if (data && state.current?.code === code) { state.current = { code, ...data }; state.edit = null; showResult(); }
  }

  const clampQty = () => {
    const max = Number($("#qty").max) || 1;
    let v = Math.round(Number($("#qty").value) || 1);
    $("#qty").value = Math.min(max, Math.max(1, v));
  };
  $("#qty-minus").addEventListener("click", () => { $("#qty").value = Number($("#qty").value) - 1; clampQty(); });
  $("#qty-plus").addEventListener("click", () => { $("#qty").value = Number($("#qty").value) + 1; clampQty(); });
  $("#qty").addEventListener("change", clampQty);

  function closeResult() {
    dataCache = null;
    state.current = null;
    state.edit = null; state.editing = false;
    resetPhoto();
    if (!$("#picker").hidden) loadPicker();
    $(".scan-card").classList.remove("has-result");
    $("#scan-result").hidden = true;
    if (state.scanning) resumeScanner(); else $("#scan-idle").hidden = false;
  }
  $("#res-cancel").addEventListener("click", closeResult);

  // Lägg in (inget foto krävs) eller Såld (foto enligt PHOTO_ON_SHIP). Samma flöde för båda.
  async function saveAction(kind) {
    const c = state.current;
    if (!c || state.busy) return;
    if (kind === "sold" && photoMode() === "required" && !state.photo) return toast("Ta ett foto på klänningen först.", true);
    commitFields();
    clampQty();
    const amount = Number($("#qty").value);
    const priceRaw = $("#sold-price").value.trim().replace(",", ".");
    const soldPrice = priceRaw === "" ? null : Number(priceRaw);
    if (kind === "sold" && soldPrice !== null && (!Number.isFinite(soldPrice) || soldPrice < 0 || soldPrice > 9999999))
      return toast("Ogiltigt pris", true);
    if (kind === "sold" && c.known && c.track_stock && amount > c.quantity)
      return toast(`Det finns bara ${fmt(c.quantity)} st i lager.`, true);
    const btns = [$("#res-in"), $("#res-sold")];
    state.busy = true; btns.forEach((b) => (b.disabled = true));
    try {
      let path = null, thumb = null;
      if (state.photo) {
        path = await uploadPhoto(state.photo.blob);
        if (!path) return toast("Fotot kunde inte laddas upp. Försök igen.", true);
        thumb = state.photo.thumb;
      }
      // Bara det som ändrats skickas med. null betyder "som det är"
      const e = state.edit;
      const diff = (v, orig) => (v !== orig ? v : null);
      const { data, error } = await sb.rpc(kind === "in" ? "stock_in" : "ship", {
        p_code: c.code, p_amount: amount, p_photo_path: path, p_photo_thumb: thumb,
        p_name: c.known ? null : diff(e.name, c.name),
        p_color: diff(e.color, c.color || ""),
        p_size: diff(e.size, c.size || ""),
        // Bara om priset har ändrats. Utelämnat betyder ordinarie pris
        ...(kind === "sold" ? { p_price: soldPrice !== state.soldPrice0 ? soldPrice : null } : {}),
      });
      if (error) {
        if ((error.message || "").includes("är reserverad")) $("#res-go-reserved").hidden = false;
        const noStock = (error.message || "").includes("Det finns inte så många kvar i lager");
        return toast(noStock ? "Det finns inga kvar i lager. Tryck Lägg in om en ny har kommit." : errMsg(error), true);
      }
      const what = [data.name, data.color, data.size && `Stl ${data.size}`].filter(Boolean).join(" · ");
      if (kind === "in") toast(`Inlagd: ${what}. ${fmt(data.quantity)} i lager nu.`);
      else toast(`Såld: ${what}. ${amount} st${data.track_stock ? `, ${fmt(data.quantity)} kvar` : ""}.`);
      closeResult();
    } finally {
      state.busy = false; btns.forEach((b) => (b.disabled = false));
    }
  }
  $("#res-in").addEventListener("click", () => saveAction("in"));
  $("#res-sold").addEventListener("click", () => saveAction("sold"));

  // Reserverad: ett kort formulär i samma ruta. Klänningen stannar i lagret men är upptagen
  $("#res-reserve").addEventListener("click", () => {
    const box = $("#reserve-box");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#reserve-customer").focus();
  });
  $("#reserve-cancel").addEventListener("click", () => { $("#reserve-box").hidden = true; });
  $("#reserve-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = state.current;
    if (!c || state.busy) return;
    commitFields(); clampQty();
    const amount = Number($("#qty").value);
    const e2 = state.edit;
    const diff = (v, orig) => (v !== orig ? v : null);
    const btn = e.target.querySelector("[type=submit]");
    state.busy = true; btn.disabled = true;
    try {
      let path = null, thumb = null;
      if (state.photo) {
        path = await uploadPhoto(state.photo.blob);
        if (!path) return toast("Fotot kunde inte laddas upp. Försök igen.", true);
        thumb = state.photo.thumb;
      }
      const customer = $("#reserve-customer").value.trim();
      const { data, error } = await sb.rpc("reserve", {
        p_code: c.code, p_amount: amount,
        p_name: c.known ? null : diff(e2.name, c.name),
        p_color: diff(e2.color, c.color || ""),
        p_size: diff(e2.size, c.size || ""),
        p_customer: customer,
        p_contact: $("#reserve-contact").value.trim(),
        p_event_date: $("#reserve-date").value || null,
        p_note: $("#reserve-note").value.trim(),
        p_photo_path: path, p_photo_thumb: thumb,
      });
      if (error) return toast(errMsg(error), true);
      e.target.reset();
      closeResult();
      notice(customer ? `Reserverad åt ${customer}.` : `Reserverad: ${data.name}.`, false, { label: "Visa reserverade", run: () => showTab("reserved") });
    } finally {
      state.busy = false; btn.disabled = false;
    }
  });

  $("#res-fitting").addEventListener("click", async () => {
    const c = state.current;
    if (!c?.known) return toast("Lägg in klänningen först.", true);
    const { data, error } = await sb.rpc("add_fitting", { p_code: c.code });
    if (error) return toast(errMsg(error), true);
    toast(`Provning +1. ${word(data, "provning", "provningar")} hittills.`);
  });
  $("#res-go-reserved").addEventListener("click", () => showTab("reserved"));

  $("#res-rename").addEventListener("click", async () => {
    const c = state.current;
    if (c?.known && (await renameProduct(c))) refreshCurrent();
  });

  // ---------- Admin: Byta namn ----------
  // Med "byt på alla" får alla klänningar med samma namn det nya namnet. Det samlar också grupper.
  async function renameProduct(p) {
    const { data: all, error } = await sb.from("products").select("id, name");
    if (error) { toast(errMsg(error), true); return false; }
    const key = p.name.toLowerCase();
    const same = all.filter((x) => x.name.toLowerCase() === key).length;
    const names = [...new Set(all.map((x) => x.name))].sort((a, b) => a.localeCompare(b, "sv"));
    $("#rename-names").replaceChildren(...names.map((n) => h("option", { value: n })));
    const dlg = $("#dlg-rename"), f = $("#rename-form");
    f.newname.value = p.name;
    f.whole.checked = true;
    $("#rename-whole-text").textContent = `Byt på alla med samma namn (${fmt(same)} st)`;
    return new Promise((resolve) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const { data: n, error: err } = await sb.rpc("rename_product", {
          p_product: p.id, p_name: f.newname.value.trim(), p_whole_group: f.whole.checked,
        });
        if (err) return toast(errMsg(err), true);
        f.onsubmit = null; dlg.onclose = null; dlg.close();
        dataCache = null;
        toast(`Namnet är bytt på ${fmt(n)} st.`);
        resolve(true);
      };
      dlg.onclose = () => { f.onsubmit = null; resolve(false); };
      dlg.showModal();
      f.newname.focus();
    });
  }

  // ---------- Admin: Översikt ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }

  // Tooltip som delas av alla grafer (mus + tangentbord)
  const tip = $("#chart-tip");
  function showTip(e, lines) {
    tip.replaceChildren(...lines.flatMap((l, i) => [i ? h("br") : null, typeof l === "string" ? l : h("strong", { text: l.b })]).filter(Boolean));
    tip.hidden = false;
    const r = e.target.getBoundingClientRect();
    const x = e.clientX ?? (r.left + r.width / 2), y = e.clientY ?? r.top;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, x - tw / 2)) + "px";
    tip.style.top = Math.max(8, y - th - 12) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  function withTip(el, lines) {
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", lines.map((l) => (typeof l === "string" ? l : l.b)).join(", "));
    el.addEventListener("pointermove", (e) => showTip(e, lines));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", (e) => showTip(e, lines));
    el.addEventListener("blur", hideTip);
    return el;
  }
  window.addEventListener("scroll", hideTip, { passive: true });

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function tableView(head, rows) {
    return h("details", { class: "table-view", open: true },
      h("summary", { text: "Visa siffror" }),
      h("div", { class: "tw" }, h("table", {},
        h("thead", {}, h("tr", {}, ...head.map((t) => h("th", { text: t })))),
        h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", { text: String(c) }))))))));
  }

  // Stapeldiagram (lodrätt), en serie. Siffror på alla staplar när det finns plats, annars bara på den högsta
  function columnChart(el, items, { unit = "st", tipTitle = (d) => d.label, tipExtra, labelEvery, emptyText = "Inget att visa än." } = {}) {
    if (!items.some((d) => d.value > 0)) {
      return el.replaceChildren(h("p", { class: "chart-empty", text: emptyText }));
    }
    const W = Math.max(280, el.clientWidth || 600), H = 190;
    const m = { t: 18, r: 4, b: 24, l: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let max = niceMax(Math.max(...items.map((d) => d.value)));
    if (max % 2) max += 1;   // hela tal på mittlinjen
    const band = iw / items.length;
    const bw = Math.min(24, band * 0.62);
    const y = (v) => m.t + ih - (v / max) * ih;
    const every = labelEvery || (band < 34 ? Math.ceil(34 / band) : 1);
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": items.map((d) => `${d.label}: ${d.value} ${unit}`).join(", ") });

    for (const t of [0, max / 2, max]) {
      root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(t) + .5, y2: y(t) + .5 }));
      root.append(svg("text", { class: "tick", x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, fmt(t)));
    }
    const maxVal = Math.max(...items.map((d) => d.value));
    const showAll = band >= 30;
    let maxLabeled = false;
    items.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      const x = cx - bw / 2, top = y(d.value), hgt = m.t + ih - top;
      const g = svg("g");
      if (d.value > 0) {
        const r = Math.min(4, hgt, bw / 2);
        g.append(svg("path", { class: "mark", d: `M${x},${m.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${m.t + ih} Z` }));
      }
      if (d.value > 0 && (showAll || (d.value === maxVal && !maxLabeled))) {
        if (d.value === maxVal) maxLabeled = true;
        g.append(svg("text", { class: "val", x: cx, y: top - 6, "text-anchor": "middle" }, fmt(d.value)));
      }
      if ((items.length - 1 - i) % every === 0) {   // räkna från höger så att "Idag" alltid syns
        g.append(svg("text", { class: "axis-label", x: cx, y: H - 6, "text-anchor": "middle" }, d.short ?? d.label));
      }
      const hit = svg("rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: ih });
      withTip(hit, [tipTitle(d), { b: `${fmt(d.value)} ${unit}` }, ...(tipExtra ? tipExtra(d) : [])]);
      g.append(hit);
      root.append(g);
    });
    el.replaceChildren(root);
  }

  // Två staplar per dag eller modell: inlagt (grå) och sålt (blå), i samma skala
  function pairChart(el, items, { emptyText = "Inget att visa än.", tipTitle = (d) => d.label, tipExtra } = {}) {
    if (!items.some((d) => d.a > 0 || d.b > 0)) return el.replaceChildren(h("p", { class: "chart-empty", text: emptyText }));
    const W = Math.max(280, el.clientWidth || 600), H = 200;
    const m = { t: 18, r: 4, b: 24, l: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let max = niceMax(Math.max(...items.map((d) => Math.max(d.a, d.b))));
    if (max % 2) max += 1;
    const band = iw / items.length;
    const bw = Math.max(3, Math.min(12, band * 0.32));
    const y = (v) => m.t + ih - (v / max) * ih;
    const every = band < 34 ? Math.ceil(34 / band) : 1;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": items.map((d) => `${d.label}: ${fmt(d.a)} inlagda, ${fmt(d.b)} sålda`).join(", ") });
    for (const t of [0, max / 2, max]) {
      root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(t) + .5, y2: y(t) + .5 }));
      root.append(svg("text", { class: "tick", x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, fmt(t)));
    }
    items.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      const g = svg("g");
      for (const [x, v, cls] of [[cx - bw - 1, d.a, "pair-in"], [cx + 1, d.b, "pair-out"]]) {
        if (v <= 0) continue;
        g.append(svg("rect", { class: "mark " + cls, x, y: y(v), width: bw, height: m.t + ih - y(v) }));
      }
      if (band >= 30 && d.b > 0) g.append(svg("text", { class: "val", x: cx + 1 + bw / 2, y: y(d.b) - 5, "text-anchor": "middle" }, fmt(d.b)));
      if ((items.length - 1 - i) % every === 0) g.append(svg("text", { class: "axis-label", x: cx, y: H - 6, "text-anchor": "middle" }, d.short ?? d.label));
      const hit = svg("rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: ih });
      withTip(hit, [tipTitle(d), { b: `Inlagt: ${fmt(d.a)} st` }, { b: `Sålt: ${fmt(d.b)} st` }, ...(tipExtra ? tipExtra(d) : [])]);
      g.append(hit);
      root.append(g);
    });
    el.replaceChildren(pairLegend(), root);
  }
  const pairLegend = () => h("div", { class: "pair-legend" },
    h("span", { class: "key" }, h("span", { class: "sw pair-in" }), "Inlagt"),
    h("span", { class: "key" }, h("span", { class: "sw pair-out" }), "Sålt"));

  // Liggande par per modell: en rad med två smala staplar
  function pairBars(el, items) {
    if (!items.length) return el.replaceChildren(h("p", { class: "chart-empty", text: "Inga händelser under perioden." }));
    const max = Math.max(...items.flatMap((d) => [d.a, d.b])) || 1;
    const line = (cls, v) => h("span", { class: "pair-line" },
      h("span", { class: "track" }, h("span", { class: "fill " + cls, style: `width:${(v / max) * 100}%` })),
      h("span", { class: "num", text: fmt(v) }));
    el.replaceChildren(pairLegend(), h("div", { class: "hbars" }, ...items.map((d) =>
      withTip(h("div", { class: "pair-row" },
        h("span", { class: "name", text: d.label }),
        h("span", { class: "pair-bars" }, line("pair-in", d.a), line("pair-out", d.b))),
        [d.label, { b: `Inlagt: ${fmt(d.a)} st` }, { b: `Sålt: ${fmt(d.b)} st` }]))));
  }

  // Liggande staplar, en serie. Items kan ha share (andel i %), tipLine, numText och extra (fler rader i tooltipen)
  function hbarChart(el, items, { unit = "st", emptyText = "Inget sålt under perioden." } = {}) {
    if (!items.length) return el.replaceChildren(h("p", { class: "chart-empty", text: emptyText }));
    const max = Math.max(...items.map((d) => d.value)) || 1;
    el.replaceChildren(h("div", { class: "hbars" }, ...items.map((d) =>
      withTip(h("div", { class: "hbar" },
        h("span", { class: "name", text: d.label }),
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${(d.value / max) * 100}%` })),
        h("span", { class: "num", text: d.numText ?? (d.share != null ? `${fmt(d.value)} · ${d.share} %` : fmt(d.value)) })),
        [d.label, { b: d.tipLine ?? `${fmt(d.value)} ${unit}` }, ...(d.extra || [])]))));
  }

  // Tydliga, kraftiga färger (inte dämpade). Grått är alltid "Övriga"
  const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#9333ea", "#0891b2", "#db2777", "#65a30d"];
  const OTHER_COLOR = "#6b7280";

  // Cirkeldiagram med en stapel och en kryssruta per post. Kryssa bort posterna man inte vill se.
  const pieState = {};
  function pieChart(el, items, { emptyText = "Inget att visa." } = {}) {
    const key = el.id;
    const st = (pieState[key] ||= { excluded: new Set() });
    Object.assign(st, { el, items: items.filter((d) => d.value > 0).sort((x, y) => y.value - x.value), emptyText });
    drawPie(key);
  }

  function drawPie(key) {
    const st = pieState[key], el = st.el;
    if (!st.items.length) return el.replaceChildren(h("p", { class: "chart-empty", text: st.emptyText }));
    const colorOf = (label) => {
      const i = st.items.findIndex((d) => d.label === label);
      return i < PALETTE.length ? PALETTE[i] : OTHER_COLOR;
    };
    const shown = st.items.filter((d) => !st.excluded.has(d.label));
    const total = sum(shown, (d) => d.value);
    const maxAll = Math.max(...st.items.map((d) => d.value));

    // Cirkeln: de valda posterna. Högst åtta bitar, resten blir "Övriga"
    let slices = shown;
    if (shown.length > PALETTE.length) {
      const rest = shown.slice(PALETTE.length - 1);
      slices = [...shown.slice(0, PALETTE.length - 1), { label: `Övriga (${rest.length})`, value: sum(rest, (d) => d.value), other: true }];
    }
    const C = 100, R = 96;
    let pie;
    if (!shown.length) {
      pie = h("p", { class: "chart-empty", text: "Inget valt. Kryssa i minst en rad." });
    } else {
      pie = svg("svg", { viewBox: "0 0 200 200", role: "img", class: "pie",
        "aria-label": slices.map((d) => `${d.label}: ${fmt(d.value)} st`).join(", ") });
      let a0 = -Math.PI / 2;
      slices.forEach((d, i) => {
        const color = d.other ? OTHER_COLOR : colorOf(d.label);
        const lines = [d.label, { b: `${fmt(d.value)} st · ${pct(d.value, total)} %` }];
        if (slices.length === 1) { pie.append(withTip(svg("circle", { cx: C, cy: C, r: R, fill: color }), lines)); return; }
        const frac = d.value / total, a1 = a0 + frac * 2 * Math.PI;
        const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0), x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
        pie.append(withTip(svg("path", { d: `M${C},${C} L${x0},${y0} A${R},${R} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1},${y1} Z`, fill: color, class: "slice" }), lines));
        a0 = a1;
      });
    }

    // En rad per post: kryssruta, färg, namn, stapel och antal
    const rows = st.items.map((d) => {
      const on = !st.excluded.has(d.label);
      return h("label", { class: "legrow" + (on ? "" : " off") },
        h("input", { type: "checkbox", checked: on || null, onchange: () => {
          on ? st.excluded.add(d.label) : st.excluded.delete(d.label);
          drawPie(key);
        } }),
        h("span", { class: "sw", style: `background:${colorOf(d.label)}` }),
        h("span", { class: "lname", text: d.label }),
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${(d.value / maxAll) * 100}%; background:${colorOf(d.label)}` })),
        h("span", { class: "lnum", text: `${fmt(d.value)} st · ${pct(d.value, sum(st.items, (x) => x.value))} %` }));
    });
    const tools = st.excluded.size
      ? h("button", { class: "btn small", type: "button", text: "Visa alla", onclick: () => { st.excluded.clear(); drawPie(key); } })
      : null;
    el.replaceChildren(h("div", { class: "pie-wrap" }, pie), h("div", { class: "legend" }, tools, ...rows));
  }

  const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const sizeRank = (s) => {
    const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
    if (i >= 0) return [0, i];
    const n = parseFloat(s);
    return Number.isFinite(n) ? [1, n] : [2, String(s)];
  };
  const bySize = (a, b) => { const x = sizeRank(a), y = sizeRank(b); return x[0] - y[0] || (x[1] > y[1] ? 1 : x[1] < y[1] ? -1 : 0); };

  // Grupperar rader efter modellnamn, oavsett stora och små bokstäver. Varianterna sorteras på färg och storlek
  function groupByModel(list) {
    const map = new Map();
    for (const p of list) {
      const k = p.name.toLowerCase();
      if (!map.has(k)) map.set(k, { key: k, name: p.name, items: [] });
      map.get(k).items.push(p);
    }
    for (const g of map.values()) g.items.sort((a, b) => (a.color || "").localeCompare(b.color || "", "sv") || bySize(a.size, b.size));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "sv"));
  }

  // Summerar utskick per nyckel. pick(m) ger [nyckel, namn att visa]
  function tallyBy(list, pick) {
    const map = new Map();
    for (const m of list) {
      const [key, label] = pick(m);
      const e = map.get(key) || { key, label, value: 0 };
      e.value -= m.change;
      map.set(key, e);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }
  const withShare = (list, total) => list.map((d) => ({ ...d, share: pct(d.value, total), tipLine: `${fmt(d.value)} st · ${pct(d.value, total)} %` }));

  const DAY = 864e5;
  const PERIODS = [7, 30, 90];
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayLabel = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
  const addTable = (id, head, rows) => { if (rows.length) $(`#${id}`).append(tableView(head, rows)); };

  let period = Number(pref.get("lager-period"));
  if (!PERIODS.includes(period)) period = 30;
  function markPeriod() {
    document.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.period) === period)));
    document.querySelectorAll("[data-ptext]").forEach((el) => (el.textContent = `senaste ${period} dagarna`));
  }
  $(".period").addEventListener("click", (e) => {
    const b = e.target.closest("[data-period]");
    if (!b) return;
    period = Number(b.dataset.period);
    pref.set("lager-period", String(period));
    loadOverview();
  });

  // Hämtar hela tabellen i sidor om 1 000 rader (Supabase returnerar annars bara de första 1 000)
  async function fetchAll(make) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      if (error) return { error };
      rows.push(...data);
      if (data.length < 1000) return { data: rows };
    }
  }

  // Varje graf har en egen modellväljare (data-mfilter). "" betyder alla modeller
  const scopeOf = (key) => document.querySelector(`[data-mfilter="${key}"]`)?.value ?? "";
  function fillScopeSelects(list) {
    const names = [...new Map(list.map((p) => [p.name.toLowerCase(), p.name])).entries()]
      .sort((x, y) => x[1].localeCompare(y[1], "sv"));
    document.querySelectorAll("[data-mfilter]").forEach((sel) => {
      const prev = sel.value;
      sel.replaceChildren(h("option", { value: "", text: "Alla modeller" }), ...names.map(([k, n]) => h("option", { value: k, text: n })));
      sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
    });
  }
  const modelIs = (name, mk) => !mk || (name || "").toLowerCase() === mk;

  let redrawCharts = null;
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redrawCharts?.(), 150); });

  // Hämtar det som översikten och Klänningar visar. Sparas en stund, så att flikarna inte hämtar om i onödan
  let dataCache = null;
  async function getData(force = false) {
    if (!force && dataCache && Date.now() - dataCache.at < 60000) return dataCache;
    const now = Date.now();
    const movesQ = () => sb.from("stock_movements")
      .select("id, product_id, change, source, created_at, photo_path, unit_price, unit_cost, reservation_id, products(name, color, size, collection, dress_type), profiles(full_name)")
      .gte("created_at", new Date(now - 180 * DAY).toISOString())
      .order("created_at", { ascending: false }).order("id", { ascending: false });
    const prodQ = () => sb.from("products")
      .select("*")
      .order("name").order("id");
    const profQ = () => sb.from("profiles").select("id, role").order("id");
    // De senaste foton: bara miniatyrerna för åtta rader, så att hela listan inte behöver hämtas
    const recentQ = () => sb.from("stock_movements")
      .select("id, change, created_at, photo_path, photo_thumb, products(name, color, size), profiles(full_name)")
      .not("photo_thumb", "is", null).lt("change", 0)
      .order("created_at", { ascending: false }).limit(8);
    const resQ = () => sb.from("reservations").select("price, amount").eq("status", "open");
    const [prod, prof, mov, recent, res] = await Promise.all([fetchAll(prodQ), fetchAll(profQ), fetchAll(movesQ), recentQ(), resQ()]);
    const error = prod.error || prof.error || mov.error || recent.error || res.error;
    if (error) return { error };
    dataCache = { at: Date.now(), products: prod.data, people: prof.data, moves: mov.data, recent: recent.data, reservations: res.data };
    return dataCache;
  }

  // Alla beräkningar för en uppsättning klänningar och händelser. Varje graf kör den på sitt eget urval
  function compute(products, moves) {
    const todayMs = startOfDay(Date.now());
    const off = (m) => Math.round((todayMs - startOfDay(new Date(m.created_at).getTime())) / DAY);
    const units = (list) => sum(list, (m) => -m.change);
    const outs = moves.filter((m) => m.change < 0);
    const cur = outs.filter((m) => off(m) < period);
    const prev = outs.filter((m) => off(m) >= period && off(m) < 2 * period);
    const insCur = moves.filter((m) => m.change > 0 && off(m) < period);
    const insPrev = moves.filter((m) => m.change > 0 && off(m) >= period && off(m) < 2 * period);
    const tracked = products.filter((p) => p.track_stock);

    const byModel = tallyBy(cur, (m) => { const n = m.products?.name ?? "Borttagen klänning"; return [n.toLowerCase(), n]; });
    const colorTally = tallyBy(cur, (m) => { const c = m.products?.color || "Utan färg"; return [c.toLowerCase(), c]; });
    const peopleTally = tallyBy(cur, (m) => {
      const n = m.source === "webbshop" ? "Webbshop" : m.profiles?.full_name ?? "Borttagen användare";
      return [n, n];
    });
    const sizeOut = tallyBy(cur, (m) => { const s = m.products?.size || "–"; return [s, s]; })
      .sort((x, y) => bySize(x.label, y.label))
      .map((d) => ({ label: `Storlek ${d.label}`, short: d.label, value: d.value }));
    const sizeMap = new Map();
    for (const p of tracked) { const k = p.size || "–"; sizeMap.set(k, (sizeMap.get(k) || 0) + p.quantity); }
    const sizesLeft = [...sizeMap].sort((x, y) => bySize(x[0], y[0])).map(([k, v]) => ({ label: `Storlek ${k}`, short: k, value: v }));
    const DAYS = [["Måndag", "Mån"], ["Tisdag", "Tis"], ["Onsdag", "Ons"], ["Torsdag", "Tors"], ["Fredag", "Fre"], ["Lördag", "Lör"], ["Söndag", "Sön"]];
    const weekday = DAYS.map(([label, short]) => ({ label, short, value: 0 }));
    for (const m of cur) weekday[(new Date(m.created_at).getDay() + 6) % 7].value -= m.change;

    // Inlagt och sålt per modell (de åtta med flest händelser)
    const pairMap = new Map();
    for (const m of moves.filter((x) => off(x) < period)) {
      const n = m.products?.name ?? "Borttagen klänning", k = n.toLowerCase();
      const e = pairMap.get(k) || { label: n, a: 0, b: 0 };
      if (m.change > 0) e.a += m.change; else e.b -= m.change;
      pairMap.set(k, e);
    }
    const pairModels = [...pairMap.values()].sort((x, y) => (y.a + y.b) - (x.a + x.b)).slice(0, 8);

    // Staplar per dag (7 och 30 dagar) eller per vecka (90 dagar)
    const bs = period === 90 ? 7 : 1;
    const nb = Math.ceil(period / bs);
    const base = new Date(); base.setHours(12, 0, 0, 0);
    const buckets = Array.from({ length: nb }, (_, i) => {
      const newest = new Date(base); newest.setDate(base.getDate() - i * bs);
      const oldest = new Date(base); oldest.setDate(base.getDate() - (i * bs + bs - 1));
      return {
        value: 0, inValue: 0, rev: 0, models: new Map(),
        short: bs === 1 ? (i === 0 ? "Idag" : dayLabel(newest)) : dayLabel(oldest),
        label: bs === 1
          ? newest.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })
          : `Vecka ${dayLabel(oldest)} – ${dayLabel(newest)}`,
      };
    });
    for (const m of insCur) { const b = buckets[Math.floor(off(m) / bs)]; if (b) b.inValue += m.change; }
    for (const m of cur) {
      const b = buckets[Math.floor(off(m) / bs)];
      if (!b) continue;
      const n = m.products?.name ?? "Borttagen klänning";
      b.value -= m.change;
      b.models.set(n, (b.models.get(n) || 0) + -m.change);
    }
    // Sålt för (intäkt) per dag/vecka, och vinst där både pris och inköpspris finns
    const priced = cur.filter((m) => m.unit_price != null);
    for (const m of priced) { const b = buckets[Math.floor(off(m) / bs)]; if (b) b.rev += m.unit_price * -m.change; }
    const revenue = sum(priced, (m) => m.unit_price * -m.change);
    const costed = priced.filter((m) => m.unit_cost != null);
    const profit = sum(costed, (m) => (m.unit_price - m.unit_cost) * -m.change);
    const costedRevenue = sum(costed, (m) => m.unit_price * -m.change);
    const margin = costedRevenue ? Math.round((profit / costedRevenue) * 1000) / 10 : null;
    const costedCount = costed.length;
    const revBy = (list, pick) => {
      const map = new Map();
      for (const m of list) {
        if (m.unit_price == null) continue;
        const [key, label] = pick(m);
        const e = map.get(key) || { key, label, value: 0 };
        e.value += m.unit_price * -m.change;
        map.set(key, e);
      }
      return [...map.values()].sort((x, y) => y.value - x.value);
    };
    const profitByModel = (() => {
      const map = new Map();
      for (const m of costed) {
        const n = m.products?.name ?? "Borttagen klänning", k = n.toLowerCase();
        const e = map.get(k) || { label: n, value: 0 };
        e.value += (m.unit_price - m.unit_cost) * -m.change;
        map.set(k, e);
      }
      return [...map.values()].sort((x, y) => y.value - x.value).slice(0, 10);
    })();
    const collectionOf = (m) => { const c = m.products?.collection || "Ingen kollektion"; return [c, c]; };
    const typeOf = (m) => { const t = m.products?.dress_type || "Ingen typ"; return [t, t]; };
    const collectionTally = tallyBy(cur, collectionOf);
    const typeTally = tallyBy(cur, typeOf);
    const collectionRev = new Map(revBy(cur, collectionOf).map((d) => [d.label, d.value]));
    const typeRev = new Map(revBy(cur, typeOf).map((d) => [d.label, d.value]));
    const revItems = buckets.slice().reverse().map((b) => ({ label: b.label, short: b.short, value: b.rev }));

    const dailyItems = buckets.slice().reverse().map((b) => ({ ...b, top: [...b.models].sort((x, y) => y[1] - x[1]).slice(0, 3) }));
    const pairDays = dailyItems.map((d) => ({ label: d.label, short: d.short, a: d.inValue, b: d.value, top: d.top }));

    // Räcker till: veckor kvar i nuvarande takt
    const stockByModel = new Map();
    for (const p of tracked) { const k = p.name.toLowerCase(); stockByModel.set(k, (stockByModel.get(k) || 0) + p.quantity); }
    const need = byModel.filter((d) => stockByModel.has(d.key) && d.value > 0).map((d) => {
      const stock = stockByModel.get(d.key);
      const rate = (d.value / period) * 7;
      const weeks = Math.round((stock / rate) * 10) / 10;
      return {
        label: d.label, value: weeks, numText: `${fmt(weeks)} ${weeks === 1 ? "vecka" : "veckor"}`,
        tipLine: `Räcker ca ${fmt(weeks)} ${weeks === 1 ? "vecka" : "veckor"}`,
        extra: [`${fmt(stock)} kvar · ${fmt(Math.round(rate * 10) / 10)} st per vecka`],
      };
    }).sort((x, y) => x.value - y.value);

    // Hur mycket finns kvar: per modell och per färg
    const kvarModels = groupByModel(tracked).map((g) => ({ label: g.name, value: sum(g.items, (p) => p.quantity) }));
    const kvarColorMap = new Map();
    for (const p of tracked) { const c = p.color || "Utan färg"; kvarColorMap.set(c, (kvarColorMap.get(c) || 0) + p.quantity); }
    const kvarColors = [...kvarColorMap].map(([label, value]) => ({ label, value }));

    const out = tracked.filter((p) => p.quantity === 0);
    const low = tracked.filter((p) => p.quantity > 0 && p.quantity <= p.low_stock_threshold);
    const ok = tracked.length - out.length - low.length;
    const models = new Set(products.map((p) => p.name.toLowerCase())).size;
    return {
      products, tracked, cur, curUnits: units(cur), prevUnits: units(prev), insUnits: sum(insCur, (m) => m.change),
      insPrevUnits: sum(insPrev, (m) => m.change), today: units(outs.filter((m) => off(m) === 0)),
      last7: units(outs.filter((m) => off(m) < 7)), withPhoto: cur.filter((m) => m.photo_path).length,
      byModel, colorTally, peopleTally, sizeOut, sizesLeft, weekday, pairModels, pairDays, dailyItems, need,
      kvarModels, kvarColors, out, low, ok, models, top: byModel[0],
      revenue, profit, margin, costedRevenue, costedCount, pricedCount: priced.length, revItems, profitByModel,
      collectionTally, typeTally, collectionRev, typeRev,
      untracked: products.length - tracked.length,
      inStock: sum(tracked, (p) => p.quantity), totalAdded: sum(tracked, (p) => p.total_added),
      sizesN: new Set(products.map((p) => p.size).filter(Boolean)).size,
      colorsN: new Set(products.map((p) => p.color).filter(Boolean)).size,
    };
  }

  async function loadOverview() {
    markPeriod();
    const d = await getData();
    if (d.error) return toast(errMsg(d.error), true);
    fillScopeSelects(d.products);

    // Nyckeltalen visar hela lagret. Varje graf räknar på sitt eget urval, och varje urval räknas bara en gång
    const cache = new Map();
    const scoped = (key) => {
      const mk = scopeOf(key);
      if (!cache.has(mk)) cache.set(mk, compute(d.products.filter((p) => modelIs(p.name, mk)),
        d.moves.filter((m) => modelIs(m.products?.name, mk))));
      return cache.get(mk);
    };
    const all = scoped("__all__");
    // Lagervärde och reservationer: hela lagret, oberoende av urval
    const tracked0 = d.products.filter((p) => p.track_stock);
    const lagerInkop = sum(tracked0.filter((p) => p.purchase_price != null), (p) => (Number(p.purchase_price) + Number(p.freight_cost || 0)) * p.quantity);
    const lagerForsaljning = sum(tracked0.filter((p) => priceOf(p) != null), (p) => priceOf(p) * p.quantity);
    const reservedCount = d.reservations.reduce((s, r) => s + (r.amount || 1), 0);
    const reservedSum = sum(d.reservations, (r) => Number(r.price || 0));
    const workers = d.people.filter((p) => p.role === "worker").length;
    const admins = d.people.length - workers;

    // --- Nyckeltal ---
    const stat = (labelTxt, value, sub) =>
      h("div", { class: "stat" },
        h("div", { class: "label", text: labelTxt }),
        h("div", { class: "value", text: value }),
        sub ? h("div", { class: "sub", text: sub }) : null);
    const pctOf = (cur, prev) => (prev ? `${cur >= prev ? "+" : "−"}${pct(Math.abs(cur - prev), prev)} % mot perioden innan` : cur ? "ny aktivitet" : "ingen förändring");
    $("#stats").replaceChildren(
      stat(`Inlagt senaste ${period} dagarna`, `${fmt(all.insUnits)} st`, pctOf(all.insUnits, all.insPrevUnits)),
      stat(`Sålt senaste ${period} dagarna`, `${fmt(all.curUnits)} st`, pctOf(all.curUnits, all.prevUnits)),
      stat("Skillnad (inlagt minus sålt)", `${all.insUnits - all.curUnits >= 0 ? "+" : "−"}${fmt(Math.abs(all.insUnits - all.curUnits))} st`, all.insUnits - all.curUnits >= 0 ? "lagret växer" : "lagret minskar"),
      stat("Sålt idag", `${fmt(all.today)} st`, `${fmt(all.last7)} st de senaste 7 dagarna`),
      stat("Sålt i snitt per dag", `${(all.curUnits / period).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} st`, `${fmt(all.withPhoto)} av ${word(all.cur.length, "försäljning", "försäljningar")} har foto`),
      stat("Mest såld modell", all.top ? all.top.label : "–", all.top ? `${fmt(all.top.value)} st under perioden` : "Inget sålt under perioden"),
      stat("Klänningar i lager", `${fmt(all.inStock)} st`, `av ${fmt(all.totalAdded)} st som lagts in totalt`),
      stat("Antal modeller", fmt(all.models), `${word(all.sizesN, "storlek", "storlekar")} och ${word(all.colorsN, "färg", "färger")}`),
      stat("Antal konton", fmt(workers + admins), `${word(workers, "arbetare", "arbetare")} och ${word(admins, "admin", "admin")}`),
      stat(`Sålt för senaste ${period} dagarna`, kr(all.revenue), `${fmt(all.pricedCount)} av ${word(all.cur.length, "försäljning", "försäljningar")} har pris`),
      stat("Vinst", kr(all.profit), `på ${word(all.costedCount, "försäljning", "försäljningar")} med pris och inköpspris`),
      stat("Marginal", all.margin == null ? "–" : `${all.margin.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`,
        all.margin == null ? "inga försäljningar med pris och inköpspris" : `vinst ${kr(all.profit)} av ${kr(all.costedRevenue)} sålt för, ${word(all.costedCount, "försäljning", "försäljningar")}`),
      stat("Lagervärde", kr(lagerInkop), `till försäljningspris: ${kr(lagerForsaljning)}`),
      stat("Reserverat", `${fmt(reservedCount)} st`, `${kr(reservedSum)} i öppna reservationer`),
    );

    // Legat längst i lager (klänningar som lagret räknas för, med antal dagar)
    const stuck = d.products.filter((p) => p.track_stock && p.quantity > 0)
      .map((p) => ({ p, days: lagerDagar(p) })).sort((x, y) => y.days - x.days).slice(0, 10);
    $("#ch-stuck").replaceChildren(...(stuck.length
      ? stuck.map(({ p, days }) => h("div", { class: "item" },
          h("div", { class: "main" },
            h("div", { class: "title" }, p.name, desc(p) ? h("span", { class: "muted", text: " · " + desc(p) }) : null),
            h("div", { class: "meta", text: `${word(days, "dag", "dagar")} i lager · ${fmt(p.quantity)} st · pris ${priceOf(p) != null ? kr(priceOf(p)) : "–"} · lagervärde ${priceOf(p) != null ? kr(priceOf(p) * p.quantity) : "–"}` }))))
      : [h("p", { class: "empty-state", text: "Inga klänningar som räknas i lager." })]));

    // --- Senaste utskick med foto ---
    $("#recent-photos").replaceChildren(...(d.recent.length
      ? d.recent.map((m) => h("button", { class: "recent-item", type: "button", onclick: () => showPhoto(m) },
          thumbNode(m, "thumb"),
          h("span", {},
            h("strong", { text: m.products?.name ?? "Borttagen klänning" }), h("br"),
            h("span", { class: "sub", text: [m.products && variantText(m.products), m.profiles?.full_name, fmtDate(m.created_at)].filter(Boolean).join(" · ") }))))
      : [h("p", { class: "empty-state", text: "Inga försäljningar med foto än." })]));

    // --- Grafer: varje graf med sitt urval ---
    const drawCharts = () => {
      const s = (key) => scoped(key);
      const daily = s("daily");
      pairChart($("#ch-daily"), daily.pairDays, {
        tipTitle: (x) => x.label,
        emptyText: "Ingen försäljning eller inläggning under perioden.",
        tipExtra: (x) => (x.top.length ? ["Mest sålda:", ...x.top.map(([n, v]) => `${n}: ${fmt(v)} st`)] : []),
      });
      addTable("ch-daily", ["Period", "Inlagt", "Sålt"], daily.pairDays.map((x) => [x.label, x.a, x.b]));

      const pm = s("pairModels");
      pairBars($("#ch-pair-models"), pm.pairModels);
      addTable("ch-pair-models", ["Modell", "Inlagt", "Sålt"], pm.pairModels.map((x) => [x.label, x.a, x.b]));

      const st = s("status");
      drawStatus(st);

      const nd = s("need");
      hbarChart($("#ch-need"), nd.need, { unit: "veckor", emptyText: "Inga modeller med försäljning och räknat lager under perioden." });
      addTable("ch-need", ["Modell", "Veckor kvar"], nd.need.map((x) => [x.label, x.value]));

      const bm = s("models");
      const topModels = withShare(bm.byModel.slice(0, 8), bm.curUnits);
      hbarChart($("#ch-models"), topModels);
      addTable("ch-models", ["Modell", "Sålt", "Andel"], topModels.map((x) => [x.label, x.value, `${x.share} %`]));

      const co = s("colors");
      const colors = withShare(co.colorTally, co.curUnits);
      hbarChart($("#ch-colors"), colors);
      addTable("ch-colors", ["Färg", "Sålt", "Andel"], colors.map((x) => [x.label, x.value, `${x.share} %`]));

      const so = s("sizesOut");
      columnChart($("#ch-sizes-out"), so.sizeOut, { labelEvery: 1 });
      addTable("ch-sizes-out", ["Storlek", "Sålt"], so.sizeOut.map((x) => [x.short, x.value]));

      const sl = s("sizesLeft");
      columnChart($("#ch-sizes-left"), sl.sizesLeft, { tipTitle: (x) => x.label, labelEvery: 1, emptyText: "Inga klänningar med räknat lager." });
      addTable("ch-sizes-left", ["Storlek", "Kvar"], sl.sizesLeft.map((x) => [x.short, x.value]));

      const wd = s("weekday");
      columnChart($("#ch-weekday"), wd.weekday, { tipTitle: (x) => x.label, labelEvery: 1 });
      addTable("ch-weekday", ["Veckodag", "Sålt"], wd.weekday.map((x) => [x.label, x.value]));

      const pe = s("people");
      const people2 = withShare(pe.peopleTally, pe.curUnits);
      hbarChart($("#ch-people"), people2);
      addTable("ch-people", ["Person", "Sålt", "Andel"], people2.map((x) => [x.label, x.value, `${x.share} %`]));

      const rv = s("revenue");
      columnChart($("#ch-revenue"), rv.revItems, { unit: "kr", tipTitle: (x) => x.label, labelEvery: 1, emptyText: "Ingen försäljning med pris under perioden." });

      const pf = s("profit");
      hbarChart($("#ch-profit"), pf.profitByModel.map((x) => ({ label: x.label, value: Math.max(0, x.value), numText: kr(x.value), tipLine: kr(x.value) })),
        { emptyText: "Ingen vinst att visa. Klänningarna behöver ha inköpspris." });

      const coll = s("collection");
      const colItems = withShare(coll.collectionTally, coll.curUnits).map((x) => ({ ...x, tipLine: `${fmt(x.value)} st · ${kr(coll.collectionRev.get(x.label) || 0)}` }));
      hbarChart($("#ch-collection"), colItems, { emptyText: "Ingen försäljning under perioden." });

      const ty = s("dressType");
      const tyItems = withShare(ty.typeTally, ty.curUnits).map((x) => ({ ...x, tipLine: `${fmt(x.value)} st · ${kr(ty.typeRev.get(x.label) || 0)}` }));
      hbarChart($("#ch-type"), tyItems, { emptyText: "Ingen försäljning under perioden." });

      const pmod = s("pieModels");
      pieChart($("#ch-pie-models"), pmod.kvarModels, { emptyText: "Inga klänningar med räknat lager." });
      const pcol = s("pieColors");
      pieChart($("#ch-pie-colors"), pcol.kvarColors, { emptyText: "Inga klänningar med räknat lager för urvalet." });
    };
    redrawCharts = drawCharts;
    drawCharts();
    document.querySelectorAll("[data-mfilter]").forEach((sel) => {
      if (!sel.dataset.bound) { sel.dataset.bound = "1"; sel.addEventListener("change", () => loadOverview()); }
    });

    // --- Lager per modell (alla klänningar, tre nivåer) ---
    const sold = soldByProduct(d.moves, period);
    const list = $("#stock-list");
    const stockNote = $("#stock-note");
    stockNote.hidden = !all.untracked;
    stockNote.textContent = `${fmt(all.untracked)} av ${word(d.products.length, "klänning", "klänningar")} har inget räknat lager. Lagret börjar räknas när admin lägger in ett antal.`;
    if (!d.products.length) return list.replaceChildren(h("p", { class: "empty-state", text: "Inga klänningar än. Lägg till under Klänningar." }));
    list.replaceChildren(...treeNodes(buildTree(d.products, sold), (p) => {
      const n = sold.get(p.id) || 0;
      return h("div", { class: "vrow" },
        h("span", { text: p.size ? `Stl ${p.size}` : desc(p) }),
        h("span", { class: "nums", text: p.track_stock ? `${fmt(p.quantity)} kvar · ${fmt(n)} sålda` : `räknas inte · ${fmt(n)} sålda` }));
    }));

    // Lagerstatus: en rad med fyra delar
    function drawStatus(st) {
      const statusEl = $("#ch-status");
      if (!d.products.length) return statusEl.replaceChildren(h("p", { class: "chart-empty", text: "Inga klänningar än." }));
      if (!st.tracked.length) return statusEl.replaceChildren(h("p", { class: "chart-empty", text: "Inga klänningar med räknat lager för urvalet." }));
      const vname = (p) => [p.name, variantText(p)].filter(Boolean).join(" · ");
      const seg = (cls, n, label) => n ? withTip(h("span", { class: cls, style: `flex:${n}` }), [label, { b: `${n} st` }]) : null;
      const li = (cls, label, list2, n) => [
        h("li", {}, h("span", { class: "ico " + cls, "aria-hidden": "true" }), h("span", { text: label }), h("span", { class: "n", text: fmt(n) })),
        list2 && list2.length ? h("li", {}, h("span", { class: "names", text: list2.slice(0, 4).map(vname).join(", ") + (list2.length > 4 ? ` +${list2.length - 4} till` : "") })) : null,
      ];
      statusEl.replaceChildren(
        h("div", { class: "status-bar", role: "img", "aria-label": `${st.ok} i lager, ${st.low.length} låg nivå, ${st.out.length} slut` },
          seg("st-ok", st.ok, "Finns i lager"), seg("st-low", st.low.length, "Låg nivå"), seg("st-out", st.out.length, "Slut")),
        h("ul", { class: "status-legend" },
          ...li("st-ok", "Finns i lager", null, st.ok),
          ...li("st-low", "Låg nivå – beställ snart", st.low, st.low.length),
          ...li("st-out", "Slut", st.out, st.out.length)));
    }
  }

  // ---------- Admin: Klänningar ----------
  $("#product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.rpc("create_product", {
      p_name: f.name.value.trim(), p_quantity: Number(f.quantity.value), p_threshold: Number(f.threshold.value),
      p_color: f.color.value.trim(), p_size: f.size.value.trim(), p_sku: f.sku.value.trim() || null,
      p_barcode: f.barcode.value.trim() || null,
    });
    if (error) return toast(errMsg(error), true);
    toast("Klänning tillagd.");
    f.reset();
    loadProducts();
  });

  // ---------- Uppgifter om klänningen (bara admin) ----------
  const COLLECTIONS = ["", "Premium", "Exclusive", "Couture"];
  const DRESS_TYPES = ["", "Brudklänning", "Festklänning"];
  const STATUSES = ["", "Beställd", "Uthyrd", "Hos sömmerska"];
  const CONDITIONS = ["Ny", "Demo", "Provad", "Skadad"];
  const kr = (n) => `${fmt(n)} kr`;
  // Tal och ord i rätt böjning: "1 storlek", "3 storlekar"
  const word = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const priceOf = (p) => p.campaign_price ?? p.sale_price;
  // Status: det manuella valet, annars räknat ur lagret (samma regler som i skannern)
  // "Såld" gäller bara när lagret räknas (track_stock är true) och antalet är 0
  const autoStatus = (p) => {
    if (p.status) return p.status;
    if (p.reserved > 0 && (p.track_stock !== true || p.quantity <= p.reserved)) return "Reserverad";
    if (p.track_stock === true && p.quantity === 0) return "Såld";
    return "I lager";
  };
  function economy(p) {
    const cost = p.purchase_price == null ? null : Number(p.purchase_price) + Number(p.freight_cost || 0);
    const price = priceOf(p);
    const profit = cost == null || price == null ? null : price - cost;
    const margin = profit == null || !price ? null : Math.round((profit / price) * 1000) / 10;
    return { cost, price, profit, margin };
  }
  // Dagar sedan leveransen (annars inköpet, annars när den lades in). Bara för klänningar i lager
  const lagerDagar = (p) => {
    if (!(p.quantity > 0)) return null;
    const from = p.delivered_at || p.purchased_at || p.created_at;
    return Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / DAY));
  };

  const statBox = (label, value) => h("div", { class: "det-stat" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }));
  const detField = (p, key, label, kind, opts) => {
    const cur = p[key] ?? "";
    let el;
    if (kind === "select") {
      el = h("select", { name: key }, ...opts.map((o) => h("option", { value: o, text: o || "–" })));
      el.value = String(cur);
    } else if (kind === "textarea") {
      el = h("textarea", { name: key, maxlength: 2000, rows: 3 }, String(cur));
    } else {
      el = h("input", { name: key, type: kind, value: String(cur), maxlength: kind === "text" ? 120 : null,
        inputmode: kind === "number" ? "decimal" : null, step: kind === "number" ? "any" : null, min: kind === "number" ? 0 : null });
    }
    return h("label", { class: kind === "textarea" ? "full" : "" }, label, el);
  };
  const detGroup = (title, items) => h("fieldset", { class: "det-group" }, h("legend", { text: title }), ...items);

  async function openDetails(p) {
    const dlg = $("#dlg-details"), form = $("#det-form");
    $("#det-title").textContent = [p.name, desc(p)].filter(Boolean).join(" · ");
    const e = economy(p), days = lagerDagar(p);
    const warn = e.price != null && p.min_price != null && e.price < p.min_price ? "Priset är under lägsta pris." : null;
    $("#det-stats").replaceChildren(
      statBox("Självkostnad", e.cost == null ? "–" : kr(e.cost)),
      statBox("Pris", e.price == null ? "–" : kr(e.price)),
      statBox("Vinst", e.profit == null ? "–" : kr(e.profit)),
      statBox("Marginal", e.margin == null ? "–" : `${e.margin.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`),
      statBox("Status", autoStatus(p)),
      statBox("Lagerdagar", days == null ? "–" : word(days, "dag", "dagar")),
      statBox("Provningar", fmt(p.fittings)),
      statBox("Skick", p.condition || "Ny"),
      ...(warn ? [h("p", { class: "det-warn", text: warn })] : []));
    $("#det-fields").replaceChildren(
      detGroup("Klänningen", [detField(p, "designer", "Designer eller leverantör", "text"), detField(p, "collection", "Kollektion", "select", COLLECTIONS),
        detField(p, "dress_type", "Typ", "select", DRESS_TYPES), detField(p, "color", "Färg", "text"), detField(p, "size", "Storlek", "text"),
        detField(p, "material", "Material", "text"), detField(p, "serial", "Unikt individnummer", "text")]),
      detGroup("Ekonomi", [detField(p, "purchase_price", "Inköpspris (kr)", "number"), detField(p, "freight_cost", "Frakt och tull (kr)", "number"),
        detField(p, "sale_price", "Ordinarie pris (kr)", "number"), detField(p, "campaign_price", "Kampanjpris (kr)", "number"),
        detField(p, "min_price", "Lägsta tillåtna pris (kr)", "number")]),
      detGroup("Lager och status", [detField(p, "status", "Status (lämna tomt för automatisk)", "select", STATUSES),
        detField(p, "location", "Butik eller lagerplats", "text"), detField(p, "purchased_at", "Datum inköpt", "date"),
        detField(p, "delivered_at", "Leveransdatum", "date"), detField(p, "fittings", "Antal provningar", "number"),
        detField(p, "condition", "Skick", "select", CONDITIONS), detField(p, "low_stock_threshold", "Varna när under", "number")]),
      detGroup("Anteckningar", [detField(p, "notes", "Anteckningar", "textarea")]));

    // Produktbilden: senaste fotot från historiken för klänningen
    const img = $("#det-photo");
    img.hidden = true; img.removeAttribute("src");
    sb.from("stock_movements").select("photo_thumb").eq("product_id", p.id).not("photo_thumb", "is", null)
      .order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => { const t = data?.[0]?.photo_thumb; if (isThumb(t)) { img.src = t; img.hidden = false; } });

    // Spara: bara fält som ändrats skickas. Tom ruta tömmer fältet
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const changed = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.value.trim() !== String(p[el.name] ?? "")) changed[el.name] = el.value.trim();
      }
      if (!Object.keys(changed).length) return toast("Inget är ändrat.");
      const btn = form.querySelector("[type=submit]");
      btn.disabled = true;
      const { error } = await sb.rpc("update_product", { p_product: p.id, p: changed });
      btn.disabled = false;
      if (error) return toast(errMsg(error), true);
      dataCache = null;
      dlg.close();
      toast("Uppgifterna är sparade.");
      loadProducts();
    };
    dlg.showModal();
  }

  // Sålt per klänning under vald period (nyckel: produkt-id)
  const dayOff = (iso) => Math.round((startOfDay(Date.now()) - startOfDay(new Date(iso).getTime())) / DAY);
  function soldByProduct(moves, period) {
    const map = new Map();
    for (const m of moves) if (m.change < 0 && dayOff(m.created_at) < period) map.set(m.product_id, (map.get(m.product_id) || 0) - m.change);
    return map;
  }

  // Tre nivåer: modell (namn) → färg → storlek. Används av Klänningar och av Lager per modell
  function buildTree(products, sold) {
    const flagsOf = (items) => {
      const tr = items.filter((p) => p.track_stock), f = [];
      if (tr.some((p) => p.quantity > 0 && p.quantity <= p.low_stock_threshold)) f.push("Låg");
      if (tr.some((p) => p.quantity === 0)) f.push("Slut i någon");
      return f;
    };
    const stats = (items) => {
      const tr = items.filter((p) => p.track_stock);
      return { kvar: sum(tr, (p) => p.quantity), tracked: tr.length, sold: sum(items, (p) => sold.get(p.id) || 0), flags: flagsOf(items) };
    };
    return groupByModel(products).map((g) => {
      const colorMap = new Map();
      for (const p of g.items) {
        const key = (p.color || "").trim().toLowerCase();
        if (!colorMap.has(key)) colorMap.set(key, { key, name: (p.color || "").trim() || "Ingen färg", items: [] });
        colorMap.get(key).items.push(p);
      }
      const colors = [...colorMap.values()]
        .sort((x, y) => (x.key === "") - (y.key === "") || x.name.localeCompare(y.name, "sv"))
        .map((c) => ({ ...c, items: c.items.sort((x, y) => bySize(x.size, y.size)), ...stats(c.items) }));
      return { name: g.name, items: g.items, colors, ...stats(g.items) };
    });
  }
  const totalText = (x) => `${x.tracked ? `${fmt(x.kvar)} kvar` : "räknas inte"} · ${fmt(x.sold)} sålda`;
  const flagBadge = (f) => (f.length ? h("span", { class: "badge warn", text: f.join(" · ") }) : null);

  // Ritar trädet. row(p) ger innehållet för varje klänning på nivå 3
  function treeNodes(models, row, { rename = false } = {}) {
    const onlyOne = models.length === 1;
    return models.map((m) => h("details", { class: "tree-model", open: onlyOne || null },
      h("summary", { class: "tree-sum" },
        h("strong", { text: m.name }),
        h("span", { class: "tsum", text: totalText(m) }),
        flagBadge(m.flags),
        rename && isAdmin() ? h("button", { class: "btn small tree-btn", type: "button", text: "Byt namn",
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); renameGroup(m); } }) : null),
      ...m.colors.map((c) => h("details", { class: "tree-color" },
        h("summary", { class: "tree-sum" },
          h("span", { text: c.name }),
          h("span", { class: "tsum", text: totalText(c) }),
          flagBadge(c.flags)),
        ...c.items.map((p) => h("div", { class: "tree-size" }, row(p)))))));
  }

  let productCache = [];
  async function loadProducts() {
    const d = await getData(true);
    if (d.error) return toast(errMsg(d.error), true);
    productCache = d.products;
    const list = $("#product-list");
    if (!d.products.length) return list.replaceChildren(h("p", { class: "empty-state", text: "Inga klänningar än." }));
    const sold = soldByProduct(d.moves, period);
    const fs = $("#f-status").value, fc = $("#f-collection").value;
    const shown = d.products.filter((p) => (!fs || autoStatus(p) === fs)
      && (!fc || (fc === "-" ? !p.collection : p.collection === fc)));
    if (!shown.length) return list.replaceChildren(h("p", { class: "empty-state", text: "Ingen klänning matchar filtret." }));
    list.replaceChildren(...treeNodes(buildTree(shown, sold), (p) => productItem(p, sold.get(p.id) || 0), { rename: true }));
  }

  $("#f-status").addEventListener("change", () => loadProducts());
  $("#f-collection").addEventListener("change", () => loadProducts());

  function productItem(p, sold) {
    const status = !p.track_stock ? null
      : p.quantity === 0 ? h("span", { class: "badge danger", text: "Slut" })
      : p.quantity <= p.low_stock_threshold ? h("span", { class: "badge warn", text: "Låg" }) : null;
    return h("div", { class: "item" },
      h("div", { class: "main" },
        h("div", { class: "title" }, p.size ? `Stl ${p.size}` : desc(p), " ", status),
        h("div", { class: "meta" }, [priceOf(p) != null ? kr(priceOf(p)) : "Inget pris", autoStatus(p), p.collection].filter(Boolean).join(" · ")),
        h("div", { class: "meta" },
          p.track_stock ? `${fmt(p.quantity)} kvar av ${fmt(p.total_added)} · ${fmt(sold)} sålda · varning under ${fmt(p.low_stock_threshold)}`
            : `Lagret räknas inte · ${fmt(sold)} sålda`,
          p.sku ? h("span", { class: "sku", text: " · " + p.sku }) : null,
          p.barcode ? h("span", { class: "sku", text: " · ▮▯▮ " + p.barcode }) : null)),
      h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", text: "Uppgifter", onclick: () => openDetails(p) }),
        h("button", { class: "btn small", type: "button", text: "QR", onclick: () => showQr(p) }),
        h("button", { class: "btn small", type: "button", text: "Fyll på", onclick: () => refill(p) }),
        h("button", { class: "btn small", type: "button", text: "Streckkod", onclick: () => editBarcode(p) }),
        h("button", { class: "btn small ghost link-danger", type: "button", text: "Ta bort", onclick: () => removeProduct(p) })));
  }

  async function renameGroup(g) {
    if (await renameProduct(g.items[0])) loadProducts();
  }

  let qrProduct = null;
  function showQr(p) {
    qrProduct = p;
    $("#qr-print").replaceChildren(label(p));
    $("#dlg-qr").showModal();
  }
  $("#qr-do-print").addEventListener("click", () => { if (qrProduct) printLabels([qrProduct]); });
  $("#print-all").addEventListener("click", () => {
    if (!productCache.length) return toast("Inga klänningar att skriva ut.", true);
    printLabels(productCache);
  });
  function printLabels(items) {
    $("#print-sheet").replaceChildren(...items.map(label));
    window.print();
  }

  async function refill(p) {
    const v = await ask(`Fyll på "${p.name}" – antal:`, { type: "number", value: "1", min: 1, max: 1000000 });
    const n = Math.round(Number(v));
    if (!v || !(n >= 1)) return;
    const { data, error } = await sb.rpc("add_stock", { p_product: p.id, p_amount: n });
    if (error) return toast(errMsg(error), true);
    toast(`Påfyllt. ${fmt(data)} i lager nu.`);
    loadProducts();
  }

  // Föreslår en kort kod att skriva med penna på lappen, t.ex. "MAJ-SV-M"
  function suggestCode(name, color, size) {
    const part = (t, n) => (t || "").normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, n);
    return [part(name, 3), part(color, 2), part(size, 3)].filter(Boolean).join("-");
  }
  $("#suggest-code").addEventListener("click", () => {
    const f = $("#product-form");
    if (!f.name.value.trim()) return toast("Skriv modellnamnet först.", true);
    f.barcode.value = suggestCode(f.name.value, f.color.value, f.size.value);
  });

  async function editBarcode(p) {
    const v = await ask(`Streckkod för ${[p.name, variantText(p)].filter(Boolean).join(", ")} (lämna tomt för att ta bort):`, { value: p.barcode || "", required: false });
    if (v === null) return;
    const code = v.trim();
    if (code && !CODE_RE.test(code)) return toast("Ogiltig streckkod.", true);
    const { error } = await sb.rpc("set_barcode", { p_product: p.id, p_barcode: code || null });
    if (error) return toast(errMsg(error), true);
    toast(code ? "Streckkoden är sparad." : "Streckkoden är borttagen.");
    loadProducts();
  }

  async function removeProduct(p) {
    if (!(await confirmBox(`Ta bort "${[p.name, variantText(p)].filter(Boolean).join(", ")}"?`, "Klänningen och all dess historik försvinner. Det går inte att ångra."))) return;
    const { error } = await sb.from("products").delete().eq("id", p.id);
    if (error) return toast(errMsg(error), true);
    toast("Klänning borttagen.");
    loadProducts();
  }

  // ---------- Reserverade ----------
  const daysUntil = (d) => Math.ceil((new Date(d).getTime() - startOfDay(Date.now())) / DAY);
  $("#res-filter").addEventListener("change", () => loadReserved());

  async function loadReserved() {
    const admin = isAdmin();
    $("#res-filter").hidden = !admin;
    const status = admin ? $("#res-filter").value : "open";
    let rows;
    if (admin) {
      const { data, error } = await sb.from("reservations")
        .select("*, products(name, color, size, barcode, sale_price, campaign_price), skapad:profiles!reservations_created_by_fkey(full_name)")
        .eq("status", status).order("created_at", { ascending: false });
      if (error) return toast(errMsg(error), true);
      rows = data.map((r) => ({
        id: r.id, name: r.products?.name ?? "Borttagen klänning", color: r.products?.color ?? "", size: r.products?.size ?? "",
        amount: r.amount, customer: r.customer_name, event: r.event_date, created: r.created_at, by: r.skapad?.full_name ?? "",
        raw: r, price: r.price ?? r.products?.campaign_price ?? r.products?.sale_price,
      }));
      if (status === "open") rows.sort((x, y) => (x.event ? new Date(x.event) : Infinity) - (y.event ? new Date(y.event) : Infinity));
    } else {
      const { data, error } = await sb.rpc("staff_reservations");
      if (error) return toast(errMsg(error), true);
      rows = data.map((r) => ({
        id: r.id, name: r.name, color: r.color, size: r.size, amount: r.amount, customer: r.customer_name,
        event: r.event_date, created: r.created_at, by: r.reserved_by, raw: r,
      }));
    }
    if (status === "open") {
      const c = $("#res-count");
      c.textContent = rows.length; c.hidden = !rows.length;
    }
    const list = $("#reserved-list");
    if (!rows.length) return list.replaceChildren(h("p", { class: "empty-state", text: "Inga reserverade klänningar." }));
    list.replaceChildren(...rows.map(reservedRow));
  }

  function reservedRow(r) {
    const admin = isAdmin();
    const days = Math.floor((Date.now() - new Date(r.created).getTime()) / DAY);
    const until = r.event ? daysUntil(r.event) : null;
    const soon = until !== null && until >= 0 && until <= 14;
    const variant = [r.color, r.size && `Stl ${r.size}`].filter(Boolean).join(" · ");
    const main = h("div", { class: "main" },
      h("div", { class: "title" }, r.name, variant ? h("span", { class: "muted", text: " · " + variant }) : null),
      h("div", { class: "meta", text: `${r.amount} st · ${r.customer || "ingen kund angiven"} · ${days === 0 ? "reserverad idag" : `reserverad för ${days} ${days === 1 ? "dag" : "dagar"} sedan`}${r.by ? " · av " + r.by : ""}` }),
      h("div", { class: "meta" },
        r.event ? `Fest ${new Date(r.event).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}` : "Inget festdatum",
        soon ? h("span", { class: "badge warn", text: "Snart" }) : null),
      admin ? reservedDetails(r) : null);
    return h("div", { class: "item reserved-item" }, main,
      h("div", { class: "btns" },
        h("button", { class: "btn small", type: "button", text: "Såld", onclick: () => sellReservation(r) }),
        h("button", { class: "btn small ghost link-danger", type: "button", text: "Ångra", onclick: () => cancelReservation(r) })));
  }

  // Admin: uppgifterna om kunden och festen. Bara det som ändrats skickas
  function reservedDetails(r) {
    const raw = r.raw;
    const fields = [
      ["customer_name", "Kund", "text"], ["customer_contact", "Telefon eller e-post", "text"],
      ["price", "Överenskommet pris (kr)", "number"], ["deposit", "Handpenning (kr)", "number"],
      ["event_date", "Datum för bröllop eller fest", "date"], ["fitting_date", "Datum för provning", "date"],
      ["alterations", "Ändringar som ska göras", "textarea"], ["seamstress", "Sömmerska", "text"],
      ["notes", "Anteckningar", "textarea"],
    ];
    const inputs = fields.map(([key, label, type]) => {
      const value = raw[key] ?? "";
      const control = type === "textarea"
        ? h("textarea", { name: key, maxlength: 2000, rows: 2 }, String(value))
        : h("input", { name: key, type, value: String(value), maxlength: type === "text" ? 120 : null, inputmode: type === "number" ? "decimal" : null });
      return h("label", {}, label, control);
    });
    const price = Number(raw.price ?? r.price ?? 0), deposit = Number(raw.deposit ?? 0);
    const form = h("form", { class: "res-form", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const changed = {};
      for (const [key, , type] of fields) {
        const el = e.target.elements.namedItem(key);
        const now = el.value.trim(), before = String(raw[key] ?? "");
        if (now !== before) changed[key] = now;
        void type;
      }
      if (!Object.keys(changed).length) return toast("Inget är ändrat.");
      const { error } = await sb.rpc("reservation_update", { p_id: r.id, p: changed });
      if (error) return toast(errMsg(error), true);
      toast("Uppgifterna är sparade.");
      loadReserved();
    } },
      ...inputs,
      h("p", { class: "muted", text: `Återstår att betala: ${fmt(price - deposit)} kr` }),
      h("button", { class: "btn small", type: "submit", text: "Spara uppgifter" }));
    return h("details", { class: "res-details" }, h("summary", { text: "Kund, pris och ändringar" }), form);
  }

  // Ta en bild med telefonen (eller välj en fil på datorn). Avbryter man returneras null
  function pickPhoto() {
    return new Promise((resolve) => {
      const inp = $("#res-photo-input");
      const done = (v) => { inp.onchange = null; inp.oncancel = null; resolve(v); };
      inp.onchange = async () => {
        const file = inp.files?.[0];
        inp.value = "";
        if (!file) return done(null);
        try { done(await shrinkPhoto(file)); } catch { toast("Bilden kunde inte läsas.", true); done(null); }
      };
      inp.oncancel = () => done(null);
      inp.click();
    });
  }

  async function sellReservation(r) {
    const price = await ask(`Såld för (kr) – ${r.name}:`, { type: "number", value: r.price != null ? String(r.price) : "", required: false });
    if (price === null) return;
    const photo = photoMode() === "off" ? null : await pickPhoto();
    if (photoMode() === "required" && !photo) return toast("Ta ett foto på klänningen först.", true);
    const path = photo ? await uploadPhoto(photo.blob) : null;
    if (photo && !path) return toast("Fotot kunde inte laddas upp. Försök igen.", true);
    const { data, error } = await sb.rpc("reservation_sell", {
      p_id: r.id, p_price: price.trim() === "" ? null : Number(price),
      p_photo_path: path, p_photo_thumb: photo ? photo.thumb : null,
    });
    if (error) return toast(errMsg(error), true);
    dataCache = null;
    toast(`Såld: ${r.name}. ${fmt(data.quantity)} kvar.`);
    loadReserved();
  }

  async function cancelReservation(r) {
    if (!(await confirmBox("Ta bort reservationen?", "Klänningen blir ledig igen."))) return;
    const { data, error } = await sb.rpc("reservation_cancel", { p_id: r.id });
    if (error) return toast(errMsg(error), true);
    if (data?.photo_path) sb.storage.from("utskick").remove([data.photo_path]).catch(() => {});
    dataCache = null;
    toast("Reservationen är borttagen. Klänningen är ledig igen.");
    loadReserved();
  }

  // ---------- Admin: Konton ----------
  function randomPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint32Array(14));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }
  $("#gen-pw").addEventListener("click", () => { $("#account-form").password.value = randomPassword(); });

  // Anropar serverfunktionen admin-users. Returnerar null vid lyckat anrop, annars ett meddelande till användaren
  async function adminCall(body) {
    let res;
    try {
      res = await sb.functions.invoke("admin-users", { body });
    } catch (err) {
      console.error("admin-users: anropet kunde inte göras", err);
      return "Det gick inte att nå servern. Kontrollera internetanslutningen och försök igen.";
    }
    const { data, error } = res;
    if (error) {
      let detail = null;
      try { detail = await error.context?.json(); } catch {}
      console.error("admin-users: felsvar", error, detail);
      return detail?.error || `Servern svarade med fel${error.context?.status ? ` (${error.context.status})` : ""}. Se konsolen för detaljer.`;
    }
    if (data?.error) {
      console.error("admin-users: svaret innehåller fel", data);
      return data.error;
    }
    return null;
  }

  const FIELD_NAMES = { full_name: "Namn", email: "E-post", password: "Lösenord", role: "Roll" };
  // Svensk förklaring till varför ett fält är fel
  function fieldProblem(el) {
    const v = el.validity, label = FIELD_NAMES[el.name] || el.name;
    if (v.valueMissing) return `${label} måste fyllas i.`;
    if (v.typeMismatch) return `${label} är inte giltig. Kontrollera att den är skriven rätt.`;
    if (v.tooShort) return `${label} är för kort. Minst ${el.minLength} tecken.`;
    if (v.tooLong) return `${label} är för lång. Högst ${el.maxLength} tecken.`;
    return `${label} är inte giltig.`;
  }

  $("#account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("[type=submit]");
    const bad = [...f.elements].find((el) => el.willValidate && !el.checkValidity());
    if (bad) {
      notice(`Kontot skapades inte. ${fieldProblem(bad)}`, true);
      bad.focus();
      return;
    }
    btn.disabled = true;
    notice("Skapar kontot …");
    try {
      const err = await adminCall({
        action: "create", full_name: f.full_name.value.trim(), email: f.email.value.trim(),
        password: f.password.value, role: f.role.value,
      });
      if (err) return notice(`Kontot skapades inte. ${err}`, true);
      $("#notice").hidden = true;
      toast("Konto skapat. Ge personen e-post och lösenord.");
      f.reset();
      loadAccounts();
    } finally {
      btn.disabled = false;
    }
  });

  async function loadAccounts() {
    const { data, error } = await sb.from("profiles").select("id, full_name, email, role, created_at").order("full_name");
    if (error) return toast(errMsg(error), true);
    $("#account-count").textContent = `(${data.length})`;
    $("#account-list").replaceChildren(...data.map((u) => {
      const isMe = u.id === state.me.id;
      return h("div", { class: "item" },
        h("div", { class: "main" },
          h("div", { class: "title" }, u.full_name, " ",
            h("span", { class: "badge", text: u.role === "admin" ? "Admin" : "Arbetare" }),
            isMe ? h("span", { class: "muted", text: " (du)" }) : null),
          h("div", { class: "meta", text: u.email })),
        isMe ? null : h("div", { class: "btns" },
          h("button", { class: "btn small", type: "button", text: "Nytt lösenord", onclick: () => resetPw(u) }),
          h("button", { class: "btn small ghost link-danger", type: "button", text: "Ta bort", onclick: () => removeUser(u) })));
    }));
  }

  async function resetPw(u) {
    const pw = await ask(`Nytt lösenord för ${u.full_name} (minst 10 tecken):`, { value: randomPassword() });
    if (!pw) return;
    const err = await adminCall({ action: "reset_password", user_id: u.id, password: pw });
    toast(err || "Lösenordet är bytt.", !!err);
  }

  async function removeUser(u) {
    if (!(await confirmBox(`Ta bort kontot för ${u.full_name}?`, "Personen kan inte logga in längre."))) return;
    const err = await adminCall({ action: "delete", user_id: u.id });
    if (err) return toast(err, true);
    toast("Konto borttaget.");
    loadAccounts();
  }

  // ---------- Admin: Webbshop (förberedd, avstängd) ----------
  async function loadShop() {
    const { data, error } = await sb.from("products").select("name, color, size, sku").order("name").order("size");
    if (error) return toast(errMsg(error), true);
    const withSku = data.filter((p) => p.sku).length;
    $("#sku-count").textContent = `(${withSku} av ${data.length} har artikelnummer)`;
    const list = $("#sku-list");
    if (!data.length) return list.replaceChildren(h("p", { class: "empty-state", text: "Inga klänningar än." }));
    list.replaceChildren(...data.map((p) => h("div", { class: "item" },
      h("div", { class: "main" },
        h("div", { class: "title" }, p.name, variantText(p) ? h("span", { class: "muted", text: " · " + variantText(p) }) : null)),
      p.sku ? h("span", { class: "sku", text: p.sku }) : h("span", { class: "badge warn", text: "Saknar artikelnr" }))));
  }

  // ---------- Foton ----------
  // Miniatyr som en bild, eller en platshållare om miniatyren saknas
  const thumbNode = (m, cls) => isThumb(m.photo_thumb)
    ? h("img", { class: cls, src: m.photo_thumb, alt: "" })
    : h("span", { class: cls + " thumb-txt", text: "Foto" });

  const photoBtn = (m) => h("button", { class: "thumb-btn", type: "button", "aria-label": "Visa fotot", onclick: () => showPhoto(m) }, thumbNode(m, "thumb"));

  let photoUrl = null;
  let photoToken = null;
  function revokePhoto() { if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; } }

  // Visar miniatyren direkt och hämtar den stora bilden från lagringen
  function showPhoto(m) {
    const dlg = $("#dlg-photo"), img = $("#photo-full"), cap = $("#photo-caption"), status = $("#photo-status");
    revokePhoto();
    const tok = (photoToken = {});
    if (isThumb(m.photo_thumb)) { img.src = m.photo_thumb; img.hidden = false; }
    else { img.removeAttribute("src"); img.hidden = true; }
    cap.textContent = [m.products?.name, m.products && variantText(m.products),
      m.source === "webbshop" ? "Webbshop" : m.profiles?.full_name, fmtDate(m.created_at)].filter(Boolean).join(" · ");
    status.textContent = "Hämtar den stora bilden …";
    dlg.onclose = () => { photoToken = null; revokePhoto(); img.removeAttribute("src"); };
    dlg.showModal();
    sb.storage.from("utskick").download(m.photo_path).then(({ data, error }) => {
      if (photoToken !== tok || !dlg.open) return;
      if (error || !data) { status.textContent = "Den stora bilden kunde inte hämtas."; return; }
      photoUrl = URL.createObjectURL(data);
      img.src = photoUrl; img.hidden = false;
      status.textContent = "";
    });
  }

  // ---------- Admin: Historik ----------
  let historyRows = [];
  let historyFilter = "all";
  async function loadHistory() {
    const { data, error } = await sb.from("stock_movements")
      .select("id, change, source, created_at, photo_path, photo_thumb, unit_price, reservation_id, products(name, color, size, barcode, code), profiles(full_name)")
      .order("created_at", { ascending: false }).limit(100);
    if (error) return toast(errMsg(error), true);
    historyRows = data;
    renderHistory();
  }
  function renderHistory() {
    const list = $("#history-list");
    document.querySelectorAll("[data-hfilter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hfilter === historyFilter)));
    const rows = historyRows.filter((m) => historyFilter === "all" || (historyFilter === "in" ? m.change > 0 : m.change < 0));
    if (!rows.length) return list.replaceChildren(h("p", { class: "empty-state", text: historyRows.length ? "Ingen händelse i det här urvalet." : "Inget har hänt än." }));
    list.replaceChildren(...rows.map((m) => {
      const who = m.source === "webbshop" ? "Webbshop" : m.profiles?.full_name ?? "Borttagen användare";
      const sold = m.change < 0;
      return h("div", { class: "item" },
        m.photo_path ? photoBtn(m) : null,
        h("div", { class: "main" },
          h("div", { class: "title" }, m.products?.name ?? "Borttagen klänning",
            m.products && desc(m.products) ? h("span", { class: "muted", text: " · " + desc(m.products) }) : null),
          h("div", { class: "meta", text: [sold ? "Såld" : "Inlagd", who, fmtDate(m.created_at),
            sold && m.unit_price != null ? `såld för ${kr(m.unit_price)}` : null, m.reservation_id ? "från reservation" : null].filter(Boolean).join(" · ") })),
        h("span", { class: "change " + (sold ? "neg" : "pos"), text: sold ? `−${fmt(-m.change)}` : `+${fmt(m.change)}` }),
        isAdmin() && m.source === "app" ? h("button", { class: "btn small ghost", type: "button", text: "Ångra", onclick: () => undoMovement(m) }) : null);
    }));
  }
  // Ångra: lagret räknas tillbaka och händelsen tas bort ur historiken
  async function undoMovement(m) {
    const what = `${m.products?.name ?? "klänningen"}${m.products && desc(m.products) ? " · " + desc(m.products) : ""}`;
    if (!(await confirmBox("Ångra händelsen?", `${m.change < 0 ? "Såld" : "Inlagd"} ${fmt(Math.abs(m.change))} st av ${what}. Lagret räknas tillbaka och händelsen tas bort ur historiken.`))) return;
    const { data, error } = await sb.rpc("undo_movement", { p_movement_id: m.id });
    if (error) return toast(errMsg(error), true);
    // Hade händelsen ett foto tas bilden bort ur lagringen. Ett fel där spelar ingen roll för lagret.
    if (data?.photo_path) sb.storage.from("utskick").remove([data.photo_path]).catch(() => {});
    dataCache = null;
    toast("Händelsen är ångrad.");
    loadHistory();
  }
  $("#history-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hfilter]");
    if (!b) return;
    historyFilter = b.dataset.hfilter;
    renderHistory();
  });

  // ---------- Start ----------
  document.title = cfg.APP_NAME || "Lager";
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = cfg.APP_NAME || "Lager"));
  if (!window.__demo && (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("DITT-PROJEKT"))) {
    document.body.replaceChildren(h("p", { style: "padding:24px", text: "Fyll i config.js med dina Supabase-uppgifter (se README)." }));
    return;
  }
  boot();
})();
