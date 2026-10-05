// ============================================================
//  FYLL I DINA EGNA VÄRDEN HÄR (se README.md, steg 2)
//  Supabase -> Project Settings -> API Keys (adressen finns under "Connect")
//  OBS: "Publishable key" (sb_publishable_...) är gjord för att ligga i webbläsaren.
//  Lägg ALDRIG in "Secret key" (sb_secret_...) eller "service_role" här!
// ============================================================
window.LAGER_CONFIG = {
  SUPABASE_URL: "https://oyxeuriyouflesoinstw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_trioemzx2HoHrXy-0q3BoA_Te_vmeUS",
  APP_NAME: "Klänningslagret",
  // Logga ut automatiskt efter så här många minuter utan aktivitet
  IDLE_LOGOUT_MINUTES: 30,
  // Låt kameran läsa skrivna koder (laddar ner ca 7 MB första gången kameran startas)
  READ_WRITTEN_CODES: true,
  // Foto vid försäljning: "required" (måste ha foto), "optional" (går bra utan) eller "off" (inget fotosteg)
  PHOTO_ON_SHIP: "optional",
};
