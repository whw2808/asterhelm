import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {scanDesktop} from './context-desktop.mjs';
import {contextDigest,validRow} from './context-format.mjs';
import {call} from './control.mjs';

export async function syncRows(rows,request){
  if(rows.some(r=>!validRow(r)))throw Error('Desktop schema could not be verified');
  const entries=rows.map(row=>[row.id,contextDigest(row)]);
  const {generation,missing}=await request('plan',{entries});
  const wanted=new Set(missing);let batch=[],bytes=0;
  async function send(){
    await request('put',{generation,rows:batch});batch=[];bytes=0;
  }
  for(const row of rows){
    if(!wanted.has(row.id))continue;
    const size=Buffer.byteLength(JSON.stringify(row))+1;
    if(batch.length && (bytes+size>500000||batch.length>=75))await send();
    batch.push(row);bytes+=size;
  }
  if(batch.length)await send();
  return request('commit',{generation});
}
function remoteRequest(cfg){
  const routes=[{address:cfg.address,bind:true},{address:cfg.address},{bind:true},{}];
  let preferred=0;
  function post(op,payload,route){
    return new Promise((resolve,reject)=>{
      const args=['--disable','--silent','--noproxy','*','--connect-timeout','4','--max-time','12',
        '--cacert',cfg.ca,'--cert',cfg.cert,'--key',cfg.key,'-H','Content-Type: application/json','--data-binary','@-'];
      if(route.bind && cfg.interface)args.push('--interface',cfg.interface);
      if(route.address)args.push('--resolve',cfg.server+':'+cfg.port+':'+route.address);
      args.push('https://'+cfg.server+':'+cfg.port+'/contexts/'+op);
      const child=spawn('/usr/bin/curl',args,{stdio:['pipe','pipe','ignore']});
      let reply='';
      child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{reply+=s;if(reply.length>4000000)child.kill();});
      child.on('error',reject);child.stdin.on('error',()=>{});
      child.on('close',code=>{
        if(code!==0)return reject(Error('Context transport unavailable'));
        try{
          const response=JSON.parse(reply);
          if(!response.value)throw Error('Context receiver rejected refresh');
          resolve(response.value);
        }catch(e){reject(e);}
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
  return async(op,payload)=>{
    for(let i=0;i<routes.length;i++){
      const index=(preferred+i)%routes.length;
      try{const result=await post(op,payload,routes[index]);preferred=index;return result;}
      catch(e){if(e.message!=='Context transport unavailable'||i===routes.length-1)throw e;}
    }
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  const cfg=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):null;
  const transport=cfg?.server?remoteRequest(cfg):(op,body)=>call('/contexts/'+op,body);
  const request=(op,body)=>transport(op,{...body,target:cfg?.target,deviceId:cfg?.registration?.deviceId??cfg?.deviceId});
  const abort=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>abort.abort());
  const codexHome=cfg?.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  let previous='';
  while(!abort.signal.aborted){
    try{
      const result=await syncRows(scanDesktop(codexHome),request);
      const state='synced '+result.count+' interactive Codex chats';
      if(state!==previous){console.log(new Date().toISOString(),state);previous=state;}
    }catch{
      if(previous!=='paused'){console.error(new Date().toISOString(),'Codex context refresh paused');previous='paused';}
    }
    await delay(20000,null,{signal:abort.signal}).catch(()=>{});
  }
}
