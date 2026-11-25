import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {excerpt,idPattern} from './context-format.mjs';
import {desktopSyncTurns,visibleAgentMessage} from './context-agent-message.mjs';

function readPage(db,{threadId,boundAt,after}){
  db.exec('BEGIN');
  try{
    // An in-progress turn may write its final text at an existing ordinal.
    // Hold the cursor before that turn until its terminal state is committed.
    const {fence}=db.prepare(`SELECT min(rollout_ordinal) AS fence FROM thread_turns WHERE thread_id=?
      AND (status IS NULL OR status NOT IN ('completed','failed','interrupted'))`).get(threadId);
    const {last}=db.prepare('SELECT max(rollout_ordinal) AS last FROM thread_items WHERE thread_id=?').get(threadId);
    const ceiling=Math.min(last??after,fence==null?Number.MAX_SAFE_INTEGER:fence-1);
    if(ceiling<=after)return {through:after,evidence:[],more:false};
    const items=db.prepare(`SELECT i.rollout_ordinal AS seq,i.turn_id AS turnId,i.item_id AS itemId,
      i.created_at_ms AS created,t.status,CASE WHEN length(i.item_json)<250000 THEN i.item_json END AS data
      FROM thread_items i LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id
      WHERE i.thread_id=? AND i.item_type='agentMessage' AND i.rollout_ordinal>? AND i.rollout_ordinal<=?
      AND i.created_at_ms>? ORDER BY i.rollout_ordinal LIMIT 33`).all(threadId,after,ceiling,boundAt);
    const evidence=[];
    const syncTurn=desktopSyncTurns(db);
    let through=after;
    for(const item of items.slice(0,32)){
      if(!['completed','failed','interrupted'].includes(item.status))return {through,evidence,more:false};
      through=item.seq;
      if(!item.data)continue;
      const message=JSON.parse(item.data);
      if(!visibleAgentMessage(message))continue;
      const text=excerpt(message.text,700);
      if(text&&!syncTurn(threadId,item.turnId)){
        evidence.push({seq:item.seq,turnId:item.turnId,itemId:item.itemId,at:new Date(item.created).toISOString(),text});
      }
    }
    const more=items.length>32;
    return {through:more?through:ceiling,evidence,more};
  }finally{db.exec('ROLLBACK');}
}

export async function syncDesktopBackfill(codexHome,rows,request){
  const {threads}=await request('desktopCursors',{});
  const eligible=new Set(rows.filter(r=>r.source==='Codex Desktop'&&!r.archived).map(r=>r.id));
  const bound=threads.filter(p=>eligible.has(p.threadId)&&idPattern.test(p.threadId)&&
    Number.isSafeInteger(p.boundAt)&&p.boundAt>0&&Number.isSafeInteger(p.after)&&p.after>=-1);
  if(!bound.length)return;
  const db=new DatabaseSync(path.join(codexHome,'thread_history_1.sqlite'),{readOnly:true,timeout:2500,enableDoubleQuotedStringLiterals:false});
  try{
    db.exec('PRAGMA query_only=ON');
    for(const participant of bound){
      let after=participant.after;
      // Bound the work per chat per sync cycle so long outages do not delay others.
      for(let batch=0;batch<4;batch++){
        const {through,evidence,more}=readPage(db,{...participant,after});
        if(through===after&&after>=0)break;
        const receipt=await request('desktopPage',{threadId:participant.threadId,after,through,evidence});
        if(!Number.isSafeInteger(receipt?.after)||receipt.after<through)throw Error('Desktop reply receipt unavailable');
        if(!more||receipt.after<=after)break;
        after=receipt.after;
      }
    }
  }finally{db.close();}
}
