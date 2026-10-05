// Supabase Edge Function: admin-users
// Skapar och tar bort konton. Körs på Supabases server (gratis) så att
// den hemliga service-nyckeln ALDRIG hamnar i webbläsaren.
//
// Deploy: se README.md (steg 4)

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Sätt till din sajts adress, t.ex. https://mittlager.pages.dev
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers });

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "Fel metod" });
  if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return reply(403, { error: "Otillåten källa" });

  // 1. Vem anropar? Verifiera inloggningstoken hos Supabase.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return reply(401, { error: "Inte inloggad" });

  // 2. Är anroparen admin? Kontrolleras i databasen, inte i webbläsaren.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: me } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (me?.role !== "admin") return reply(403, { error: "Endast admin" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: "Ogiltig förfrågan" }); }

  // ---- Skapa konto ----
  if (body.action === "create") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const fullName = String(body.full_name ?? "").trim();
    const role = body.role === "admin" ? "admin" : "worker";

    if (!EMAIL_RE.test(email)) return reply(400, { error: "Ogiltig e-post" });
    if (password.length < 10 || password.length > 72) return reply(400, { error: "Lösenord måste vara 10–72 tecken" });
    if (fullName.length < 1 || fullName.length > 80) return reply(400, { error: "Ogiltigt namn" });

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error || !created.user) return reply(400, { error: "Kunde inte skapa konto (finns e-posten redan?)" });

    const { error: pErr } = await admin.from("profiles").insert({
      id: created.user.id, email, full_name: fullName, role,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id); // städa upp
      return reply(500, { error: "Kunde inte spara profil" });
    }
    return reply(200, { ok: true });
  }

  // ---- Ta bort konto ----
  if (body.action === "delete") {
    const id = String(body.user_id ?? "");
    if (!UUID_RE.test(id)) return reply(400, { error: "Ogiltigt id" });
    if (id === user.id) return reply(400, { error: "Du kan inte ta bort dig själv" });

    const { error } = await admin.auth.admin.deleteUser(id); // profilen försvinner automatiskt
    if (error) return reply(400, { error: "Kunde inte ta bort konto" });
    return reply(200, { ok: true });
  }

  // ---- Byt lösenord åt en användare ----
  if (body.action === "reset_password") {
    const id = String(body.user_id ?? "");
    const password = String(body.password ?? "");
    if (!UUID_RE.test(id)) return reply(400, { error: "Ogiltigt id" });
    if (password.length < 10 || password.length > 72) return reply(400, { error: "Lösenord måste vara 10–72 tecken" });
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return reply(400, { error: "Kunde inte byta lösenord" });
    return reply(200, { ok: true });
  }

  return reply(400, { error: "Okänd åtgärd" });
});
