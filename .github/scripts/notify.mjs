/* Envoie les notifications push de Box Score (nouvelle séance, réaction reçue).
   Lancé toutes les 15 minutes par .github/workflows/notify.yml. L'état (dernier passage, notifications déjà envoyées)
   est gardé dans Firestore : config/pushState. */
import admin from 'firebase-admin';
import webpush from 'web-push';

const need = n => { const v = process.env[n]; if (!v) { console.error('Secret manquant : ' + n); process.exit(1); } return v; };
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))) });
webpush.setVapidDetails(need('VAPID_SUBJECT'), need('VAPID_PUBLIC_KEY'), need('VAPID_PRIVATE_KEY'));
const db = admin.firestore();

const OVERLAP_MS = 15 * 60 * 1000; /* marge pour l'horloge des téléphones ; les doublons sont évités par la liste « sent » */
const KEEP = 400;
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const now = new Date();
const stRef = db.doc('config/pushState');
const st = await stRef.get();
if (!st.exists) {
  await stRef.set({ lastRun: now.toISOString(), sent: [] });
  console.log('Première exécution : état initialisé, aucune notification envoyée.');
  process.exit(0);
}
const { lastRun, sent = [] } = st.data();
const since = new Date(new Date(lastRun).getTime() - OVERLAP_MS).toISOString();
const done = new Set(sent);

const [wSnap, rSnap] = await Promise.all([
  db.collection('wods').where('publishedAt', '>', since).get(),
  db.collection('reactions').where('at', '>', since).get()
]);
const newWods = wSnap.docs.map(d => ({ ...d.data(), id: d.id, key: 'w:' + d.id + ':' + d.data().publishedAt })).filter(x => !done.has(x.key));
const newRx = rSnap.docs.map(d => ({ ...d.data(), id: d.id, key: 'r:' + d.id + ':' + d.data().at })).filter(x => !done.has(x.key) && x.to && x.from !== x.to);
console.log(`Nouvelles séances : ${newWods.length} · nouvelles réactions : ${newRx.length}`);

const saveState = () => stRef.set({ lastRun: now.toISOString(), sent: [...sent, ...newWods.map(x => x.key), ...newRx.map(x => x.key)].slice(-KEEP) });
if (!newWods.length && !newRx.length) { await saveState(); process.exit(0); }

const subs = (await db.collection('pushSubs').get()).docs.map(d => ({ ...d.data(), id: d.id }));
const coach = await db.doc('config/coach').get();
const coachUid = coach.exists ? coach.data().uid : null;

const msgs = {};
const add = (uid, m) => (msgs[uid] = msgs[uid] || []).push(m);

if (newWods.length) {
  const body = newWods.length === 1
    ? `Nouvelle séance : « ${cut(newWods[0].title, 60)} ». Elle t'attend !`
    : `${newWods.length} nouvelles séances t'attendent !`;
  for (const uid of new Set(subs.map(s => s.uid))) if (uid !== coachUid) add(uid, { tag: 'wod', body, go: 'today' });
}
if (newRx.length) {
  const wods = Object.fromEntries((await db.collection('wods').get()).docs.map(d => [d.id, d.data()]));
  const by = {};
  newRx.forEach(r => (by[r.to] = by[r.to] || []).push(r));
  for (const [uid, l] of Object.entries(by)) {
    const body = l.length === 1
      ? `${cut(l[0].pseudo || 'Un athlète', 24)} a réagi ${l[0].emoji || ''} à ta séance « ${cut((wods[l[0].date] || {}).title || 'séance', 60)} »`
      : `${l.length} nouvelles réactions sur tes séances`;
    add(uid, { tag: 'reaction', body, go: 'feed' });
  }
}

let ok = 0, gone = 0, fail = 0;
for (const s of subs) {
  for (const m of msgs[s.uid] || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: 'Box Score', ...m }), { TTL: 86400, urgency: 'normal' });
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await db.doc('pushSubs/' + s.id).delete(); gone++; break; } /* appareil désinscrit */
      fail++; console.error('Échec d’envoi (' + (e.statusCode || '?') + ') : ' + (e.body || e.message));
    }
  }
}
console.log(`Envoyées : ${ok} · appareils retirés : ${gone} · échecs : ${fail}`);
await saveState();
