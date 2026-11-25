import fs from 'node:fs';
import path from 'node:path';
import {sources} from './context-format.mjs';
import {projectAliasesFor,readRegistry,safeDeviceId} from './registry.mjs';

function optional(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
export function machineRows(home,machine){
  if(!safeDeviceId(machine))throw Error('Unknown context source');
  return optional(path.join(home,'contexts',machine+'.json'),[]);
}
function contextDevices(home){
  const devices=new Map();
  for(const r of readRegistry(home)){
    if(!r.contextSources.length)continue;
    if(!devices.has(r.deviceId))devices.set(r.deviceId,{machine:r.deviceId,deviceName:r.deviceName,platform:r.platform,aliases:r.deviceAliases,projectAliases:r.projectAliases,connectors:[]});
    devices.get(r.deviceId).connectors.push({target:r.target,agentName:r.agentName,sources:r.contextSources});
  }
  const dir=path.join(home,'contexts');
  if(fs.existsSync(dir)){
    for(const name of fs.readdirSync(dir)){
      const match=/^([a-z0-9][a-z0-9_-]{0,62})(?:\.seen)?\.json$/.exec(name);
      if(match && !devices.has(match[1]))devices.set(match[1],{machine:match[1],deviceName:match[1],platform:'',aliases:[],connectors:[]});
    }
  }
  return [...devices.values()];
}
export function contextCoverage(home,now=Date.now()){
  return contextDevices(home).map(device=>{
    const {machine}=device;
    const rows=machineRows(home,machine);
    const seen=optional(path.join(home,'contexts',machine+'.seen.json'),null);
    const lastSyncAt=seen?.lastSyncAt??null;
    const online=Boolean(lastSyncAt && now-Date.parse(lastSyncAt)<90000);
    const withEvidence=rows.filter(r=>r.visibility==='recent-dialogue').length;
    const bySource=new Map(device.connectors.flatMap(c=>c.sources.map(source=>[source,c])));
    const declared=bySource.size?[...bySource.keys()]:sources;
    const breakdown=[...new Set([...declared,...rows.map(r=>r.source)])].map(source=>{
      const matching=rows.filter(r=>r.source===source);
      const withEvidence=matching.filter(r=>r.visibility==='recent-dialogue').length;
      const connector=bySource.get(source);
      const sourceSync=connector?seen?.connectorSync?.[connector.target]??(device.connectors.length===1?lastSyncAt:null):lastSyncAt;
      return {source,target:connector?.target??null,lastSyncAt:sourceSync,online:Boolean(sourceSync && now-Date.parse(sourceSync)<90000),count:matching.length,withEvidence,metadataOnly:matching.length-withEvidence};
    });
    return {...device,source:[...new Set(device.connectors.map(c=>c.agentName))].join(' / ')||'Codex',sources:breakdown,lastSyncAt,online,status:online?'online':lastSyncAt?'offline':'never',
      count:rows.length,withEvidence,metadataOnly:rows.length-withEvidence,scope:'user-chats',readOnly:true};
  });
}

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set('昨天 今天 刚才 我 我们 你 你们 的 了 在 上 最近 哪些 什么 如何 怎么 进展 工作 能 查 一下 那个 上次 桌面 会话 聊天 帮 看 有没有 和 又 或 与 项目 the and on of is has have from in my please latest recent chat chats work progress what'.split(' '));
export function readContexts(home,{query='',limit=30,project=''}={}){
  let phrase=String(query||'').trim().toLocaleLowerCase().slice(0,1200);
  const devices=contextDevices(home),matches=new Set(),mentions=[];
  for(const device of devices){
    for(const label of [device.machine,device.deviceName,device.platform,...device.aliases,...projectAliasesFor(device,project)].filter(Boolean)){
      const term=label.toLocaleLowerCase();
      const re=new RegExp((/^[a-z0-9]/.test(term)?'(?<![a-z0-9])':'')+RegExp.escape(term)+
        (/[a-z0-9]$/.test(term)?'(?![a-z0-9])':''),'gu');
      if(re.test(phrase)){matches.add(device.machine);mentions.push({term,re});}
    }
  }
  for(const {re} of mentions.sort((a,b)=>b.term.length-a.term.length))phrase=phrase.replace(re,' ').trim();
  const tokens=[...new Set([...segmenter.segment(phrase)].filter(x=>x.isWordLike&&!stop.has(x.segment)).map(x=>x.segment))];
  const scored=[];
  for(const {machine,connectors} of devices){
    if(matches.size && !matches.has(machine))continue;
    const bySource=new Map(connectors.flatMap(c=>c.sources.map(source=>[source,c.target])));
    for(const r of machineRows(home,machine)){
      const title=r.title.toLocaleLowerCase();
      const body=[r.cwd,r.summary,...r.evidence.map(e=>e.text)].join(' ').toLocaleLowerCase();
      let score=0;
      if(phrase){
        if(phrase.includes(r.id))score+=100;
        if(title.includes(phrase))score+=20;
        if(body.includes(phrase))score+=8;
        for(const term of tokens){
          if(title.includes(term))score+=4;
          if(body.includes(term))score+=1;
        }
      }
      if(!phrase||!tokens.length||score)scored.push({score,row:{...r,machine,target:bySource.get(r.source)??null}});
    }
  }
  return scored.sort((a,b)=>b.score-a.score || b.row.updatedAt.localeCompare(a.row.updatedAt) ||
    a.row.id.localeCompare(b.row.id)).slice(0,Math.max(0,Math.min(500,Number(limit)||0))).map(x=>x.row);
}

// Stable lookup for an explicit user selection, independent of search ranking.
export function readSession(home,machine,id){
  if(!safeDeviceId(machine))return null;
  const row=machineRows(home,machine).find(item=>item.id===id);
  if(!row)return null;
  const registration=readRegistry(home).find(r=>r.deviceId===machine&&r.contextSources.includes(row.source));
  return {...row,machine,target:registration?.target??null};
}
