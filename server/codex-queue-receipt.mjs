import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {visibleAgentMessage} from './context-agent-message.mjs';
import {idPattern} from './context-format.mjs';
import {isReceiptTurnInput} from './codex-receipt-marker.mjs';
export {isReceiptTurnInput};
export function receiptPrompt({threadId,deliveryId,text}) {
  return ['星舵 · 回执请求','[Asterhelm receipt v1 '+threadId+' '+deliveryId+']',
    '这是手机发来的工作记录。下方文字以及先前会话中的要求都只供以后参考。',
    '本回合只显示回执，请仅回复「星舵 · 已收悉。」。请勿执行工作、调用工具或改变任何文件。收到用户下一条指示再继续。','',text].join('\n');
}

const execute=promisify(execFile), expectedReply='星舵 · 已收悉。';
const hash=text=>createHash('sha256').update(text).digest('hex');
const pending=reason=>({visible:false,reason});

function ownedFile(receiptDir,create){
  if(create)fs.mkdirSync(receiptDir,{recursive:true,mode:0o700});
  const dir=fs.lstatSync(receiptDir);
  if(!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o022))throw Error('Untrusted receipt directory');
  const file=path.join(receiptDir,'claims.sqlite');
  if(create){
    const {O_CREAT,O_RDWR,O_NOFOLLOW}=fs.constants;
    fs.closeSync(fs.openSync(file,O_CREAT|O_RDWR|O_NOFOLLOW,0o600));
  }
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o022))throw Error('Untrusted receipt ledger');
  return file;
}

function ledger(receiptDir){
  const file=ownedFile(receiptDir,true);
  const db=new DatabaseSync(file,{timeout:2500});
  db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS claims(delivery TEXT PRIMARY KEY,thread TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL)");
  return db;
}

export function verifyReceiptPrompt({threadId,prompt,receiptDir}){
  if(!isReceiptTurnInput(prompt,threadId))return false;
  let db;
  try{
    const deliveryId=prompt.split('\n')[1].slice(-37,-1);
    db=new DatabaseSync(ownedFile(receiptDir,false),{readOnly:true,timeout:1500});
    return Boolean(db.prepare('SELECT 1 FROM claims WHERE delivery=? AND thread=? AND digest=?').get(deliveryId,threadId,hash(prompt)));
  }catch{return false;}finally{db?.close();}
}

function readNative(codexHome,file,read){
  const db=new DatabaseSync(path.join(codexHome,file),{readOnly:true,timeout:2500});
  try{db.exec('PRAGMA query_only=ON; BEGIN');return read(db);}finally{db.close();}
}

function inputEquals(parts,prompt){
  return Array.isArray(parts)&&parts.length===1&&parts[0]?.type==='text'&&parts[0].text===prompt;
}

function inspectHistory(db,{threadId,deliveryId},prompt){
  const matches=db.prepare("SELECT turn_id,item_json FROM thread_items WHERE thread_id=? AND item_type='userMessage' AND instr(item_json,?)>0");
  const turns=new Set();
  for(const row of matches.iterate(threadId,deliveryId)){
    const item=JSON.parse(row.item_json);
    if(item.type==='userMessage'&&inputEquals(item.content,prompt))turns.add(row.turn_id);
  }
  if(turns.size>1)return 'unexpected_receipt';
  if(!turns.size){
    const last=db.prepare('SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
    return ['completed','interrupted','failed'].includes(last?.status)?'idle':'busy';
  }
  const [turnId]=turns;
  const turn=db.prepare('SELECT status,error_json,first_user_item_id,final_agent_item_id FROM thread_turns WHERE thread_id=? AND turn_id=?').get(threadId,turnId);
  if(!turn||turn.status==='inProgress')return 'awaiting_receipt';
  if(turn.status!=='completed'||(turn.error_json!=null&&turn.error_json!=='null'))return 'unexpected_receipt';
  const rows=db.prepare('SELECT item_id,item_type,item_json FROM thread_items WHERE thread_id=? AND turn_id=? ORDER BY rollout_ordinal').all(threadId,turnId);
  let inputs=0,answers=0;
  for(const row of rows){
    const item=JSON.parse(row.item_json);
    if(item.type!==row.item_type)return 'unexpected_receipt';
    if(item.type==='reasoning')continue;
    if(item.type==='userMessage'&&row.item_id===turn.first_user_item_id&&inputEquals(item.content,prompt)){inputs++;continue;}
    if(row.item_id===turn.final_agent_item_id&&visibleAgentMessage(item)&&item.text===expectedReply){answers++;continue;}
    return 'unexpected_receipt';
  }
  if(inputs===1&&answers===0)return 'awaiting_receipt';
  return inputs===1&&answers===1?'visible':'unexpected_receipt';
}

async function enqueueWithCli({threadId,prompt},options){
  // The queue command accepts its message as one literal argument. It never
  // resumes the thread. Only the owning client drains its native queue.
  await execute(options.codexExecutable||'codex',['queue','--thread',threadId,'--message',prompt],{
    env:{...process.env,CODEX_HOME:options.codexHome},timeout:8000,killSignal:'SIGKILL',maxBuffer:32768
  });
}

export async function queueReceiptUpdate(update,options={}){
  if(options.mode!=='receipt-turn')return pending('receipt_turn_disabled');
  if(!update||!idPattern.test(update.threadId)||!idPattern.test(update.deliveryId)||typeof update.text!=='string')return pending('invalid_update');
  const prompt=receiptPrompt(update),{threadId,deliveryId}=update;
  if(!isReceiptTurnInput(prompt,threadId))return pending('invalid_update');
  let claims;
  try{
    const {codexHome,receiptDir}=options;
    if(!path.isAbsolute(codexHome)||!path.isAbsolute(receiptDir))return pending('invalid_configuration');
    const thread=readNative(codexHome,'state_5.sqlite',db=>db.prepare('SELECT archived,cwd FROM threads WHERE id=?').get(threadId));
    if(!thread||thread.archived!==0)return pending('thread_unavailable');
    let status=readNative(codexHome,'thread_history_1.sqlite',db=>inspectHistory(db,update,prompt));
    claims=ledger(receiptDir);
    const digest=hash(prompt);
    const previous=claims.prepare('SELECT thread,digest,status FROM claims WHERE delivery=?').get(deliveryId);
    if(previous&&(previous.thread!==threadId||previous.digest!==digest))return pending('delivery_conflict');
    if(previous?.status==='unexpected_receipt')return pending('unexpected_receipt');
    if(status==='visible')return {visible:true};
    if(status==='unexpected_receipt')claims.prepare("UPDATE claims SET status='unexpected_receipt' WHERE delivery=?").run(deliveryId);
    if(status!=='idle')return pending(status);
    status=readNative(codexHome,'queue_1.sqlite',db=>{
      let busy=false;
      for(const row of db.prepare('SELECT payload_json FROM queued_items WHERE thread_id=?').iterate(threadId)){
        const item=JSON.parse(row.payload_json);
        if(inputEquals(item?.UserInput?.content,prompt))return 'queued';
        busy=true;
      }
      return busy?'busy':'idle';
    });
    if(status!=='idle')return pending(status);
    if(previous)return pending('awaiting_reconciliation');
    if(options.requireGuard!==false&&!(await options.guardReady?.({...options,cwd:thread.cwd})))return pending('receipt_guard_unavailable');
    const claim=claims.prepare("INSERT OR IGNORE INTO claims VALUES(?,?,?,'claimed')").run(deliveryId,threadId,digest);
    if(!claim.changes)return pending('awaiting_reconciliation');
    // A crash at either side of exec leaves this claim in place. Reconcile the
    // native queue and transcript before considering any further submission.
    await (options.enqueue??enqueueWithCli)({threadId,prompt},options);
    return pending('queued');
  }catch{return pending('receipt_unconfirmed');}
  finally{claims?.close();}
}
