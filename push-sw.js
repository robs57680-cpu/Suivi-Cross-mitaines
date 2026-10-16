/* Service worker de Box Score : notifications push + mode hors ligne.

   Mode hors ligne :
   - index.html : le réseau passe en premier (la dernière version est toujours servie et le bandeau « Mettre à jour »
     continue de fonctionner) ; sans réseau, ou si le réseau met plus de 4 s à répondre, on sert la copie gardée.
   - assets, manifeste, firebase-config.js… : copie locale servie tout de suite, puis revérifiée en arrière-plan.
   - modules Firebase et polices Google : gardés après le premier chargement.
   - Firestore, authentification, notifications : jamais interceptés (Firestore gère lui-même sa file hors ligne).

   Si tu changes la logique de ce fichier, change aussi le numéro de version des caches ci-dessous (v1 → v2). */

const SHELL='boxscore-shell-v1';   /* index.html */
const FILES='boxscore-files-v1';   /* assets et fichiers du site */
const CDN='boxscore-cdn-v1';       /* modules Firebase et polices */
const KEEP=[SHELL,FILES,CDN];

const SCOPE=self.registration.scope;
const SCOPE_PATH=new URL(SCOPE).pathname;
const INDEX_URL=new URL('./',SCOPE).href;
/* petits fichiers gardés dès l'installation (les images lourdes sont gardées seulement quand elles sont affichées) */
const PRECACHE=['manifest.webmanifest','firebase-config.js','assets/icons/icon-192.png','assets/icons/apple-touch-icon.png'];
const FIREBASE_V='10.14.1';
const FIREBASE_MODULES=['firebase-app.js','firebase-auth.js','firebase-firestore.js'].map(f=>'https://www.gstatic.com/firebasejs/'+FIREBASE_V+'/'+f);

self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil((async()=>{
    /* chaque étape est facultative : un échec ne doit jamais empêcher l'installation */
    try{
      const shell=await caches.open(SHELL);
      const r=await fetch(INDEX_URL,{cache:'no-cache'});
      if(r.ok)await shell.put(INDEX_URL,r);
    }catch(_){}
    try{
      const files=await caches.open(FILES);
      await Promise.allSettled(PRECACHE.map(async f=>{
        const u=new URL(f,SCOPE).href;
        const r=await fetch(u,{cache:'no-cache'});
        if(r.ok)await files.put(u,r);
      }));
    }catch(_){}
    try{
      const cdn=await caches.open(CDN);
      const seen=new Set();
      for(const m of FIREBASE_MODULES)await cacheModuleTree(cdn,m,seen);
    }catch(_){}
  })());
});

/* garde un module Firebase et tous les modules qu'il importe */
async function cacheModuleTree(cache,url,seen){
  if(seen.has(url)||seen.size>80)return;
  seen.add(url);
  let res=await cache.match(url,{ignoreVary:true});
  if(!res){
    res=await fetch(url,{mode:'cors',credentials:'omit'});
    if(!res.ok)return;
    await cache.put(url,res.clone());
  }
  const txt=await res.clone().text();
  const re=/(?:from|import)\s*\(?\s*["']((?:https:\/\/www\.gstatic\.com\/firebasejs\/|\.{1,2}\/)[^"']+\.js)["']/g;
  const next=[];let m;
  while((m=re.exec(txt)))next.push(new URL(m[1],url).href);
  for(const n of next)await cacheModuleTree(cache,n,seen);
}

self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const ks=await caches.keys();
  await Promise.all(ks.filter(k=>/^boxscore-/.test(k)&&!KEEP.includes(k)).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'||req.headers.has('range'))return;
  const url=new URL(req.url);

  if(url.origin===self.location.origin){
    if(!url.href.startsWith(SCOPE)||url.pathname.endsWith('/push-sw.js'))return;
    const isIndex=url.pathname===SCOPE_PATH||url.pathname===SCOPE_PATH+'index.html';
    if(isIndex){e.respondWith(indexResponse(e,req));return;}
    e.respondWith(staleWhileRevalidate(e,req));
    return;
  }
  if(url.hostname==='www.gstatic.com'&&url.pathname.startsWith('/firebasejs/')){e.respondWith(cacheFirst(req,CDN));return;}
  if(url.hostname==='fonts.googleapis.com'){e.respondWith(cacheFirst(req,CDN,true));return;}
  if(url.hostname==='fonts.gstatic.com'){e.respondWith(cacheFirst(req,CDN));return;}
  /* tout le reste (Firestore, authentification…) passe directement par le réseau */
});

async function indexResponse(e,req){
  const cache=await caches.open(SHELL);
  const cached=await cache.match(INDEX_URL,{ignoreVary:true});
  /* navigation : on revalide toujours auprès du serveur ; la vérification de version de l'appli garde sa requête « no-store » d'origine */
  const net=(req.mode==='navigate'?fetch(INDEX_URL,{cache:'no-cache'}):fetch(req)).then(async res=>{
    if(res.ok&&res.status===200)await cache.put(INDEX_URL,res.clone());
    return res;
  });
  e.waitUntil(net.catch(()=>{}));
  if(!cached)return net;
  try{
    return await Promise.race([net,new Promise((_,rej)=>setTimeout(rej,4000))]);
  }catch(_){
    return cached;
  }
}

async function staleWhileRevalidate(e,req){
  const cache=await caches.open(FILES);
  const hit=await cache.match(req,{ignoreVary:true});
  const net=fetch(req,{cache:'no-cache'}).then(async res=>{
    if(res.ok&&res.status===200){
      const tag=res.headers.get('etag');
      const same=hit&&tag&&tag===hit.headers.get('etag');
      if(!same)await cache.put(req,res.clone());
    }
    return res;
  });
  if(hit){e.waitUntil(net.catch(()=>{}));return hit;}
  return net;
}

async function cacheFirst(req,name,forceCors){
  const cache=await caches.open(name);
  const hit=await cache.match(req.url,{ignoreVary:true});
  if(hit)return hit;
  /* la feuille de style des polices est demandée sans CORS : on la redemande avec CORS pour pouvoir la garder */
  const res=await fetch(forceCors?new Request(req.url,{mode:'cors',credentials:'omit'}):req);
  if(res.ok&&res.status===200)await cache.put(req.url,res.clone());
  return res;
}

/* ---------- notifications push (inchangé) ---------- */
self.addEventListener('push',e=>{
  let d={};
  try{d=e.data?e.data.json():{};}catch(_){}
  const icon=new URL('assets/icons/icon-192.png',self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(d.title||'Box Score',{
    body:d.body||'',icon,badge:icon,
    tag:d.tag||undefined,renotify:!!d.tag,
    data:{go:d.go||'feed'}
  }));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const go=(e.notification.data&&e.notification.data.go)||'feed';
  e.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of list){
      if('focus' in c){await c.focus();c.postMessage({type:'go',go});return;}
    }
    await self.clients.openWindow(self.registration.scope+'?go='+go);
  })());
});
