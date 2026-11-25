import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {home,personalCall} from './control.mjs';
import {Queue} from './queue.mjs';
import {ContextReceiver} from './context-receive.mjs';

process.umask(0o077);
const read=file=>fs.readFileSync(path.join(home,file));
const config=JSON.parse(read('broker.json'));
const localDeviceId=config.localDeviceId||'hub';
const queue=new Queue(path.join(home,'tasks.sqlite'),localDeviceId);
for(const {principal,...registration} of config.provisionedWorkers??[])queue.registry.provision(principal,registration);
if(config.projectAliases!==undefined)queue.registry.setProjectAliases(config.projectAliases);
const contexts=new ContextReceiver(home);
function handle(remote) {
  return async (req,res)=>{
    try {
      if (req.method!=='POST') throw Error('POST required');
      let principal='local';
      if (remote) {
        const cn=req.socket.getPeerCertificate().subject?.CN;
        if(!req.socket.authorized || typeof cn!=='string')throw Error('Invalid worker certificate');
        principal='cert:'+cn;
      }
      let size=0; const chunks=[];
      for await (const chunk of req) {
        size+=chunk.length;
        if(size>(req.url==='/contexts/plan'?3500000:req.url==='/worker/finish'?2400000:700000)) throw Error('Request too large');
        chunks.push(chunk);
      }
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      const target=body.target;
      let value;
      if (req.url.startsWith('/contexts/')) {
        const machine=queue.registry.authorizeDevice(principal,body.deviceId??queue.registry.deviceFor(principal));
        const connectors=queue.registry.list().filter(r=>r.deviceId===machine&&r.contextSources.length);
        const workRoute=['/contexts/catchUp','/contexts/redeem','/contexts/desktopCursors','/contexts/desktopPage','/contexts/updates','/contexts/ack'].includes(req.url);
        const source=target?connectors.find(r=>r.target===target):workRoute?connectors.find(r=>r.contextSources.includes('Codex Desktop')):connectors[0];
        if(!source)throw Error('No context connector registered for this identity');
        const scope={target:source.target,sources:source.contextSources};
        switch(req.url){
          case '/contexts/desktopCursors':
          case '/contexts/desktopPage':
          case '/contexts/redeem':
          case '/contexts/catchUp':
          case '/contexts/updates':
          case '/contexts/ack': {
            if(!source.contextSources.includes('Codex Desktop'))throw Error('Connector does not own desktop sessions');
            value=await personalCall(req.url,{machine,target:source.target,threadId:body.threadId,deliveryId:body.deliveryId,ticket:body.ticket,after:body.after,through:body.through,evidence:body.evidence});
            break;
          }
          case '/contexts/plan': value=contexts.plan(machine,body,scope);break;
          case '/contexts/put': value=contexts.put(machine,body,scope);break;
          case '/contexts/commit': value=contexts.commit(machine,body,scope);break;
          default: throw Error('Unknown context operation');
        }
      } else if(req.url==='/worker/register'){
        if(body.registration){
          if(target!==body.registration.target)throw Error('Mismatched registration target');
          value=queue.registry.register(principal,body.registration);
        }else{
          queue.registry.authorizeTarget(principal,target);
          value=queue.registry.get(target);
        }
      } else if (req.url.startsWith('/worker/')) {
        queue.registry.authorizeTarget(principal,target);
        switch(req.url) {
          case '/worker/inventory': value=queue.registry.recordHardware(principal,target,body.observation);break;
          case '/worker/claim': value=queue.claim(target);break;
          case '/worker/input': value=queue.input(target,body.id);break;
          case '/worker/heartbeat': value=queue.beat(target,body.id,body.status,body.progress);break;
          case '/worker/finish': value=queue.finish(target,body);break;
          default: throw Error('Unknown worker operation');
        }
      } else if (!remote) {
        switch(req.url) {
          case '/submit': value=queue.submit(body);break;
          case '/get': value=queue.get(body.id);break;
          case '/getByRequestId': value=queue.getByRequestId(body.requestId);break;
          case '/cancelByRequestId': value=queue.cancelByRequestId(body.requestId);break;
          case '/cancel': value=queue.cancel(body.id);break;
          case '/list': value=queue.list();break;
          case '/workers': value=queue.workers();break;
          default: throw Error('Unknown operation');
        }
      } else throw Error('Worker endpoint only');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({value}));
    } catch (err) {
      res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:err.message}));
    }
  };
}
const socket=path.join(home,'control.sock');
// Run one broker per state directory.
fs.rmSync(socket,{force:true});
const local=http.createServer(handle(false));
local.listen(socket,()=>fs.chmodSync(socket,0o600));
if(config.port != null || config.bind != null){
  if(!Number.isInteger(config.port) || config.port<1 || config.port>65535 || !config.bind)throw Error('Set both bind and port for the mTLS listener');
  const lan=https.createServer({
    key:read('pki/router.key'),cert:read('pki/router.crt'),ca:read('pki/ca.crt'),
    requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',
    headersTimeout:8000,requestTimeout:12000
  },handle(true));
  lan.listen(config.port,config.bind);
}
