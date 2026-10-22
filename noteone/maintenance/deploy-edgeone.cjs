const fs=require('fs'),cp=require('child_process');
const token=fs.readFileSync('D:/codex/api/edge api.txt','utf8').trim();
const args=['D:/codex/tools/edgeone/node_modules/edgeone/edgeone-bin/edgeone.js','makers','deploy','-n','book-hub','-a','overseas','--skip-ai-gateway-sync','--json'];
const child=cp.spawn(process.execPath,args,{cwd:'D:/codex/projects/book-edgeone',env:{...process.env,EDGEONE_PAGES_API_TOKEN:token,EDGEONE_PAGES_API_REGION:'global'},stdio:['ignore','pipe','pipe']});
let log='';
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{const text=b.toString().split(token).join('[REDACTED]');log+=text;process.stdout.write(text)});
child.on('exit',code=>{fs.writeFileSync('D:/codex/projects/book-edgeone/deploy-output.log',log);process.exitCode=code||0});
