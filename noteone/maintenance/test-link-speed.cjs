const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync('public/app.js','utf8');const part=src.slice(src.indexOf('let linkCheckRunning='),src.indexOf('el("bookmarklet").href'));
const nodes={};let batches=[],failure=true,pause=false;
const remote=Array.from({length:20},(_,i)=>({id:String(i),url:'https://example.com/'+i,...(i<4?{link_status:'ok',link_checked_at:Date.now()}: {})}));
const c={Date,Array,Error,BMS:structuredClone(remote),TOKEN:'test',pendingSave:false,pendingMove:false,mutationEpoch:0,el:id=>nodes[id]||(nodes[id]={}),needAuth:async()=>{},toast(){},persistCurrentData(){},render(){},callApi:async(p,opts)=>{
 if(p==='/bookmarks')return {ok:true,json:async()=>remote};
 const ids=JSON.parse(opts.body).ids;batches.push(ids);
 if(failure){failure=false;throw Error('temporary network');}
 if(pause)vm.runInContext('stopLinkCheck=true',c);
 return {ok:true,json:async()=>({results:ids.map(id=>({id,url:'https://example.com/'+id,status:'ok',http_status:200,checked_at:Date.now()}))})};
}};vm.createContext(c);vm.runInContext(part,c);
(async()=>{
 await c.checkLinks(false);assert.equal(batches.length,3);assert.equal(batches[0].length,8);assert(!batches.flat().includes('0'));assert(c.BMS.every(b=>b.link_checked_at));assert(nodes.linkCheckInfo.textContent.includes('16 / 16'));assert.equal(c.pendingSave,false);
 batches=[];pause=true;await c.checkLinks(true);assert.equal(batches.length,1);assert(nodes.linkCheckInfo.textContent.includes('已暂停'));assert.equal(nodes.btnCheckLinks.disabled,false);
 assert(c.linkCheckDue({link_status:'unknown',link_checked_at:Date.now()-3600001}));assert(!c.linkCheckDue({link_status:'ok',link_checked_at:Date.now()-3600001}));
 console.log('PASS: resume skips recent results, 8-item batches, one retry, pause after batch, pending state restored, result expiry');
})().catch(e=>{console.error(e);process.exitCode=1});
