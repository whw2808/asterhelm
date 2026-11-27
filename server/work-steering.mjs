// Scope revisions belong to an existing work order in the user's one conversation.
export function checkedRevision(action, activeWork) {
  const order=activeWork.find(work=>work.id===action.id);
  if(!order)throw Error('找不到本条对话中要调整的工作');
  if(typeof action.goal!=='string'||!action.goal.trim()||action.goal.length>4000 ||
    !Array.isArray(action.criteria)||!action.criteria.length||action.criteria.length>6||
    action.criteria.some(c=>typeof c!=='string'||!c.trim()||c.length>480))
    throw Error('变更后的目标或验收条件不完整');
  if(!Array.isArray(action.pauseStepIds)||action.pauseStepIds.some(id=>!order.tasks.some(step=>step.id===id)))
    throw Error('暂停的分工与所选工作不一致');
  const paused=new Set(action.pauseStepIds.filter(id=>order.tasks.find(s=>s.id===id).scope==='active'));
  // The file-consuming half of a handoff cannot proceed after its producer exits scope.
  for(const step of order.tasks)if(step.scope==='active'&&step.id.endsWith(':next')&&paused.has(step.id.slice(0,-5)))paused.add(step.id);
  return {type:'revise',id:order.id,expectedRevision:order.revision,goal:action.goal.trim(),
    criteria:action.criteria.map(c=>c.trim()),pauseStepIds:[...paused],evidence:action.evidence};
}

export async function withdrawPausedSteps(agent,parent,{wholeOrder=false}={}) {
  const {store,broker}=agent,work=store.work;
  for(const step of work.evidence(parent)){
    if(step.finishedAt||!wholeOrder&&step.scope!=='paused')continue;
    let stopped;
    if(step.taskId){
      stopped=await broker('/cancel',{id:step.taskId});
    }else{
      let key='personal:'+step.id;
      if(step.id.endsWith(':next')){
        const first=work.evidence(parent).find(s=>s.id===step.id.slice(0,-5));
        if(!first?.taskId){
          if(first?.finishedAt)work.stopUnsubmitted(step.id,'cancelled','已撤回，执行端未接单');
          continue;
        }
        key='handoff:'+first.taskId;
      }
      const receipt=await broker('/cancelByRequestId',{requestId:key});
      if(!receipt?.cancelled)throw Error('执行端尚未确认撤回请求');
      stopped=receipt.task;
    }
    store.transact(()=>{
      if(!stopped){
        work.stopUnsubmitted(step.id,'cancelled','已撤回，执行端未接单');
        return;
      }
      if(!step.taskId){work.bind(step.id,stopped);store.track(stopped.id,{id:parent},step.notify);}
      work.observe(stopped);
    });
  }
}

export function acceptRevision(agent,turn,action) {
  const {store}=agent;
  // Persist the revised goal and withdrawal intent together, before talking to workers.
  const revision=store.work.revise(action.id,turn,action);
  store.continuity.recordPhoneTurn(turn.id,turn.text,store.continuity.workForTurn(action.id));
  const blocked=store.db.prepare("UPDATE handoffs SET state='scope_paused' WHERE first=? AND state IN ('waiting','forwarding')");
  const steps=store.work.evidence(action.id);
  for(const step of steps){
    if(step.scope!=='paused'||!step.id.endsWith(':next'))continue;
    const producer=steps.find(s=>s.id===step.id.slice(0,-5));
    if(producer?.taskId)blocked.run(producer.taskId);
  }
  return revision;
}
