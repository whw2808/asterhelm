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
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [action,option,...words]=process.argv.slice(2);
  const args=action==='submit'?{target:option,prompt:words.join(' ')}:{id:option};
  try{console.log(JSON.stringify(await call('/'+action,args),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
