import os from 'node:os';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

function gpuProbe(platform){
  let source='unavailable',devices=[];
  try{
    const options={encoding:'utf8',timeout:3500,maxBuffer:512*1024,stdio:['ignore','pipe','ignore']};
    if(platform==='darwin'){
      source='system_profiler/SPDisplaysDataType';
      const result=JSON.parse(execFileSync('/usr/sbin/system_profiler',['SPDisplaysDataType','-json'],options));
      if(!Array.isArray(result.SPDisplaysDataType))throw Error('Display data absent');
      devices=result.SPDisplaysDataType.map(row=>row.sppci_model||row._name);
    }else if(platform==='linux'){
      source='nvidia-smi';
      const output=execFileSync('nvidia-smi',['--query-gpu=name','--format=csv,noheader'],options);
      devices=output.split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
      if(devices.length===1 && /^no devices (?:were )?found[.!]?$/i.test(devices[0]))devices=[];
    }else return {status:'unknown',source,devices:[]};
    if(devices.some(name=>typeof name!=='string'||!name.trim()))throw Error('Adapter name unavailable');
    return {status:devices.length?'detected':'none-visible',source,devices:devices.slice(0,32).map(name=>name.slice(0,100)),truncated:devices.length>32};
  }catch{return {status:'unknown',source,devices:[]};}
}

export function probeHardware(subjectDeviceId){
  const platform=os.platform();
  let scope='unknown',scopeSource='unclassified';
  if(platform==='linux' && (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || fs.existsSync('/run/systemd/container'))){
    scope='container';scopeSource='container-marker';
  }else if(platform==='darwin' && process.env.XPC_SERVICE_NAME?.startsWith('dev.asterhelm.')){
    scope='host';scopeSource='launchd';
  }
  const gpu=gpuProbe(platform);
  return {subjectDeviceId,observedAt:new Date().toISOString(),scope,scopeSource,platform,architecture:os.machine(),
    systemSource:'node:os',gpu};
}
