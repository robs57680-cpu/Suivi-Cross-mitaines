/* Envoie les notifications push de Box Score, aux navigateurs (Web Push) et aux applis iPhone / Android (Firebase Cloud Messaging) (nouvelle séance, message du coach, réaction reçue, séance validée par un autre athlète,
   rappel du bonus quotidien le matin, résumé de la semaine — à tous les abonnés, coach compris — et, pour le coach seulement, nouvelle inscription et nouvel abonnement payant/essai).
   Lancé toutes les 15 minutes par .github/workflows/notify.yml. L'état (dernier passage, notifications déjà envoyées)
   est gardé dans Firestore : config/pushState. Il est enregistré AVANT l'envoi : en cas de plantage pendant l'envoi, mieux vaut une notification
   manquée que des doublons à chaque passage suivant. (Ce fichier remplace notify-weekly-recap.mjs : ne pas l'importer en plus.) */
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
const { lastRun, sent = [], seenSubs } = st.data();
const since = new Date(new Date(lastRun).getTime() - OVERLAP_MS).toISOString();
const done = new Set(sent);

const [wSnap, rSnap, aSnap, lSnap, subSnap] = await Promise.all([
  db.collection('wods').where('publishedAt', '>', since).get(),
  db.collection('reactions').where('at', '>', since).get(),
  db.doc('config/announcement').get(),
  db.collection('logs').get(),
  db.collection('subs').get()
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
/* nouveaux abonnements : documents subs/{uid} (écrits par la synchro Stripe) dont l'abonnement est en essai ou actif et dont le uid n'a jamais été notifié.
   La liste des uid déjà vus est gardée à part (seenSubs), sans la limite KEEP. Au tout premier passage avec cette fonction (seenSubs absent),
   les abonnements déjà présents sont marqués comme vus sans notification. */
const subOk = d => d.active === true || d.status === 'trialing' || d.status === 'active';
const currentSubs = subSnap.docs.filter(d => subOk(d.data())).map(d => ({ uid: d.id, plan: d.data().plan, status: d.data().status }));
const firstSubRun = !Array.isArray(seenSubs);
const seenSet = new Set(firstSubRun ? [] : seenSubs);
const newSubs = firstSubRun ? [] : currentSubs.filter(x => !seenSet.has(x.uid));
const seenSubsNext = [...new Set([...(firstSubRun ? [] : seenSubs), ...currentSubs.map(x => x.uid)])].slice(-5000);
/* résumé de la semaine : le lundi de 5 h à 12 h (heure de Paris), une seule fois par lundi (clé « m:AAAA-MM-JJ » = ce lundi),
   seulement si la semaine écoulée (lundi → dimanche) avait au moins une séance. Passé 12 h, on ne l'envoie plus (la bannière du Fil prend le relais dans l'appli). */
const RECAP_FROM_H = 5, RECAP_UNTIL_H = 12;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const newRecap = [];
try {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const hour = Number(p.hour), monday = `${p.year}-${p.month}-${p.day}`, key = 'm:' + monday;
  if (p.weekday === 'Mon' && hour >= RECAP_FROM_H && hour < RECAP_UNTIL_H && !done.has(key)) {
    const FP = admin.firestore.FieldPath;
    const prev = await db.collection('wods').where(FP.documentId(), '>=', addDays(monday, -7)).where(FP.documentId(), '<=', addDays(monday, -1)).limit(1).get();
    if (!prev.empty) newRecap.push({ key, monday });
    else console.log('Résumé de la semaine : aucune séance la semaine passée, pas de notification.');
  }
} catch (e) {
  console.error('Résumé de la semaine impossible : ' + (e.message || e));
}
/* rappel du bonus quotidien : le matin, de 8 h à 12 h (heure de Paris), une seule fois par jour (clé « b:AAAA-MM-JJ »),
   à chaque compte (coach compris) qui n'a pas encore récupéré son bonus du jour (clé « dc:AAAA-MM-JJ » absente de logs/{uid}.coinGot).
   Le montant suit la même règle que l'appli : 5 coins, 20 coins le 7e jour d'affilée. */
const BONUS_FROM_H = 8, BONUS_UNTIL_H = 12;
const newBonus = [];
try {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const hour = Number(p.hour), today = `${p.year}-${p.month}-${p.day}`, key = 'b:' + today;
  if (hour >= BONUS_FROM_H && hour < BONUS_UNTIL_H && !done.has(key)) {
    const users = [];
    for (const d of lSnap.docs) {
      const lg = d.data(), cg = lg.coinGot || {};
      if (!lg.pseudo || cg['dc:' + today] !== undefined) continue;
      let n = 0, day = addDays(today, -1);
      while (cg['dc:' + day] !== undefined && n < 4000) { n++; day = addDays(day, -1); }
      const cycle = (n % 7) + 1; /* case du cycle de 7 jours que l'athlète récupérerait aujourd'hui */
      users.push({ uid: d.id, coins: cycle === 7 ? 20 : 5, cycle });
    }
    newBonus.push({ key, users });
  }
} catch (e) {
  console.error('Rappel du bonus quotidien impossible : ' + (e.message || e));
}
console.log(`Nouvelles séances : ${newWods.length} · nouveau message du coach : ${newAnn.length} · nouvelles réactions : ${newRx.length} · nouvelles séances validées : ${newSess.length} · nouveaux comptes : ${newUsers.length} · résumé de la semaine : ${newRecap.length} · nouveaux abonnements : ${newSubs.length} · rappel bonus : ${newBonus.length ? newBonus[0].users.length + ' compte(s)' : 'non'}`);

const saveState = () => stRef.set({ lastRun: now.toISOString(), sent: [...sent, ...newWods.map(x => x.key), ...newAnn.map(x => x.key), ...newRx.map(x => x.key), ...newSess.map(x => x.key), ...newUsers.map(x => x.key), ...newRecap.map(x => x.key), ...newBonus.map(x => x.key)].slice(-KEEP), seenSubs: seenSubsNext });
if (!newWods.length && !newAnn.length && !newRx.length && !newSess.length && !newUsers.length && !newRecap.length && !newSubs.length && !newBonus.length) { await saveState(); process.exit(0); }

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
/* résumé de la semaine : à tous les appareils abonnés, coach compris (texte à part pour lui) ; s'ouvre sur l'écran du résumé (?go=recap) */
if (newRecap.length) {
  for (const uid of new Set(subs.map(s => s.uid))) {
    add(uid, uid === coachUid
      ? { tag: 'recap', title: 'Résumé de la semaine', body: 'Le résumé de la semaine est prêt : découvre comment le classement a bougé.', go: 'recap' }
      : { tag: 'recap', title: 'Ta semaine', body: 'Ton résumé de la semaine est prêt : découvre comment le classement a bougé.', go: 'recap' });
  }
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

/* nouvel abonnement : notification pour le coach uniquement (pas pour son propre compte) */
const subscribed = newSubs.filter(x => x.uid !== coachUid);
if (subscribed.length && coachUid) {
  const planName = p => p === 'season' ? 'forfait saison' : p === '4w' ? 'forfait 4 semaines' : '';
  const nm = x => cut(pseudoOf[x.uid] || 'Un athlète', 24);
  const body = subscribed.length === 1
    ? `${nm(subscribed[0])} s'est abonné${planName(subscribed[0].plan) ? ' (' + planName(subscribed[0].plan) + ')' : ''}${subscribed[0].status === 'trialing' ? ', essai gratuit en cours' : ''}.`
    : `${subscribed.length} nouveaux abonnements : ${[...new Set(subscribed.map(nm))].slice(0, 3).join(', ')}${subscribed.length > 3 ? '…' : ''}.`;
  add(coachUid, { tag: 'subscription', title: subscribed.length === 1 ? 'Nouvel abonnement' : 'Nouveaux abonnements', body, go: 'feed' });
}

/* rappel du bonus quotidien (seulement aux comptes qui ont un appareil abonné) */
if (newBonus.length) {
  const withDevice = new Set(subs.map(s => s.uid));
  for (const u of newBonus[0].users) {
    if (!withDevice.has(u.uid)) continue;
    add(u.uid, { tag: 'bonus', title: '🎁 Ton bonus quotidien t\'attend', body: u.cycle === 7
      ? `Jour 7 de ta série : récupère tes ${u.coins} coins aujourd'hui !`
      : `Ouvre Box Score pour récupérer tes ${u.coins} coins du jour${u.cycle > 1 ? ' et garder ta série (jour ' + u.cycle + ')' : ''}.`, go: 'today' });
  }
}

/* pastille (nombre sur l'icône de l'appli) : un compteur par appareil, pushCount/{id de pushSubs} = { n, at }.
   Il repart de 0 quand l'appli est ouverte : l'appli réenregistre alors son appareil (pushSubs/{id}.at change). */
const cntRef = id => db.doc('pushCount/' + id);
const counts = {};
{
  const ids = subs.filter(s => (msgs[s.uid] || []).length).map(s => s.id);
  for (let i = 0; i < ids.length; i += 300) {
    const snaps = ids.slice(i, i + 300).length ? await db.getAll(...ids.slice(i, i + 300).map(cntRef)) : [];
    for (const sn of snaps) counts[sn.id] = sn.exists ? sn.data() : null;
  }
}
const badgeNext = s => { const c = counts[s.id]; const n = (c && c.at === s.at ? Number(c.n) || 0 : 0) + 1; counts[s.id] = { n, at: s.at }; return n; };

/* état enregistré avant l'envoi (voir l'entête) */
await saveState();

let ok = 0, gone = 0, fail = 0;
const FCM_DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
for (const s of subs) {
  for (const m of msgs[s.uid] || []) {
    const badge = badgeNext(s);
    if (s.fcm) {
      /* appli iPhone : notification Firebase Cloud Messaging (APNs). « go » part dans les données et ouvre le bon onglet au toucher. */
      try {
        await admin.messaging().send({
          token: s.fcm,
          notification: { title: m.title || 'Box Score', body: m.body || '' },
          data: { go: String(m.go || 'feed'), tag: String(m.tag || ''), badge: String(badge) },
          apns: { headers: { 'apns-collapse-id': String(m.tag || 'bs').slice(0, 60), 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400) }, payload: { aps: { sound: 'default', badge } } },
          android: { ttl: 86400000, notification: { notificationCount: badge, tag: String(m.tag || 'bs').slice(0, 60) } }
        });
        ok++;
      } catch (e) {
        if (FCM_DEAD.has(e.code)) { try { await db.doc('pushSubs/' + s.id).delete(); } catch (_) {} gone++; break; } /* jeton expiré ou appli désinstallée */
        fail++; console.error('Échec d’envoi iPhone (' + (e.code || '?') + ') : ' + (e.message || e));
      }
      continue;
    }
    if (!s.endpoint) continue;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: 'Box Score', ...m, badge }), { TTL: 86400, urgency: 'normal' });
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { try { await db.doc('pushSubs/' + s.id).delete(); } catch (_) {} gone++; break; } /* abonnement expiré ou désinscrit (seuls ces deux codes) */
      fail++; console.error('Échec d’envoi (' + (e.statusCode || '?') + ') : ' + (e.body || e.message));
    }
  }
}
console.log(`Envoyées : ${ok} · appareils retirés : ${gone} · échecs : ${fail}`);
/* compteurs des pastilles enregistrés après l'envoi */
try {
  const ids = subs.filter(s => (msgs[s.uid] || []).length && counts[s.id]).map(s => s.id);
  for (let i = 0; i < ids.length; i += 400) {
    const b = db.batch();
    ids.slice(i, i + 400).forEach(id => b.set(cntRef(id), counts[id]));
    await b.commit();
  }
} catch (e) { console.error('Compteurs des pastilles non enregistrés : ' + (e.message || e)); }
