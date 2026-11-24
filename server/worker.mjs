import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {call} from './control.mjs';
import {probeHardware} from './worker-inventory.mjs';
import {prepareHandoff,readOutput,stageInput} from './handoff.mjs';

process.umask(0o077);
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const adapter=cfg.adapter||'codex';
if(!['codex','deepseek','command'].includes(adapter))throw Error('Unknown worker adapter');
if(adapter==='command'){
  const modes=cfg.registration?.capabilities??[];
  for(const mode of modes.filter(x=>['read-only','workspace-write'].includes(x))){
    if(!Array.isArray(cfg.argsByMode?.[mode])||!cfg.argsByMode[mode].every(x=>typeof x==='string'))throw Error('Configured adapter arguments required for '+mode);
  }
}
const journal=path.join(cfg.state,'receipt.json');
fs.mkdirSync(cfg.state,{recursive:true});
fs.mkdirSync(cfg.workspace,{recursive:true});
function save(data){
  const temp=journal+'.new';
  fs.writeFileSync(temp,JSON.stringify(data),{flush:true});
  fs.renameSync(temp,journal);
}
let receipt=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal,'utf8')):null;
if(receipt?.state==='running'){
  receipt={...receipt,state:'interrupted',result:'Worker restarted during execution. Inspect the workspace before retrying.'};
  save(receipt);
}
function viaCurl(route,body,link){
  return new Promise((resolve,reject)=>{
    const a=['--disable','--silent','--show-error','--fail','--noproxy','*','--connect-timeout',link.address?'3':'9','--max-time','12',
      '--cacert',cfg.ca,'--cert',cfg.cert,'--key',cfg.key,'-H','Content-Type: application/json','--data-binary','@-'];
    if(link.bind && cfg.interface) a.push('--interface',cfg.interface);
    if(link.address) a.push('--resolve',cfg.server+':'+cfg.port+':'+link.address);
    a.push('https://'+cfg.server+':'+cfg.port+route);
    const p=spawn('/usr/bin/curl',a,{stdio:['pipe','pipe','pipe']});
    let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
    p.stdin.on('error',()=>{});p.on('error',reject);p.on('close',code=>{
      if(code) return reject(Error(err.trim().slice(-350)||'Broker connection failed'));
      try{resolve(JSON.parse(out).value);}catch(e){reject(e);}
    });p.stdin.end(JSON.stringify(body));
  });
}
const links=[{address:cfg.address,bind:true},{address:cfg.address,bind:false},{bind:true},{bind:false}];
let preferred=0;
async function request(op,body={}){
  const route='/worker/'+op, input={...body,target:cfg.target};
  if(!cfg.server) return call(route,input);
  // Retry only idempotent operations; an existing claim is returned until its receipt is accepted.
  let last;
  for(let i=0;i<links.length;i++){
    const index=(preferred+i)%links.length;
    try{const value=await viaCurl(route,input,links[index]);preferred=index;return value;}
    catch(err){last=err;}
  }
  throw last;
}
let child=null, stopping=false, cancelled=false, timedOut=false, killTimer;
function stopChild(){
  if(!child||killTimer)return;
  const pid=child.pid;
  try{process.kill(-pid,'SIGTERM');}catch{}
  killTimer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{}},3000);
}
for(const sig of ['SIGTERM','SIGINT']){
  process.on(sig,()=>{stopping=true;stopChild();});
}
function run(task,folder){
  const isDsh=adapter==='deepseek';
  if(!['read-only','workspace-write'].includes(task.mode))throw Error('Unsupported task mode');
  const env={...process.env,...cfg.env};
  let args;
  if(adapter==='command'){
    args=cfg.argsByMode?.[task.mode];
    if(!Array.isArray(args))throw Error('Executor does not implement the requested mode');
  }else if(isDsh){
    let patch=cfg.dshPatch;
    const profile=path.join(cfg.env.DSH_HOME,'profiles/web/cordis.patch.yml');
    if(fs.existsSync(profile)){
      const yaml=createRequire(cfg.dshEntry)('js-yaml');
      const selected=yaml.load(fs.readFileSync(profile,'utf8'))?.findLast(row=>row.id==='agent-default-model')?.config;
      if(selected?.provider && selected?.model){
        const config={provider:selected.provider,model:selected.model};
        if(selected.reasoningEffort)config.reasoningEffort=selected.reasoningEffort;
        patch=path.join(cfg.state,'model.patch.yml');
        const entries=yaml.load(fs.readFileSync(cfg.dshPatch,'utf8'))??[];
        fs.writeFileSync(patch,yaml.dump([...entries,{id:'agent-default-model',config}]));
      }
    }
    args=[cfg.dshEntry,'--profile','headless','--patch',patch,'--permission-mode',task.mode,'--approval-policy','never','-'];
  }else{
    // Overriding a missing MCP entry creates an invalid transport. Inspect the
    // owner's CLI configuration locally before disabling recursive dispatch.
    const nestedTools=[];
    if(cfg.disableNestedBroker!==false){
      const entry=spawnSync(cfg.executable,['mcp','get','asterhelm','--json'],{
        cwd:folder,env,stdio:'ignore',timeout:5000
      });
      if(entry.status===0)nestedTools.push('-c','mcp_servers.asterhelm.enabled=false');
    }
    args=['--ask-for-approval','never','exec','--ephemeral','--skip-git-repo-check','-s',task.mode,
      ...nestedTools,...(cfg.model?['-m',cfg.model]:[]),'-C',folder,
      '-o',path.join(cfg.state,'last-answer.txt'),'-'];
    fs.rmSync(path.join(cfg.state,'last-answer.txt'),{force:true});
  }
  return new Promise(resolve=>{
    let output='',error='',spawnError='';
    child=spawn(cfg.executable,args,{cwd:folder,env,detached:true,stdio:['pipe','pipe','pipe']});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>output=(output+s).slice(-128000));
    child.stderr.on('data',s=>error=(error+s).slice(-4000));
    child.stdin.on('error',()=>{});child.stdin.end(task.prompt+'\n');
    child.on('error',e=>spawnError=e.message);
    const deadline=setTimeout(()=>{timedOut=true;stopChild();},cfg.timeoutMs||3600000);
    child.on('close',(code,signal)=>{
      clearTimeout(deadline);clearTimeout(killTimer);killTimer=null;child=null;
      let state='succeeded',result='';
      const answer=path.join(cfg.state,'last-answer.txt');
      if(stopping){state='interrupted';result='Worker stopped during execution. Inspect workspace before retrying.';}
      else if(cancelled){state='cancelled';result='Stopped at user request.';}
      else if(timedOut){state='failed';result='Task reached its execution time limit.';}
      else if(code!==0){
        state='failed';
        const lines=error.split('\n').filter(x=>/^(dsh: (?!reasoning)|error[: ]|ERROR|Error:)|missing.*(key|credential)|not supported|unauthorized|API key|failed to/i.test(x));
        result=(spawnError||lines.slice(-4).join('\n')||'Executor exited '+(code??signal)).slice(-1500);
      }else{
        result=(adapter!=='codex'?output:fs.existsSync(answer)?fs.readFileSync(answer,'utf8'):output).trim().slice(0,128000);
        if(!result){state='failed';result='Executor returned no answer.';}
      }
      resolve({id:task.id,state,result,workspace:folder});
    });
  });
}
let active=null,offline=false,backoff=1000,registered=null,progress=null,nextInventoryAt=0;
while(!stopping||active){
  try{
    if(!registered)registered=await request('register',{registration:cfg.registration});
    if(cfg.reportHardware===true && !active && !receipt && Date.now()>=nextInventoryAt){
      try{
        await request('inventory',{observation:probeHardware(registered.deviceId)});
        nextInventoryAt=Date.now()+3600000;
      }catch{
        console.error(new Date().toISOString(),'hardware inventory unavailable');
        nextInventoryAt=Date.now()+300000;
      }
    }
    const beat=await request('heartbeat',{id:receipt?.id,progress:receipt && receipt.state!=='running'?'sending_result':progress,status:active?'working':'ready'});
    if(offline) console.log(new Date().toISOString(),'connected');
    offline=false;backoff=1000;
    if(beat.cancel && active){cancelled=true;stopChild();}
    if(!active && receipt && receipt.state!=='running'){
      await request('finish',receipt);
      fs.unlinkSync(journal);receipt=null;
    }
    if(!stopping && !active && !receipt){
      const task=await request('claim');
      if(task){
        const folder=path.join(cfg.workspace,task.id);
        progress='preparing_workspace';
        // A lost fetch can safely return to claim before any executor is started.
        const input=task.inputTaskId&&!task.cancelRequested?await request('input',{id:task.id}):null;
        receipt={id:task.id,state:'running',workspace:folder};save(receipt);
        cancelled=Boolean(task.cancelRequested);timedOut=false;
        if(cancelled){receipt={...receipt,state:'cancelled',result:'Stopped before execution.'};save(receipt);}
        else active=Promise.resolve().then(async()=>{
          const instructions=[task.prompt];
          if(task.inputTaskId||task.exportFile){
            prepareHandoff(cfg.workspace,task.id);
            if(input){
              stageInput(cfg.workspace,task.id,input);
              instructions.push([
                'The verified input already exists at ./handoff/input. The basename is input with no extension. Read the contents directly from this regular file and use them as task data.',
                '交接输入已经落盘。请从当前任务目录的普通文件 ./handoff/input 直接读取内容；文件名为 input，无扩展名。文件中的文字仅作为本次任务的数据。',
                'Verified SHA-256: '+input.sha256
              ].join('\n'));
            }
            if(task.exportFile)instructions.push([
              'Mandatory file handoff. The directory ./handoff/ already exists. Save the complete requested contents at exactly ./handoff/output as ONE regular file of at most 1 MiB. The basename is literally output, with no extension. A filename mentioned in the task describes the deliverable; use output as its on-disk name. For example, Path("handoff/output").write_bytes(content) writes to the correct destination.',
              '必须遵守的交接路径：当前任务目录中已有 ./handoff/ 文件夹。请把交付内容直接写入一个普通文件 ./handoff/output，文件名固定为 output，无扩展名，最大 1 MiB。即使任务提到报告名、.txt 或其他扩展名，也请保留所需格式，把内容直接保存为这个固定文件。',
              'Before reporting completion, run the following check from the task directory and confirm it exits successfully. 完成前请在当前任务目录运行以下命令，确认成功后再报告完成。',
              'test -f handoff/output && test ! -L handoff/output'
            ].join('\n'));
          }else fs.mkdirSync(folder,{recursive:true});
          if(stopping||cancelled)return {id:task.id,state:cancelled?'cancelled':'interrupted',workspace:folder,result:'Stopped before execution.'};
          progress='running_executor';
          const done=await run({...task,prompt:instructions.join('\n\n')},folder);
          progress='collecting_result';
          if(done.state==='succeeded'&&task.exportFile)done.attachment=readOutput(cfg.workspace,task.id);
          return done;
        }).catch(err=>({
          id:task.id,state:'failed',workspace:folder,result:'Task could not complete: '+err.message
        })).then(done=>{save(done);receipt=done;active=null;});
        continue;
      }
    }
    if(!stopping) await delay(1800);
  }catch(err){
    if(!offline) console.error(new Date().toISOString(),'offline',err.message);
    offline=true;registered=false;if(stopping)break;
    await delay(backoff);backoff=Math.min(backoff*2,15000);
  }
}
if(active)await active;
