/* Service worker des notifications Box Score : il ne met rien en cache, il affiche seulement les notifications push. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));

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
