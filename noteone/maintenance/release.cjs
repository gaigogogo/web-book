const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),repo='gaigogogo/web-book',args=process.argv.slice(2);
const publishOnly=args.includes('--publish-only');
const current=JSON.parse(fs.readFileSync(path.join(root,'version.json'),'utf8')).version;
const m=current.match(/^v(\d+)\.(\d+)/);if(!m)throw Error('Cannot read current version');
const option=args.indexOf('--version');const number=publishOnly?m[1]+'.'+m[2]:option>=0?args[option+1]:m[1]+'.'+(Number(m[2])+1);
if(!/^\d+\.\d+$/.test(number))throw Error('Use major.minor version');
const tag='v'+number+'-noteone',releaseUrl='https://github.com/'+repo+'/releases/tag/'+tag;
let notes=fs.readFileSync(path.join(root,'RELEASE_NOTES.md'),'utf8').replace(/^# .*/,'# '+tag+' · '+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()));
function run(file,params=[]){cp.execFileSync(process.execPath,[file,...params],{cwd:root,stdio:'inherit',env:{...process.env,PAGES_SOURCE:'skills'}});}
function deploy(){
 const token=fs.readFileSync('D:/codex/api/edge api.txt','utf8').trim();
 const result=cp.spawnSync(process.execPath,['D:/codex/tools/edgeone/node_modules/edgeone/edgeone-bin/edgeone.js','makers','deploy','-n','book-hub','-a','overseas','--skip-ai-gateway-sync','--json'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,PAGES_SOURCE:'skills',EDGEONE_PAGES_API_TOKEN:token,EDGEONE_PAGES_API_REGION:'global'}});
 const log=((result.stdout||'')+(result.stderr||'')).split(token).join('[REDACTED]');process.stdout.write(log);fs.writeFileSync(path.join(root,'deploy-output.log'),log);
 if(result.error||result.status!==0)throw Error(result.error?.message||'Deployment failed');
}
function replace(file,fn){const p=path.join(root,file);fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8')));}
async function main(){
 if(!publishOnly){
  fs.writeFileSync(path.join(root,'RELEASE_NOTES.md'),notes);
  for(const f of ['public/app.js','worker-source.js'])replace(f,t=>t.replace(/const APP_VERSION = "[^"]+"/,'const APP_VERSION = "'+tag+'"').replaceAll('jeffak000/webbook-cf',repo).replaceAll('gaigogogo/webbook-cf',repo));
  replace('public/index.html',t=>t.replace(/(<span id="siteVer">)[^<]+/,'$1'+tag.replace(/-noteone$/, ' · EdgeOne')).replaceAll('jeffak000/webbook-cf',repo).replaceAll('gaigogogo/webbook-cf',repo));
  for(const f of ['package.json','package-lock.json']){const p=path.join(root,f),j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=number+'.0';if(j.packages?.[''])j.packages[''].version=number+'.0';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');}
  fs.writeFileSync(path.join(root,'version.json'),JSON.stringify({version:tag,url:releaseUrl,notes:'腾讯云'+number+'更新：'+notes.split('\n').filter(line=>line.startsWith('- ')).slice(0,3).map(line=>line.slice(2)).join('；')},null,2)+'\n');
  fs.writeFileSync(path.join(root,'README.md'),fs.readFileSync(path.join(root,'ROOT_README.md'),'utf8').replaceAll('{{VERSION}}',number).replaceAll('{{TAG}}',tag));
  for(const file of ['public/app.js','worker-source.js','public/sw.js'])run('--check',[file]);
  for(const test of ['test-link-speed.cjs','test-new-tools.cjs','test-book-cache.cjs','test-offline.cjs'])run('maintenance/'+test);
  run('bump.cjs');run('build.cjs');deploy();
 }
 // 等候正式入口传播；未确认部署就不发布。
 let live=false;for(let i=0;i<8;i++){const r=await fetch('https://book.090803.xyz/api/version?release='+Date.now(),{signal:AbortSignal.timeout(15000)});if(r.ok&&(await r.json()).version===tag){live=true;break;}await new Promise(resolve=>setTimeout(resolve,3000));}if(!live)throw Error('Live version not verified: '+tag);
 const token=fs.readFileSync('D:/api/GitHubAPI.md','utf8').match(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/)?.[0];if(!token)throw Error('GitHub credential not found');
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json'};
 async function gh(p,method='GET',body){const r=await fetch('https://api.github.com/repos/'+repo+p,{method,headers:{...headers,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});const j=await r.json();if(!r.ok)throw Error('GitHub '+r.status+' '+j.message);return j;}
 const meta=await gh(''),ref=await gh('/git/ref/heads/'+meta.default_branch),parent=await gh('/git/commits/'+ref.object.sha);
 const files=['public/app.js','public/index.html','public/manifest.webmanifest','public/sw.js','worker-source.js','build.cjs','bump.cjs','package.json','package-lock.json','edgeone.json','version.json','README.md','ROOT_README.md','AGENTS.md','RELEASE_NOTES.md','edge-functions/[[default]].js','edge-functions/index.js','maintenance/release.cjs','maintenance/deploy-edgeone.cjs','maintenance/test-link-speed.cjs','maintenance/test-new-tools.cjs','maintenance/test-book-cache.cjs','maintenance/test-offline.cjs'];
 const icon=await gh('/git/blobs','POST',{content:fs.readFileSync(path.join(root,'public/pwa-icon.png')).toString('base64'),encoding:'base64'});
 let readme=fs.readFileSync(path.join(root,'ROOT_README.md'),'utf8').replaceAll('{{VERSION}}',number).replaceAll('{{TAG}}',tag);
 const tree=await gh('/git/trees','POST',{base_tree:parent.tree.sha,tree:[...files.map(p=>({path:p.startsWith('.github/')?p:'noteone/'+p,mode:'100644',type:'blob',content:fs.readFileSync(path.join(root,p),'utf8')})),{path:'noteone/public/pwa-icon.png',mode:'100644',type:'blob',sha:icon.sha},{path:'README.md',mode:'100644',type:'blob',content:readme}]});
 const commit=await gh('/git/commits','POST',{message:'release '+tag+': update noteone source and release notes',tree:tree.sha,parents:[parent.sha]});await gh('/git/refs/heads/'+meta.default_branch,'PATCH',{sha:commit.sha});console.log('Published source '+commit.html_url);
 const releases=await gh('/releases');let release=releases.find(r=>r.tag_name===tag);
 release=release?await gh('/releases/'+release.id,'PATCH',{body:notes}):await gh('/releases','POST',{tag_name:tag,target_commitish:commit.sha,name:tag+' · 腾讯云版更新',body:notes,draft:false,prerelease:false,make_latest:'true'});
 const releasesDir='D:/codex/releases';fs.mkdirSync(releasesDir,{recursive:true});const stage=fs.mkdtempSync(path.join(releasesDir,'web-book-'+number+'-'));
 for(const file of [...files,'public/pwa-icon.png']){const target=path.join(stage,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);}
 const zip=path.join(releasesDir,'web-book-noteone-v'+number+'.zip');
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 cp.execFileSync('powershell',['-NoProfile','-Command','Compress-Archive -Path '+quote(stage+'/*')+' -DestinationPath '+quote(zip)+' -Force'],{stdio:'pipe'});
 if(!release.assets.some(a=>a.name===path.basename(zip))){const r=await fetch(release.upload_url.split('{')[0]+'?name='+path.basename(zip),{method:'POST',headers:{...headers,'Content-Type':'application/zip'},body:fs.readFileSync(zip),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('ZIP upload '+r.status);}
 const url='https://www.090803.xyz/api/feed/10';const old=await(await fetch(url)).json();if(typeof old.content!=='string')throw Error('Blog read failed');fs.writeFileSync(path.join(releasesDir,'blog-feed10-before-'+tag+'.json'),JSON.stringify(old));
 let content=old.content.replaceAll('jeffak000/webbook-cf',repo).replaceAll('gaigogogo/webbook-cf',repo);const marker='<!-- release:'+tag+' -->';const section=marker+'\n'+notes+'\n\n[下载 '+tag+']('+releaseUrl+')\n<!-- /release:'+tag+' -->';
 if(content.includes(marker)){const end='<!-- /release:'+tag+' -->',start=content.indexOf(marker),finish=content.indexOf(end,start);if(finish<0)throw Error('Blog release marker mismatch');content=content.slice(0,start)+section+content.slice(finish+end.length);}else content+='\n\n'+section;
 let session=JSON.parse(fs.readFileSync('D:/codex/api/blog-edgeone-session.json'));
 const body={title:old.title,content,summary:old.summary,tags:(old.hashtags||[]).map(t=>t.name),draft:!!old.draft,listed:!!old.listed,top:old.top};
 async function write(){return fetch(url,{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});}
 let r=await write();if([401,403].includes(r.status)){const text=fs.readFileSync('D:/codex/projects/blog-edgeone/.env','utf8');function env(name){const line=text.split(/\r?\n/).find(l=>l.startsWith(name+'='));if(!line)throw Error('Blog login config missing');let value=line.slice(name.length+1);if(value.startsWith('"'))value=JSON.parse(value);else if(value.startsWith("'"))value=value.slice(1,-1);return value;}const login=await fetch('https://www.090803.xyz/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env('ADMIN_USERNAME'),password:env('ADMIN_PASSWORD')})});if(!login.ok)throw Error('Blog login '+login.status);session.token=(await login.json()).token;fs.writeFileSync('D:/codex/api/blog-edgeone-session.json',JSON.stringify(session));r=await write();}if(!r.ok)throw Error('Blog write '+r.status);
 if(!(await(await fetch(url)).json()).content.includes(marker))throw Error('Blog verification failed');
 const verified=await gh('/releases/tags/'+tag);if(!verified.assets.some(a=>a.name===path.basename(zip)))throw Error('ZIP verification failed');
 console.log('Verified '+releaseUrl+' and https://www.090803.xyz/feed/10');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

