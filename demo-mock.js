/* DEMO-läge: ersätter Supabase med en låtsasdatabas i minnet.
   Slås på AUTOMATISKT bara så länge config.js inte är ifylld.
   När riktiga Supabase-uppgifter finns gör den här filen ingenting. */
(() => {
  const url = (window.LAGER_CONFIG || {}).SUPABASE_URL || "";
  if (!(url.includes("DITT-PROJEKT") || url.includes("demo.supabase.co"))) return;
  const now = Date.now(), h = 3600e3;
  const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const uid = () => crypto.randomUUID();

  const users = [
    { id: "u-admin", email: "anna@firma.se", full_name: "Anna Lindqvist", role: "admin", created_at: new Date(now - 90 * 24 * h).toISOString() },
    { id: "u-w1", email: "walter@firma.se", full_name: "Walter Berg", role: "worker", created_at: new Date(now - 60 * 24 * h).toISOString() },
    { id: "u-w2", email: "sara@firma.se", full_name: "Sara Nilsson", role: "worker", created_at: new Date(now - 30 * 24 * h).toISOString() },
    { id: "u-w3", email: "omar@firma.se", full_name: "Omar Haddad", role: "worker", created_at: new Date(now - 12 * 24 * h).toISOString() },
  ];
  const mk = (name, color, size, sku, barcode, total_added, remaining, low_stock_threshold = 2) =>
    ({ id: uid(), code: hex(), name, color, size, sku, barcode, quantity: total_added, total_added, low_stock_threshold, track_stock: true, remaining });
  const products = [
    mk("Maja midiklänning", "Svart", "S", "MAJA-SV-S", "7350012340011", 10, 6),
    mk("Maja midiklänning", "Svart", "M", "MAJA-SV-M", "7350012340028", 12, 2),
    mk("Maja midiklänning", "Svart", "L", "MAJA-SV-L", "7350012340035", 10, 7),
    mk("Elsa omlottklänning", "Smaragdgrön", "S", "ELSA-GR-S", null, 8, 0),
    mk("Elsa omlottklänning", "Smaragdgrön", "M", "ELSA-GR-M", null, 8, 5),
    mk("Vera maxiklänning", "Rosé", "S", "VERA-RO-S", "7350012340042", 10, 4),
    mk("Vera maxiklänning", "Rosé", "M", "VERA-RO-M", "7350012340059", 14, 9),
    mk("Vera maxiklänning", "Rosé", "L", "VERA-RO-L", null, 10, 8),
    mk("Signe linneklänning", "Sand", "38", null, "S38", 12, 9),
    mk("Signe linneklänning", "Sand", "40", null, "S40", 12, 11),
  ];
  const movements = [];
  // Förutsägbar slump så att demon ser likadan ut varje gång
  let seed = 20261001;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const workers = ["u-w1", "u-w2", "u-w3"];
  const log = (p, user, change, hoursAgo) => movements.push({ id: movements.length + 1, product_id: p.id, user_id: user, change, source: "app", photo_path: null, photo_thumb: null, created_at: new Date(now - hoursAgo * h).toISOString() });
  products.forEach((p, i) => log(p, "u-admin", p.total_added, 24 * 32 + i));
  for (const p of products) {
    let left = p.total_added - p.remaining;
    while (left > 0) {
      const n = Math.min(left, rnd() < 0.75 ? 1 : 2);
      const daysBack = Math.floor(Math.pow(rnd(), 1.15) * 29);   // fler uttag nyligen
      const hourOfDay = 9 + rnd() * 8;
      const d = new Date(now); d.setDate(d.getDate() - daysBack); d.setHours(0, 0, 0, 0);
      let hoursAgo = (now - d.getTime()) / h - hourOfDay;
      if (hoursAgo < 0.2) hoursAgo = 0.2 + rnd();
      log(p, workers[Math.floor(rnd() * workers.length)], -n, hoursAgo);
      left -= n;
    }
    p.quantity = p.remaining; delete p.remaining;
  }
  movements.sort((a, b) => a.created_at.localeCompare(b.created_at));

  let session = null;
  const listeners = [];
  const me = () => users.find((u) => u.id === session?.user.id);
  const ok = (data) => Promise.resolve({ data, error: null });
  const fail = (message) => Promise.resolve({ data: null, error: { message } });
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 180));

  function pick(row, cols) {
    const out = {};
    for (const c of cols) {
      const m = c.match(/^(\w+)\((.+)\)$/);
      if (m) {
        const inner = m[2].split(",").map((s) => s.trim());
        const ref = m[1] === "products" ? products.find((p) => p.id === row.product_id) : users.find((u) => u.id === row.user_id);
        out[m[1]] = ref ? pick(ref, inner) : null;
      } else out[c] = row[c];
    }
    return out;
  }

  function from(table) {
    const q = { table, cols: [], filters: [], order: null, limit: null, single: false, del: false };
    const api = {
      select(cols) { q.cols = cols.split(/,(?![^(]*\))/).map((s) => s.trim()); return api; },
      eq(col, val) { q.filters.push([col, val]); return api; },
      gte(col, val) { q.gte = [col, val]; return api; },
      order(col, opts = {}) { (q.order ||= []).push([col, opts.ascending !== false]); return api; },
      not(col, _op, val) { (q.nots ||= []).push([col, val]); return api; },
      lt(col, val) { q.lt = [col, val]; return api; },
      range(from, to) { q.range = [from, to]; return api; },
      limit(n) { q.limit = n; return api; },
      single() { q.single = true; return api; },
      delete() { q.del = true; return api; },
      then(res, rej) { return wait(run(q)).then(res, rej); },
    };
    return api;
  }

  function run(q) {
    const admin = me()?.role === "admin";
    const src = { profiles: users, products, stock_movements: movements }[q.table];
    let rows = src.filter((r) => q.filters.every(([c, v]) => r[c] === v));
    if (q.gte) rows = rows.filter((r) => r[q.gte[0]] >= q.gte[1]);
    if (q.lt) rows = rows.filter((r) => r[q.lt[0]] < q.lt[1]);
    if (q.nots) rows = rows.filter((r) => q.nots.every(([c]) => r[c] != null));
    if (q.table === "profiles" && !admin) rows = rows.filter((r) => r.id === me()?.id);
    if (q.table !== "profiles" && !admin) rows = [];
    if (q.del) {
      rows.forEach((r) => { src.splice(src.indexOf(r), 1); for (let i = movements.length - 1; i >= 0; i--) if (movements[i].product_id === r.id) movements.splice(i, 1); });
      return { data: null, error: null };
    }
    if (q.order) rows = [...rows].sort((a, b) => {
      for (const [c, asc] of q.order) { const x = String(a[c] ?? ""), y = String(b[c] ?? ""); const r = x.localeCompare(y, "sv", { numeric: true }); if (r) return asc ? r : -r; }
      return 0;
    });
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit) rows = rows.slice(0, q.limit);
    rows = rows.map((r) => pick(r, q.cols));
    if (q.single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
    return { data: rows, error: null };
  }

  function rpc(name, args) {
    const u = me(); if (!u) return fail("Ingen behörighet");
    const admin = u.role === "admin";
    if (name === "lookup_product") {
      const p = products.find((x) => x.code === args.p_code || (x.barcode && x.barcode === String(args.p_code).toUpperCase()));
      return wait({ data: p ? [{ id: p.id, name: p.name, color: p.color, size: p.size, quantity: p.quantity }] : [], error: null });
    }
    if (name === "staff_products") {
      return wait({ data: [...products].sort((a, b) => (a.name + a.color).localeCompare(b.name + b.color, "sv"))
        .map(({ name, color, size, quantity, code }) => ({ name, color, size, quantity, code })), error: null });
    }
    if (name === "scan_info") {
      if (!args.p_code || !/^[A-Za-z0-9._-]{3,64}$/.test(args.p_code)) return fail("Ogiltig kod");
      const p = products.find((x) => x.code === args.p_code || (x.barcode && x.barcode === String(args.p_code).toUpperCase()));
      if (p) return wait({ data: { known: true, new_group: false, id: p.id, name: p.name, color: p.color, size: p.size, quantity: p.quantity, track_stock: p.track_stock }, error: null });
      const key = String(args.p_code).split(/[-_. ]/)[0].toUpperCase() || args.p_code;
      return wait({ data: { known: false, new_group: !products.some((x) => x.name.toLowerCase() === key.toLowerCase()), name: /^[0-9]+$/.test(args.p_code) ? `Streckkod ${args.p_code}` : key, color: "", size: "", quantity: 0, track_stock: false }, error: null });
    }
    if (name === "ship") {
      const code = String(args.p_code).toUpperCase();
      let p = products.find((x) => x.code === args.p_code || (x.barcode && x.barcode === code));
      let created = false;
      if (!p) {
        const key = code.split(/[-_. ]/)[0] || code;
        p = mk(args.p_name || key, args.p_color || "", args.p_size || "", null, code, 0, 0);
        p.track_stock = false; p.total_added = 0; delete p.remaining;
        products.push(p); created = true;
      } else {
        if (args.p_color != null) p.color = args.p_color;
        if (args.p_size != null) p.size = args.p_size;
      }
      if (p.track_stock) {
        if (p.quantity < args.p_amount) return fail("Det finns inte så många kvar i lager");
        p.quantity -= args.p_amount;
      }
      movements.push({ id: movements.length + 1, product_id: p.id, user_id: u.id, change: -args.p_amount, source: "app", photo_path: args.p_photo_path, photo_thumb: args.p_photo_thumb, created_at: new Date().toISOString() });
      return wait({ data: { id: p.id, name: p.name, color: p.color, size: p.size, quantity: p.quantity, track_stock: p.track_stock, created }, error: null });
    }
    if (name === "stock_in") {
      const code = String(args.p_code).toUpperCase();
      let p = products.find((x) => x.code === args.p_code || (x.barcode && x.barcode === code));
      let created = false;
      if (!p) { p = mk(args.p_name || code.split(/[-_. ]/)[0], args.p_color || "", args.p_size || "", null, code, 0, 0); p.total_added = 0; delete p.remaining; products.push(p); created = true; }
      if (args.p_color != null) p.color = args.p_color;
      if (args.p_size != null) p.size = args.p_size;
      p.quantity += args.p_amount; p.total_added += args.p_amount; p.track_stock = true;
      movements.push({ id: movements.length + 1, product_id: p.id, user_id: u.id, change: args.p_amount, source: "app", photo_path: args.p_photo_path, photo_thumb: args.p_photo_thumb, created_at: new Date().toISOString() });
      return wait({ data: { id: p.id, name: p.name, color: p.color, size: p.size, quantity: p.quantity, track_stock: true, created }, error: null });
    }
    if (name === "undo_movement") {
      const i = movements.findIndex((x) => x.id === args.p_movement_id);
      if (i < 0) return fail("Händelsen hittades inte");
      const m = movements[i], p = products.find((x) => x.id === m.product_id);
      if (p && p.track_stock) {
        if (m.change < 0) p.quantity -= m.change;
        else { if (p.quantity < m.change) return fail("Kan inte ångras: klänningarna har redan sålts"); p.quantity -= m.change; p.total_added -= m.change; }
      }
      movements.splice(i, 1);
      return wait({ data: { id: m.id, change: m.change, photo_path: m.photo_path }, error: null });
    }
    if (name === "remove_stock") {
      const p = products.find((x) => x.code === args.p_code || (x.barcode && x.barcode === String(args.p_code).toUpperCase()));
      if (!p) return fail("Produkten hittades inte");
      if (!(args.p_amount >= 1 && args.p_amount <= 1000)) return fail("Ogiltigt antal");
      if (p.quantity < args.p_amount) return fail("Det finns inte så många kvar i lager");
      p.quantity -= args.p_amount; movements.push({ product_id: p.id, user_id: u.id, change: -args.p_amount, source: "app", created_at: new Date().toISOString() });
      return wait({ data: p.quantity, error: null });
    }
    if (!admin) return fail("Endast admin");
    if (name === "create_product") {
      if ((args.p_sku && products.some((x) => x.sku === args.p_sku)) || (args.p_barcode && products.some((x) => x.barcode === args.p_barcode)))
        return fail("Artikelnumret eller streckkoden används redan");
      const p = mk(args.p_name, args.p_color || "", args.p_size || "", args.p_sku || null, args.p_barcode ? String(args.p_barcode).toUpperCase() : null, args.p_quantity, args.p_quantity, args.p_threshold);
      delete p.remaining;
      products.push(p); if (args.p_quantity) movements.push({ product_id: p.id, user_id: u.id, change: args.p_quantity, source: "app", created_at: new Date().toISOString() });
      return wait({ data: p.id, error: null });
    }
    if (name === "set_barcode") {
      const code = args.p_barcode ? String(args.p_barcode).toUpperCase() : null;
      if (code && products.some((x) => x.barcode === code && x.id !== args.p_product)) return fail("Artikelnumret eller streckkoden används redan");
      products.find((x) => x.id === args.p_product).barcode = code;
      return wait({ data: null, error: null });
    }
    if (name === "add_stock") {
      const p = products.find((x) => x.id === args.p_product);
      p.quantity += args.p_amount; p.total_added += args.p_amount; p.track_stock = true;
      movements.push({ id: movements.length + 1, product_id: p.id, user_id: u.id, change: args.p_amount, source: "app", photo_path: null, photo_thumb: null, created_at: new Date().toISOString() });
      return wait({ data: p.quantity, error: null });
    }
    if (name === "rename_product") {
      const p = products.find((x) => x.id === args.p_product);
      if (!p) return fail("Produkten hittades inte");
      const name2 = String(args.p_name || "").trim();
      if (!name2 || name2.length > 120) return fail("Ogiltigt namn");
      const same = products.filter((x) => args.p_whole_group ? x.name.toLowerCase() === p.name.toLowerCase() : x.id === p.id);
      same.forEach((x) => (x.name = name2));
      return wait({ data: same.length, error: null });
    }
    return fail("okänd");
  }

  function invoke(_name, { body }) {
    const err = (msg) => wait({ data: null, error: { context: { json: async () => ({ error: msg }) } } });
    if (me()?.role !== "admin") return err("Endast admin");
    if (body.action === "create") {
      if (users.some((x) => x.email === body.email.toLowerCase())) return err("Kunde inte skapa konto (finns e-posten redan?)");
      if (body.password.length < 10) return err("Lösenord måste vara 10–72 tecken");
      users.push({ id: uid(), email: body.email.toLowerCase(), full_name: body.full_name, role: body.role, created_at: new Date().toISOString() });
    } else if (body.action === "delete") {
      const i = users.findIndex((x) => x.id === body.user_id); if (i >= 0) users.splice(i, 1);
      movements.forEach((m) => { if (m.user_id === body.user_id) m.user_id = null; });
    }
    return wait({ data: { ok: true }, error: null });
  }

  const auth = {
    async signInWithPassword({ email }) {
      await wait();
      const u = users.find((x) => x.email === email.toLowerCase());
      if (!u) return { data: null, error: { status: 400, message: "Invalid login credentials" } };
      session = { user: { id: u.id, email: u.email } };
      return { data: { session }, error: null };
    },
    async getSession() { return { data: { session } }; },
    async signOut() { session = null; listeners.forEach((f) => f("SIGNED_OUT")); return { error: null }; },
    onAuthStateChange(f) { listeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
  };

  // Låtsaslagring för fotona: sparas bara i minnet
  const photos = new Map();
  const storage = {
    from() {
      return {
        async upload(path, blob) { photos.set(path, blob); return { data: { path }, error: null }; },
        async download(path) { return photos.has(path) ? { data: photos.get(path), error: null } : { data: null, error: { message: "not found" } }; },
      };
    },
  };

  window.supabase = { createClient: () => ({ auth, from, rpc, storage, functions: { invoke } }) };
  window.__demo = { products, users };

  // Låtsaskamera: visar en sökare med knappar för att "skanna" en produkt
  window.Html5QrcodeSupportedFormats = { QR_CODE: 0, CODE_39: 4, CODE_128: 5, EAN_13: 9, EAN_8: 10, UPC_A: 14, UPC_E: 15 };
  window.Html5Qrcode = class {
    constructor(id) { this.el = document.getElementById(id); }
    async start(_cam, _opts, onScan) {
      this.onScan = onScan; this.paused = false;
      const view = document.createElement("div"); view.className = "fake-cam";
      const frame = document.createElement("div"); frame.className = "fake-frame";
      const hint = document.createElement("p"); hint.className = "fake-hint";
      hint.textContent = "Demo: kameran är avstängd här. Tryck på en lapp för att låtsas skanna den.";
      const chips = document.createElement("div"); chips.className = "fake-chips";
      const chip = (text, kind, code) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "fake-chip";
        const k = document.createElement("span"); k.className = "fake-kind"; k.textContent = kind;
        b.append(k, " " + text);
        b.addEventListener("click", () => { if (!this.paused) this.onScan(code); });
        chips.append(b);
      };
      for (const p of window.__demo.products) {
        const label = [p.name.split(" ")[0], p.color, p.size && "stl " + p.size].filter(Boolean).join(" · ");
        p.barcode ? chip(label, "Streckkod", p.barcode) : chip(label, "QR", p.code);
      }
      chip("Ny klänning från leverantör", "Okänd streckkod", "7350012349990");
      view.append(frame, hint, chips); this.el.replaceChildren(view);
    }
    pause() { this.paused = true; this.el.classList.add("is-paused"); }
    resume() { this.paused = false; this.el.classList.remove("is-paused"); }
    async stop() { this.el.replaceChildren(); }
    clear() { this.el.replaceChildren(); }
  };

  window.print = () => {
    const t = document.getElementById("toast");
    t.textContent = "Utskrift fungerar i den riktiga appen, inte i demon."; t.className = "toast"; t.hidden = false;
    setTimeout(() => (t.hidden = true), 2600);
  };

  // Demo-list överst + snabbinloggning
  const bar = document.createElement("div");
  bar.className = "demo-bar"; bar.setAttribute("role", "note");
  bar.innerHTML = '<span>Demo med påhittad data. Inget sparas.</span><span class="row">' +
    '<button class="btn small" type="button" data-demo-login="anna@firma.se">Visa som admin</button>' +
    '<button class="btn small" type="button" data-demo-login="walter@firma.se">Visa som arbetare</button></span>';
  document.body.prepend(bar);

  const quick = document.createElement("div");
  quick.className = "demo-login";
  quick.innerHTML = '<p class="muted">Demo: logga in direkt som</p><div class="row">' +
    '<button class="btn" type="button" data-demo-login="anna@firma.se">Admin</button>' +
    '<button class="btn" type="button" data-demo-login="walter@firma.se">Arbetare</button></div>';
  document.getElementById("login-form").append(quick);

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-demo-login]"); if (!b) return;
    const f = document.getElementById("login-form");
    if (!document.getElementById("view-app").hidden) document.getElementById("logout").click();
    await new Promise((r) => setTimeout(r, 50));
    f.email.value = b.dataset.demoLogin; f.password.value = "demo-losenord";
    f.requestSubmit();
  });
})();
