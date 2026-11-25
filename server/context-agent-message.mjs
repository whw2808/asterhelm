import {idPattern} from './context-format.mjs';
import {isReceiptTurnInput} from './codex-receipt-marker.mjs';

export function visibleAgentMessage(item){
  if(item?.type!=='agentMessage'||(item.phase!=null&&item.phase!=='final_answer'))return false;
  const moderation=item.moderation;
  return !moderation?.moderated&&(moderation?.display==null||moderation.display.mode==='show');
}

// An assistant's receipt may be malformed. Check the original input to its own
// turn even when it has already left the rolling excerpt or current page.
export function desktopSyncTurns(db){
  const markers=db.prepare(`SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type='userMessage'
    AND length(item_json)<250000 AND (instr(item_json,'[Asterhelm sync ')>0 OR instr(item_json,'[Asterhelm receipt v1 ')>0)`);
  const cache=new Map();
  return (threadId,turnId)=>{
    const key=JSON.stringify([threadId,turnId]);
    if(cache.has(key))return cache.get(key);
    let found=false;
    for(const {item_json} of markers.iterate(threadId,turnId)){
      const message=JSON.parse(item_json),part=message.content?.[0];
      if(message.type!=='userMessage'||message.content?.length!==1||part?.type!=='text'||typeof part.text!=='string')continue;
      const match=part.text.startsWith('星舵 · 工作更新\n')&&/\n\[Asterhelm sync ([^\]]+)\]$/.exec(part.text);
      if((match&&idPattern.test(match[1]))||isReceiptTurnInput(part.text,threadId)){found=true;break;}
    }
    cache.set(key,found);
    return found;
  };
}
