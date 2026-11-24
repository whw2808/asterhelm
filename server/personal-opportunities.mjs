// A conservative observation: the same recent instruction AND the same named artifact, on two machines.
// Suggestions can be ignored; this module never changes a desktop thread or schedules a worker.
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
function signature(row){
  if(row.archived || row.status!=='inProgress')return null;
  const line=row.evidence?.findLast(x=>x.role==='user');
  if(!line||!line.text||line.text.length<18)return null;
  const text=line.text.trim().toLowerCase().replace(/\s+/gu,' ');
  const named=text.match(/[\p{L}\p{N}_./-]+\.(?:csv|jsonl?|parquet|tsv|xlsx?|pdf|zip|log)\b/giu) || [];
  const digests=text.match(/\b[a-f0-9]{64}\b/g)||[];
  if(!named.length&&!digests.length)return null;
  return {key:hash(text+'\n'+[...named,...digests].join('|')),at:Date.parse(line.at)};
}
export function findSharedWork(rows,{since,now=Date.now()}){
  const seen=new Map(),pairs=[];
  for(const row of rows){
    const s=signature(row);
    if(!s||!Number.isFinite(s.at)||s.at>now+60000||now-s.at>3600000)continue;
    const prior=seen.get(s.key)||[];
    for(const p of prior){
      if(p.row.machine===row.machine||Math.max(p.at,s.at)<since)continue;
      const ids=[p.row.machine+':'+p.row.id,row.machine+':'+row.id].sort();
      pairs.push({id:'overlap-'+hash(ids.join('|')+s.key).slice(0,32),
        text:'我发现两台机器最近都在处理同一条请求，提到的输入文件也相同。'+p.row.machine+' 的「'+p.row.title+'」和 '+row.machine+' 的「'+row.title+'」可能在重复工作。需要我对照进展时，告诉我一声。'});
    }
    prior.push({row,at:s.at});seen.set(s.key,prior);
  }
  return pairs;
}
