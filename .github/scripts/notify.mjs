/* Envoie les notifications push de Box Score (nouvelle séance, message du coach, réaction reçue, et, pour le coach, nouvelle inscription).
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

const [wSnap, rSnap, aSnap, lSnap] = await Promise.all([
  db.collection('wods').where('publishedAt', '>', since).get(),
  db.collection('reactions').where('at', '>', since).get(),
  db.doc('config/announcement').get(),
  db.collection('logs').get()
]);
const newWods = wSnap.docs.map(d => ({ ...d.data(), id: d.id, key: 'w:' + d.id + ':' + d.data().publishedAt })).filter(x => !done.has(x.key));
const newRx = rSnap.docs.map(d => ({ ...d.data(), id: d.id, key: 'r:' + d.id + ':' + d.data().at })).filter(x => !done.has(x.key) && x.to && x.from !== x.to);
/* séances validées par les athlètes (apparues dans le fil) : logs/{uid}.entries[date].at. Une séance n'est notifiée qu'une fois (clé uid + date),
   même si l'athlète la modifie ensuite. Les REDO ne sont pas dans entries. */
const newSess = [];
for (const d of lSnap.docs) {
  const lg = d.data(), entries = lg.entries || {};
  for (const [date, e] of Object.entries(entries)) {
    if (!e || !e.at || e.at <= since) continue;
    const key = 's:' + d.id + ':' + date;
    if (!done.has(key)) newSess.push({ uid: d.id, pseudo: lg.pseudo, date, key });
  }
}
/* message du coach : document unique config/announcement. Notifié une seule fois par id, seulement si le coach a laissé « notify:true »
   (une simple correction du message est enregistrée avec notify:false), si le message est actif et publié depuis moins de 24 h. */
const ANN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ann = aSnap.exists ? aSnap.data() : null;
const newAnn = (ann && ann.id && ann.active !== false && ann.notify === true && String(ann.text || '').trim()
  && Date.now() - new Date(ann.at).getTime() < ANN_MAX_AGE_MS)
  ? [{ ...ann, key: 'a:' + ann.id }].filter(x => !done.has(x.key)) : [];
/* nouveaux comptes : liste des comptes Firebase Authentication créés depuis le dernier passage (une seule notification par compte, clé « u:uid »).
   Le nom affiché est le pseudo s'il existe déjà, sinon le nom du compte, sinon le début de l'adresse e-mail. Une erreur de droits ne bloque pas les autres notifications. */
const pseudoOf = Object.fromEntries(lSnap.docs.map(d => [d.id, d.data().pseudo]));
const newUsers = [];
try {
  let token;
  do {
    const page = await admin.auth().listUsers(1000, token);
    for (const u of page.users) {
      const key = 'u:' + u.uid;
      if (done.has(key) || !u.metadata || !u.metadata.creationTime) continue;
      if (new Date(u.metadata.creationTime).toISOString() <= since) continue;
      newUsers.push({ uid: u.uid, key, name: pseudoOf[u.uid] || u.displayName || (u.email || '').split('@')[0] });
    }
    token = page.pageToken;
  } while (token);
} catch (e) {
  console.error('Liste des comptes impossible (droits du compte de service ?) : ' + (e.message || e));
}
console.log(`Nouvelles séances : ${newWods.length} · nouveau message du coach : ${newAnn.length} · nouvelles réactions : ${newRx.length} · nouvelles séances validées : ${newSess.length} · nouveaux comptes : ${newUsers.length}`);

const saveState = () => stRef.set({ lastRun: now.toISOString(), sent: [...sent, ...newWods.map(x => x.key), ...newAnn.map(x => x.key), ...newRx.map(x => x.key), ...newSess.map(x => x.key), ...newUsers.map(x => x.key)].slice(-KEEP) });
if (!newWods.length && !newAnn.length && !newRx.length && !newSess.length && !newUsers.length) { await saveState(); process.exit(0); }

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
if (newAnn.length) {
  const a = newAnn[0];
  for (const uid of new Set(subs.map(s => s.uid))) if (uid !== coachUid) add(uid, { tag: 'ann', title: cut(a.title, 60) || 'Message du coach', body: cut(a.text, 140), go: 'feed' });
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

if (newSess.length) {
  const wods = Object.fromEntries((await db.collection('wods').get()).docs.map(d => [d.id, d.data()]));
  for (const uid of new Set(subs.map(s => s.uid))) {
    const l = newSess.filter(x => x.uid !== uid); /* pas de notification pour sa propre séance */
    if (!l.length) continue;
    const names = [...new Set(l.map(x => cut(x.pseudo || 'Un athlète', 24)))];
    const body = l.length === 1
      ? `${names[0]} a validé « ${cut((wods[l[0].date] || {}).title || 'sa séance', 60)} »`
      : names.length === 1 ? `${names[0]} a validé ${l.length} séances`
      : `${names[0]} et ${names.length - 1} autre${names.length > 2 ? 's' : ''} ont validé leur séance`;
    add(uid, { tag: 'session', body, go: 'feed' });
  }
}

/* nouvelle inscription : notification pour le coach uniquement (pas pour son propre compte) */
const joined = newUsers.filter(x => x.uid !== coachUid);
if (joined.length && coachUid) {
  const names = [...new Set(joined.map(x => cut(x.name || '', 24)).filter(Boolean))];
  const body = joined.length === 1
    ? (names[0] ? `${names[0]} vient de s'inscrire.` : 'Un nouvel athlète vient de s\'inscrire.')
    : `${joined.length} nouveaux inscrits${names.length ? ' : ' + names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '') : ''}.`;
  add(coachUid, { tag: 'signup', title: joined.length === 1 ? 'Nouvel inscrit' : 'Nouveaux inscrits', body, go: 'feed' });
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
