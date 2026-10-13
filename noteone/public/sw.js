const CACHE = 'book-offline-v1';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
  if(event.data?.type==='CLEAR_OFFLINE')event.waitUntil(caches.delete(CACHE));
  if(event.data?.type==='ENABLE_OFFLINE')event.waitUntil((async()=>{
    try {
      const cache=await caches.open(CACHE);
      const page=await fetch('/',{credentials:'same-origin',cache:'no-store'});
      if(!page.ok||page.headers.get('x-book-shell')!=='1')throw Error('login required');
      const asset=new URL(event.data.asset,self.location.origin);
      if(asset.origin!==self.location.origin||asset.pathname!=='/app.js')throw Error('invalid asset');
      const script=await fetch(asset.href,{credentials:'same-origin',cache:'no-store'});
      if(!script.ok||!/javascript/.test(script.headers.get('content-type')||''))throw Error('script failed');
      await cache.put('/',page);await cache.put(asset.href,script);
      event.ports[0]?.postMessage({ok:true});
    }catch{event.ports[0]?.postMessage({ok:false});}
  })());
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate')event.respondWith((async()=>{
    try {
      const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),4500);
      let response;try {response=await fetch(event.request,{signal:ctrl.signal});}finally{clearTimeout(timer);}
      const cache=await caches.open(CACHE);
      if(response.ok&&response.headers.get('x-book-shell')==='1'&&await cache.match('/')){
        const html=await response.clone().text();const asset=(html.match(/app\.js\?v=[A-Za-z0-9]+/)||[])[0];
        if(asset)event.waitUntil((async()=>{try{const script=await fetch('/'+asset,{credentials:'same-origin'});if(script.ok){await cache.put('/'+asset,script);await cache.put('/',response.clone());}}catch{}})());
      }
      return response;
    }catch{return await caches.match('/')||new Response('请联网登录后，在设置中启用离线访问。',{headers:{'content-type':'text/plain; charset=utf-8'}});}
  })());
  else if(url.pathname==='/app.js')event.respondWith(fetch(event.request).catch(async()=>await caches.match(event.request)||Response.error()));
});
