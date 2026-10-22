const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('worker-source.js','utf8');
let requests=[],mode='ok';
const mockFetch=async(url,options={})=>{
 requests.push({url:String(url),method:options.method||'GET'});
 if(String(url).startsWith('https://dns.google/'))return new Response(JSON.stringify({Status:0,Answer:[{type:1,data:mode==='private'?'127.0.0.1':'93.184.216.34'}]}));
 if(mode==='redirect')return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
 return new Response(mode==='ok'?'<html><title>Example &amp; 中文</title></html>':'missing',{status:mode==='broken'?404:mode==='blocked'?403:200,headers:{'content-type':'text/html'}});
};
const c={Response,Request,Headers,URL,crypto:globalThis.crypto,TextEncoder,TextDecoder,btoa,atob,setTimeout,clearTimeout,AbortController,fetch:mockFetch};vm.createContext(c);vm.runInContext(source+'\nglobalThis.testWorker=worker;',c);
const keys={'data/password.json':JSON.stringify({password:'test-only-password'}),'data/access.json':JSON.stringify({gate:true,key:'a'.repeat(48)}),'data/bookmarks.json':JSON.stringify([{id:'test',url:'https://example.org',note:'old'}])};
const env={BOOKMARKS:{get:async(k)=>keys[k]?JSON.parse(keys[k]):null,put:async(k,v)=>{keys[k]=v;},delete:async(k)=>delete keys[k]},ASSETS:{fetch:async()=>new Response('asset')}};
async function api(path,method='GET',body,token){return c.testWorker.fetch(new Request('https://book.test/api/'+path,{method,headers:token?{Authorization:'Bearer '+token}:{},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil(){}});}
(async()=>{
 assert.equal((await api('url-metadata','POST',{url:'https://example.org'})).status,401);
 const login=await api('login','POST',{password:'test-only-password'});const token=(await login.json()).token;
 let r=await api('url-metadata','POST',{url:'https://example.org'},token);assert.equal((await r.json()).title,'Example & 中文');
 for(const state of ['broken','blocked','private','redirect']){mode=state;requests=[];r=await api('check-links','POST',{ids:['test']},token);const j=await r.json();assert.equal(j.results[0].status,state==='broken'?'broken':'unknown');if(state==='private')assert(!requests.some(x=>x.url==='https://example.org/'));assert(!requests.some(x=>x.url.includes('127.0.0.1/private')));}
 assert(JSON.parse(keys['data/bookmarks.json'])[0].link_checked_at);
 mode='ok';requests=[];keys['data/bookmarks.json']=JSON.stringify(Array.from({length:9},(_,i)=>({id:'batch'+i,url:'https://example.org/'+i})));
 r=await api('check-links','POST',{ids:Array.from({length:9},(_,i)=>'batch'+i)},token);assert.equal((await r.json()).results.length,8);assert.equal(requests.filter(x=>x.url.startsWith('https://dns.google/')).length,2);
 keys['data/bookmarks.json']=JSON.stringify([{id:'test',url:'https://example.org',note:'old'}]);
 r=await api('bookmarks/test','PUT',{note:null},token);assert.equal((await r.json()).note,null);
 for(const p of ['/sw.js','/manifest.webmanifest','/pwa-icon.png'])assert.equal((await c.testWorker.fetch(new Request('https://book.test'+p),env)).status,200);
 console.log('PASS: metadata title, authorization, private/redirect rejection, status classification, persisted results, clear note, public PWA assets');
})().catch(e=>{console.error(e);process.exitCode=1});
