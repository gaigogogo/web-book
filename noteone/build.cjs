const fs=require('fs');
const source=fs.readFileSync('worker-source.js','utf8');
const assets={'/':fs.readFileSync('public/index.html','utf8'),'/index.html':fs.readFileSync('public/index.html','utf8'),'/app.js':fs.readFileSync('public/app.js','utf8')};
for(const name of ['manifest.webmanifest','sw.js'])assets['/'+name]=fs.readFileSync('public/'+name,'utf8');
const pwaIcon=fs.readFileSync('public/pwa-icon.png').toString('base64');
const adapter=`
const EMBEDDED_ASSETS = ${JSON.stringify(assets)};
const PWA_ICON = ${JSON.stringify(pwaIcon)};
export async function onRequest(context) {
  const store = getStore({ name: 'bookmarks', consistency: 'strong' });
  const binding = {get: (key, type) => store.get(key, {type: type || 'text', consistency: 'strong'}), put: (key, value) => store.set(key, value), delete: (key) => store.delete(key)};
  const env = {...(context.env || {}), BOOKMARKS: binding, ASSETS: {fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if(path==='/pwa-icon.png')return new Response(Uint8Array.from(atob(PWA_ICON),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}});
    const body = EMBEDDED_ASSETS[path === '/' || path.startsWith('/k/') ? '/' : path];
    if(body === undefined) return new Response('Not found', {status:404});
    const ct=path.endsWith('.js')?'application/javascript; charset=utf-8':path.endsWith('.webmanifest')?'application/manifest+json':'text/html; charset=utf-8';
    return new Response(request.method === 'HEAD' ? null : body, {headers:{'content-type':ct,...(path==='/'||path==='/index.html'?{'x-book-shell':'1'}:{})}});
  }}};
  try {return await worker.fetch(context.request, env, context);} catch {return json({error:'服务暂时不可用，请稍后重试'},503,{'cache-control':'no-store'});}
}
`;
fs.writeFileSync('edge-functions/[[default]].js','import { getStore } from "@edgeone/pages-blob";\n'+source+adapter);
fs.writeFileSync('edge-functions/index.js','export { onRequest } from "./[[default]].js";\n');
console.log('Built EdgeOne functions; frontend access gate preserved');

fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<!doctype html><title>Book Hub</title>Service starting');
