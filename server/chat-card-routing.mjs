// A queued chat turn may only refer to a card version that existed when the
// message arrived. Keep IDs and versions until the turn is resolved or planned.
const liveCards=`SELECT id,version,messageId FROM (
  SELECT id,version,messageId,messageId AS origin FROM follow_goals
    WHERE status!='stopped' AND (untilAt IS NULL OR untilAt>?)
  UNION ALL SELECT id,version,source,source FROM wake_rules WHERE status IN ('active','paused','blocked')
  UNION ALL SELECT id,version,'candidate-'||id,json_extract(source,'$.origin') FROM proactive_candidates
    WHERE status IN ('checking','waiting')
) WHERE NOT EXISTS(SELECT 1 FROM memory_exclusions WHERE id=origin)
  AND NOT EXISTS(SELECT 1 FROM diagnostics WHERE kind='turn' AND id=origin)`;

export class ChatCardVersions{
  constructor(db){
    db.exec(`CREATE TABLE IF NOT EXISTS chat_card_versions(
      turnId TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(turnId,id));
      CREATE TRIGGER IF NOT EXISTS release_chat_card_versions AFTER UPDATE OF state ON turns
      WHEN old.state='new' AND new.state!='new' BEGIN DELETE FROM chat_card_versions WHERE turnId=new.id; END;`);
    this.save=db.prepare('INSERT INTO chat_card_versions SELECT ?,id,version FROM ('+liveCards+')');
    this.offered=db.prepare('SELECT c.id,c.version,c.messageId FROM ('+liveCards+') c JOIN chat_card_versions p USING(id,version) WHERE p.turnId=?');
    this.previous=db.prepare(`SELECT id,parent FROM messages WHERE seq<? ORDER BY seq DESC LIMIT 1`);
  }
  capture(turn){
    this.save.run(turn.id,Date.now());
    return {id:turn.id};
  }
  snapshot(agent,turn){
    const rows=this.offered.all(Date.now(),turn.id),versions=new Map(rows.map(r=>[r.id,r.version]));
    const last=this.previous.get(turn.seq);
    return agent.proactiveCards(rows.map(r=>r.messageId)).filter(c=>c.version===versions.get(c.id)).map(c=>({
      id:c.id,kind:c.kind,version:c.version,title:c.title,status:c.status,decisions:c.actions.map(a=>a.decision),
      presentedLast:Boolean(last&&(last.id===c.messageId||last.parent===c.messageId||last.id===c.reportMessageId)),
      ...(c.kind==='candidate'?{goal:c.goal,criteria:c.criteria,nextStep:c.nextStep,device:c.deviceName,agent:c.agentName}:{}),
      ...(c.kind==='rule'?{device:c.deviceName,agent:c.agentName}:{})
    }));
  }
}

export function currentCard(agent,id){
  const goal=agent.goals.get(id);
  if(goal)return goal;
  const candidate=agent.candidates.get(id);
  if(candidate)return agent.candidates.card(candidate);
  const rule=agent.rules.rule(id);
  return rule?agent.rules.card(rule):null;
}

export function applyCardDecision(agent,turn,choice,card,cursor){
  if(!card)throw Error('未找到这张卡，请查看最新消息。');
  if(card.kind==='candidate')return agent.candidates.decide(turn,choice);
  if(card.kind==='goal')agent.store.finish(turn,agent.goals.decide(turn,choice).detail);
  else{
    agent.rules.decide(turn,{...choice,cursor});
    agent.store.finish(turn,'规则已'+({pause:'暂停',resume:'恢复',cancel:'取消'}[choice.decision]||'更新')+'。');
  }
  return {id:turn.id,...(card.workId?{workId:card.workId}:{})};
}
