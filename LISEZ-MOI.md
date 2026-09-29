# Doxami Ticketing — mise en route

1. **Base de données** : Supabase → SQL Editor → collez et exécutez tout `supabase-schema.sql`
   (relançable sans risque, y compris sur une base créée avec l'ancienne version).
2. **Configuration** : ouvrez `config.js`, renseignez `SUPABASE_URL` et `SUPABASE_ANON_KEY`
   (Project Settings → API, clé **anon public**, jamais la `service_role`).
3. **Lancement** : servez le dossier en HTTPS (Netlify, Vercel, GitHub Pages…), ou en local :
   `python3 -m http.server 8000` puis http://localhost:8000
   La caméra ne fonctionne qu'en HTTPS ou sur `localhost`.
4. Supabase → Authentication → Providers → Email : désactivez « Confirm email » si vous
   voulez une inscription sans e-mail de confirmation.

## Fonctionnement d'un billet
Le QR contient `NUMERO|JETON` (ex. `DCF-0042|K7M2…`). Au scan, le serveur exige que le
numéro **et** le jeton correspondent, puis marque le billet « utilisé » en une seule
transaction : un même billet ne peut pas entrer deux fois, même avec deux scanners simultanés.
