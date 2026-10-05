// Supabase Edge Function: shop-sync
// Koppling mellan lagret och er webbshop.
//
// ⛔ AVSTÄNGD tills secret SHOP_SYNC_ENABLED sätts till "true".
//    Innan dess svarar den alltid 503 och rör ingenting.
//
// När den är på:
//   GET  /functions/v1/shop-sync/stock   -> saldo för alla klänningar som har artikelnummer
//   POST /functions/v1/shop-sync/order   -> dra sålda klänningar från lagret
//        body: { "order_id": "1001", "items": [ { "sku": "MAJA-SV-M", "quantity": 1 } ] }
//
// Webbshoppen måste skicka headern:  x-api-key: <SHOP_API_KEY>
// Se README.md, avsnittet "Webbshop-koppling".

import { createClient } from "npm:@supabase/supabase-js@2";

const ENABLED = Deno.env.get("SHOP_SYNC_ENABLED") === "true";
const API_KEY = Deno.env.get("SHOP_API_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Jämför nycklar på konstant tid (skydd mot tidsattacker)
async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const SKU_RE = /^[A-Za-z0-9._\-]{1,64}$/;

Deno.serve(async (req) => {
  if (!ENABLED) return json(503, { error: "Webbshop-kopplingen är inte aktiverad" });
  if (API_KEY.length < 32) return json(500, { error: "SHOP_API_KEY saknas eller är för kort" });
  if (!(await safeEqual(req.headers.get("x-api-key") ?? "", API_KEY))) return json(401, { error: "Fel nyckel" });

  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  // ---- Hämta saldo ----
  if (req.method === "GET" && path.endsWith("/stock")) {
    const { data, error } = await db.from("products")
      .select("sku, name, color, size, quantity").not("sku", "is", null).order("sku");
    if (error) return json(500, { error: "Kunde inte läsa lagret" });
    return json(200, { items: data });
  }

  // ---- Order från webbshoppen ----
  if (req.method === "POST" && path.endsWith("/order")) {
    let body: { order_id?: unknown; items?: unknown };
    try { body = await req.json(); } catch { return json(400, { error: "Ogiltig JSON" }); }

    const orderId = String(body.order_id ?? "").slice(0, 60);
    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    if (!orderId || !items.length) return json(400, { error: "order_id och items krävs" });

    const results = [];
    for (const it of items as Array<{ sku?: unknown; quantity?: unknown }>) {
      const sku = String(it.sku ?? "");
      const qty = Number(it.quantity);
      if (!SKU_RE.test(sku) || !Number.isInteger(qty) || qty < 1 || qty > 1000) {
        results.push({ sku, ok: false, error: "Ogiltig rad" });
        continue;
      }
      const { data, error } = await db.rpc("shop_remove_stock", { p_sku: sku, p_amount: qty, p_order_ref: orderId });
      results.push(error ? { sku, ok: false, error: "Okänt artikelnummer" } : { sku, ok: true, quantity: data });
    }
    return json(200, { order_id: orderId, results });
  }

  return json(404, { error: "Okänd adress" });
});
