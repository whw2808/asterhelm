import {machineRows} from './context-read.mjs';
import {excerpt,idPattern} from './context-format.mjs';
import {home} from './control.mjs';

const initialized=new WeakSet();
function ensureTable(db){
  if(initialized.has(db))return;
  db.exec('CREATE TABLE IF NOT EXISTS desktop_inbound_cursors(participant INTEGER PRIMARY KEY,ordinal INTEGER NOT NULL)');
  initialized.add(db);
}

export function desktopHasBackfill(store,row){
  if(row.source!=='Codex Desktop')return false;
  ensureTable(store.db);
  return Boolean(store.db.prepare(`SELECT 1 FROM desktop_inbound_cursors JOIN continuity_participants USING(participant)
    WHERE machine=? AND target=? AND id=?`).get(row.machine,row.target??'',row.id));
}

// The broker supplies the device and connector from its authenticated registry.
// The committed index additionally excludes archived, missing and CLI sessions.
export function desktopBackfill(store,route,input,dataHome=home){
  const {machine,target,threadId,after,through,evidence}=input;
  if(typeof target!=='string'||!target)throw Error('Desktop connector required');
  ensureTable(store.db);
  const {db}=store;
  const participants=`SELECT p.participant,p.id AS threadId,p.boundAt,coalesce(c.ordinal,-1) AS after
    FROM continuity_participants p LEFT JOIN desktop_inbound_cursors c USING(participant) WHERE p.machine=? AND p.target=?`;
  const index=()=>machineRows(dataHome,machine).filter(row=>row.source==='Codex Desktop'&&!row.archived);
  if(route==='/contexts/desktopCursors'){
    const bound=db.prepare(participants+' ORDER BY p.participant').all(machine,target);
    if(!bound.length)return {threads:[]};
    const visible=new Set(index().map(row=>row.id));
    return {threads:bound.filter(p=>visible.has(p.threadId)).map(({threadId,boundAt,after})=>({threadId,boundAt,after}))};
  }
  if(route!=='/contexts/desktopPage'||!idPattern.test(threadId)||!Number.isSafeInteger(after)||after< -1||
    !Number.isSafeInteger(through)||through<after||!Array.isArray(evidence)||evidence.length>32)throw Error('Invalid desktop page');
  const row=index().find(r=>r.id===threadId);
  if(!row)throw Error('Desktop session unavailable');
  return store.transact(()=>{
    const participant=db.prepare(participants+' AND p.id=?').get(machine,target,threadId);
    if(!participant||after>participant.after)throw Error('Invalid desktop page cursor');
    if(after<participant.after)return {after:participant.after};
    let previous=after;
    for(const item of evidence){
      if(!item||!Number.isSafeInteger(item.seq)||item.seq<=previous||item.seq>through||
        !(Date.parse(item.at)>participant.boundAt)||!item.text||item.text!==excerpt(item.text,700)||
        ![item.turnId,item.itemId].every(id=>typeof id==='string'&&id.length>0&&id.length<=160))throw Error('Invalid desktop reply');
      previous=item.seq;
    }
    if(evidence.length){
      store.continuity.recordDesktop([{machine,target,id:threadId,title:row.title,
        evidence:evidence.map(({turnId,itemId,text,at})=>({role:'assistant',turnId,itemId,text,at}))}]);
    }
    db.prepare(`INSERT INTO desktop_inbound_cursors VALUES(?,?) ON CONFLICT(participant)
      DO UPDATE SET ordinal=excluded.ordinal WHERE ordinal<excluded.ordinal`).run(participant.participant,through);
    return {after:through};
  });
}
