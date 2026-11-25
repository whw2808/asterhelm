import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {execFileSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const app=fileURLToPath(new URL('.',import.meta.url));
const fakePlatform=fileURLToPath(new URL('./test-support/synthetic-platform.mjs',import.meta.url));
function testCertificates(dir){
  fs.mkdirSync(dir);
  const key=name=>name+'.key',crt=name=>name+'.crt';
  const openssl=(...args)=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
  fs.writeFileSync(path.join(dir,'ca.cnf'),'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl('req','-sha256','-new','-x509','-days','1','-newkey','rsa:2048','-nodes','-config','ca.cnf','-keyout',key('ca'),'-out',crt('ca'));
  for(const name of ['router','studio','other']){
    openssl('req','-sha256','-new','-nodes','-newkey','rsa:2048','-keyout',key(name),'-out',name+'.csr','-subj','/CN='+name);
    fs.writeFileSync(path.join(dir,'leaf.cfg'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+(name==='router'?'serverAuth\nsubjectAltName=IP:127.0.0.1':'clientAuth')+'\n');
    openssl('x509','-sha256','-req','-days','1','-in',name+'.csr','-CA',crt('ca'),'-CAkey',key('ca'),'-CAcreateserial','-extfile','leaf.cfg','-out',crt(name));
  }
}
function jsonPost(module,options,route,body){
  return new Promise((resolve,reject)=>{
    const req=module.request({...options,path:route,method:'POST',agent:false},res=>{
      let text='';res.setEncoding('utf8');res.on('data',data=>text+=data);
      res.on('end',()=>{const reply=JSON.parse(text);if(reply.error)reject(Error(reply.error));else resolve(reply.value);});
    });
    req.on('error',reject);req.end(JSON.stringify(body));
  });
}
async function eventually(read,accept){
  const deadline=Date.now()+16000;
  let value;
  do{
    try{value=await read();if(accept(value))return value;}catch(e){value=e;}
    await delay(100);
  }while(Date.now()<deadline);
  throw Error('Timed out: '+JSON.stringify(value));
}

test('a CA-issued device joins, runs its configured adapter and cannot cross device boundaries',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'sa-mtls-')),pki=path.join(home,'pki'),children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null && !child.signalCode){
      const stopped=once(child,'close');child.kill('SIGKILL');await stopped;
    }
    fs.rmSync(home,{force:true,recursive:true});
  });
  testCertificates(pki);
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const save=(name,value)=>fs.writeFileSync(path.join(home,name),JSON.stringify(value));
  save('broker.json',{bind:'127.0.0.1',port,localDeviceId:'router'});
  const start=(...args)=>children.push(spawn(process.execPath,args,{env:{...process.env,ASTERHELM_HOME:home},stdio:'ignore'}));
  start(path.join(app,'broker.mjs'));
  const local=(route,body={})=>jsonPost(http,{socketPath:path.join(home,'control.sock')},route,body);
  await eventually(()=>local('/workers'),rows=>rows.length===0);
  const read=name=>fs.readFileSync(path.join(pki,name));
  const remote=(identity,route,body={})=>jsonPost(https,{host:'127.0.0.1',port,ca:read('ca.crt'),...(identity?{cert:read(identity+'.crt'),key:read(identity+'.key')}:{})},route,body);
  const target='studio.caption',registration={deviceId:'studio',deviceName:'Studio',platform:'Linux',target,agentName:'Caption',kind:'caption',
    capabilities:['read-only','contexts'],contextSources:['Codex CLI']};
  await assert.rejects(remote(null,'/worker/register',{target,registration}));
  await assert.rejects(remote('other','/worker/register',{target,registration}),/identity mismatch/i);
  const cfg={target,adapter:'command',reportHardware:true,registration,executable:process.execPath,
    argsByMode:{'read-only':['-e',"process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log('adapter receipt'),2300))"]},
    state:path.join(home,'state'),workspace:path.join(home,'workspaces'),ca:path.join(pki,'ca.crt'),cert:path.join(pki,'studio.crt'),key:path.join(pki,'studio.key'),port,server:'127.0.0.1'};
  save('worker.json',cfg);start('--import',fakePlatform,path.join(app,'worker.mjs'),path.join(home,'worker.json'));
  const [registered]=await eventually(()=>local('/workers'),rows=>rows.length===1 && rows[0].online && rows[0].hardware);
  assert.equal(registered.hardware.subjectDeviceId,'studio');assert.equal(registered.hardware.observedBy,target);
  assert.equal(registered.hardware.platform,'freebsd');assert.equal(registered.hardware.architecture,'test-cpu');
  await assert.rejects(remote('other','/worker/inventory',{target,observation:{subjectDeviceId:'studio'}}),/identity mismatch/i);
  await assert.rejects(remote('studio','/worker/inventory',{target,observation:{subjectDeviceId:'other'}}),/subject does not match/i);
  await assert.rejects(remote('other','/worker/claim',{target}),/identity mismatch/i);
  await assert.rejects(remote('other','/contexts/plan',{deviceId:'studio',entries:[]}),/identity mismatch/i);
  for(const path of ['catchUp','redeem','updates','ack','desktopCursors','desktopPage']){
    await assert.rejects(remote('other','/contexts/'+path,{deviceId:'studio',target}),/identity mismatch/i);
    await assert.rejects(remote('studio','/contexts/'+path,{target}),/does not own desktop sessions/i);
  }
  await assert.rejects(remote('studio','/list'),/worker endpoint only/i);
  const {generation}=await remote('studio','/contexts/plan',{entries:[]});
  assert.equal((await remote('studio','/contexts/commit',{generation})).count,0);
  const task=await local('/submit',{target,prompt:'test the adapter'});
  const get=()=>local('/get',{id:task.id});
  const running=await eventually(get,value=>value.state==='running' && value.progress==='running_executor' && value.lastHeartbeatAt);
  const done=await eventually(get,value=>value.state==='succeeded');
  assert.equal(done.result,'adapter receipt');assert.equal(done.startedAt,running.startedAt);
  assert.ok(done.startedAt<=done.lastHeartbeatAt && done.lastHeartbeatAt<=done.finishedAt);
});

test('an unavailable optional inventory collector leaves the worker available for tasks',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'sa-noprobe-'));
  let inventoryAttempts=0,claimed=false,receipt;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks));let value={};
    if(req.url==='/worker/register')value={deviceId:'temporary'};
    if(req.url==='/worker/inventory'){inventoryAttempts++;res.end(JSON.stringify({error:'collector temporarily unavailable'}));return;}
    if(req.url==='/worker/claim'){
      value=claimed?null:{id:'00000000-0000-4000-8000-000000000005',prompt:'test',mode:'read-only'};claimed=true;
    }
    if(req.url==='/worker/finish')receipt=input;
    res.end(JSON.stringify({value}));
  });
  server.listen(path.join(home,'control.sock'));await once(server,'listening');
  const cfg={target:'temporary.example',reportHardware:true,adapter:'command',argsByMode:{'read-only':['-e',"console.log('done')"]},executable:process.execPath,state:path.join(home,'state'),workspace:path.join(home,'workspaces')};
  const file=path.join(home,'worker.json');fs.writeFileSync(file,JSON.stringify(cfg));
  const child=spawn(process.execPath,['--import',fakePlatform,path.join(app,'worker.mjs'),file],{env:{...process.env,ASTERHELM_HOME:home},stdio:'ignore'});
  t.after(async()=>{
    if(child.exitCode===null&&!child.signalCode){const stopped=once(child,'close');child.kill('SIGKILL');await stopped;}
    await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{force:true,recursive:true});
  });
  await eventually(async()=>receipt,Boolean);
  assert.equal(receipt.state,'succeeded');assert.equal(inventoryAttempts,1);
});
