import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const limit=1024*1024;
const helper=fileURLToPath(new URL('./handoff-fs.py',import.meta.url));
export function decodeAttachment(packet){
  if(typeof packet?.data!=='string'||!Number.isInteger(packet.size)||packet.size<0||packet.size>limit||
      !/^[a-f0-9]{64}$/.test(packet.sha256)||packet.data.length!==Math.ceil(packet.size/3)*4){
    throw Error('Invalid handoff size or metadata');
  }
  const bytes=Buffer.from(packet.data,'base64');
  if(bytes.length!==packet.size||bytes.toString('base64')!==packet.data||createHash('sha256').update(bytes).digest('hex')!==packet.sha256){
    throw Error('Handoff content failed verification');
  }
  return bytes;
}
function command(action,workspace,id,packet){
  const result=spawnSync('python3',['-I',helper,action,workspace,id],{
    input:packet?JSON.stringify(packet):undefined,encoding:'utf8',maxBuffer:2*1024*1024,timeout:15000
  });
  if(result.status!==0)throw Error('Handoff failed: verify the fixed file path, size and SHA-256.');
  return result.stdout;
}
export function prepareHandoff(workspace,id){command('prepare',workspace,id);}
export function readOutput(workspace,id){return JSON.parse(command('read',workspace,id));}
export function stageInput(workspace,id,packet){decodeAttachment(packet);command('stage',workspace,id,packet);}
