/* Cloudflare Pages Function : POST /api/checkout   corps : { plan: '4w' | 'season' }
   Crée une session de paiement Stripe pour le compte connecté, en conservant l'essai gratuit restant :
   la carte est enregistrée maintenant, mais le premier prélèvement n'a lieu qu'à la fin de l'essai.
   Si l'essai se termine dans moins de 50 h (limite de Stripe : 48 h), la personne est facturée tout de suite.

   Variables à définir dans Cloudflare (Workers & Pages > ton projet > Settings > Variables and Secrets) :
     STRIPE_SECRET_KEY  (secret)  clé secrète Stripe : sk_test_… pour les essais, puis la clé du mode réel
     FIREBASE_API_KEY             apiKey de firebase-config.js (clé publique du projet Firebase)
     PRICE_4W                     identifiant du prix « 4 semaines » (price_…)
     PRICE_SEASON                 identifiant du prix « 12 semaines » (price_…)
     PAY_OPEN                     date d'ouverture des paiements, ex. 2026-11-02T00:00:00+01:00 */

const TRIAL_DAYS = 14;               /* même valeur que TRIAL_DAYS dans index.html */
const MIN_TRIAL_MS = 50 * 3600e3;    /* Stripe exige une fin d'essai à au moins 48 h */

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestPost({ request, env }) {
  try {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'non connecté' }, 401);

    let body = {};
    try { body = await request.json(); } catch (e) {}
    const price = { '4w': env.PRICE_4W, 'season': env.PRICE_SEASON }[body.plan];
    if (!price) return json({ error: 'forfait inconnu' }, 400);

    const origin = new URL(request.url).origin;

    /* 1) Google vérifie le jeton de connexion et renvoie le compte (identifiant, e-mail, date de création).
          Le serveur ne fait donc jamais confiance à une date envoyée par l'appli. */
    const lk = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(env.FIREBASE_API_KEY || ''),
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': origin + '/' }, body: JSON.stringify({ idToken: token }) }
    );
    if (!lk.ok) { console.error('lookup', lk.status, await lk.text()); return json({ error: 'session invalide' }, 401); }
    const user = ((await lk.json()).users || [])[0];
    if (!user || !user.localId) return json({ error: 'compte introuvable' }, 401);

    /* 2) fin d'essai = max(date de création du compte, ouverture des paiements) + 14 jours (comme payState() dans l'appli) */
    const created = Number(user.createdAt) || Date.now();
    const open = Date.parse(env.PAY_OPEN || '') || 0;
    const trialEnd = Math.max(created, open) + TRIAL_DAYS * 864e5;

    /* 3) session de paiement Stripe */
    const p = new URLSearchParams();
    p.set('mode', 'subscription');
    p.set('line_items[0][price]', price);
    p.set('line_items[0][quantity]', '1');
    p.set('client_reference_id', user.localId);            /* c'est ce qui relie le paiement au compte (lu par sync-stripe.mjs) */
    p.set('subscription_data[metadata][uid]', user.localId);
    if (user.email) p.set('customer_email', user.email);
    p.set('locale', 'fr');
    p.set('success_url', origin + '/');
    p.set('cancel_url', origin + '/');
    if (trialEnd - Date.now() >= MIN_TRIAL_MS) p.set('subscription_data[trial_end]', String(Math.floor(trialEnd / 1000)));

    const st = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p
    });
    const sess = await st.json();
    if (!st.ok || !sess.url) { console.error('stripe', st.status, JSON.stringify(sess.error || sess)); return json({ error: 'paiement indisponible' }, 502); }
    return json({ url: sess.url });
  } catch (e) {
    console.error(e);
    return json({ error: 'erreur serveur' }, 500);
  }
}
