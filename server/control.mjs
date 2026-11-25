import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const home=process.env.ASTERHELM_HOME||process.env.SUPER_AGENT_HOME||path.join(os.homedir(),'.asterhelm');
export function call(route,data={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:path.join(home,'control.sock'),path:route,method:'POST',timeout:8000},res=>{
      let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>{
        try {const body=JSON.parse(text);if(body.error)throw Error(body.error);resolve(body.value);} catch(e){reject(e);}
      });res.on('error',reject);
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Router timeout')));req.end(JSON.stringify(data));
  });
}
export function personalCall(route, input, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      method: 'POST', path: route, socketPath: path.join(home, 'personal.sock'), signal, timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (body.error || response.statusCode >= 400) throw Error(body.error || '个人助手暂时无法响应。');
        resolve(body.value);
      } catch (error) { reject(error); }
    });
    request.on('timeout', () => request.destroy(Error('个人助手响应超时，请稍后重试。')));
    request.on('error', reject);
    request.end(JSON.stringify(input));
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [action,option,...words]=process.argv.slice(2);
  const args=action==='submit'?{target:option,prompt:words.join(' ')}:{id:option};
  try{console.log(JSON.stringify(await call('/'+action,args),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
