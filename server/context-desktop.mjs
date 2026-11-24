import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {excerpt,maxEvidence,idPattern} from './context-format.mjs';

function open(root,file){
  const db=new DatabaseSync(path.join(root,file),{readOnly:true,timeout:2500,enableDoubleQuotedStringLiterals:false});
  db.exec('PRAGMA query_only=ON; BEGIN');return db;
}
function iso(ms){return new Date(Number(ms)).toISOString();}

export function scanDesktop(codexHome){
  const meta=open(codexHome,'state_5.sqlite');
  let history;
  try{
    history=open(codexHome,'thread_history_1.sqlite');
    const selection=`thread_source='user' AND (
       (source='vscode' AND (originator IS NULL OR originator IN ('Codex Desktop','codex_work_desktop'))) OR
       (source='cli' AND originator='codex-tui'))`;
    const identities=meta.prepare('SELECT COUNT(DISTINCT creator_account_id) AS accounts,COUNT(DISTINCT creator_user_id) AS users FROM threads WHERE '+selection).get();
    if(identities.accounts>1||identities.users>1)throw Error('Desktop history contains multiple account identities');
    const threads=meta.prepare('SELECT id,source,name,title,cwd,created_at_ms,updated_at_ms,created_at,updated_at,archived FROM threads WHERE '+selection+' ORDER BY id').all();
    const recent=history.prepare(`SELECT item_type,item_json,turn_id,item_id,created_at_ms FROM thread_items
      WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') AND length(item_json)<250000
      ORDER BY rollout_ordinal DESC LIMIT 120`);
    const turn=history.prepare('SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1');
    return threads.filter(t=>idPattern.test(t.id)).map(t=>{
      const evidence=[];
      for(const item of recent.iterate(t.id)){
        const data=JSON.parse(item.item_json);
        let role,text;
        if(item.item_type==='userMessage' && data.type==='userMessage'){
          role='user';text=data.content?.filter(p=>p.type==='text').map(p=>p.text).join(' ');
        }else if(item.item_type==='agentMessage' && data.type==='agentMessage' && (!data.phase||data.phase==='final_answer')){
          role='assistant';text=data.text;
        }
        const visible=excerpt(text,700);
        if(!visible || !item.turn_id || !item.item_id || !item.created_at_ms)continue;
        evidence.unshift({role,text:visible,at:iso(item.created_at_ms),turnId:item.turn_id,itemId:item.item_id});
        if(evidence.length===maxEvidence)break;
      }
      const user=evidence.findLast(e=>e.role==='user');
      const answer=evidence.findLast(e=>e.role==='assistant');
      const summary=[user&&'用户：'+excerpt(user.text,310),answer&&'助手：'+excerpt(answer.text,550)].filter(Boolean).join('\n');
      const status=turn.get(t.id)?.status;
      const sourceUpdatedAt=iso(t.updated_at_ms||t.updated_at*1000);
      const lastMessageAt=evidence.at(-1)?.at??null;
      return {id:t.id,title:excerpt(t.name,180)||excerpt(t.title,180)||'Codex 会话',cwd:excerpt(t.cwd,512),
        source:t.source==='cli'?'Codex CLI':'Codex Desktop',summary,createdAt:iso(t.created_at_ms||t.created_at*1000),
        updatedAt:lastMessageAt??sourceUpdatedAt,sourceUpdatedAt,lastMessageAt,
        status:['inProgress','completed','failed','interrupted'].includes(status)?status:'unknown',
        archived:Boolean(t.archived),visibility:evidence.length?'recent-dialogue':'metadata-only',readOnly:true,evidence};
    });
  }finally{history?.close();meta.close();}
}
