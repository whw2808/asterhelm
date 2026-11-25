import {actor} from './router-policy.mjs';

function clipped(text,limit){
  if(text.length<=limit)return text;
  const half=Math.floor(limit/2);
  return text.slice(0,half)+'\n[中段省略]\n'+text.slice(-half);
}
function current(store,turn){
  const order=store.work.order(turn.id);
  return order?.revision===turn.revision&&order.round===turn.round&&
    ['working','synthesizing'].includes(order.state)&&!store.heldForInput?.(turn.id);
}
function finish(store,turn,state,reply,assessment=[]){
  store.transact(()=>{
    if(!current(store,turn))return;
    const steps=store.work.evidence(turn.id);
    const active=steps.filter(s=>s.scope==='active');
    const notify=active.some(s=>s.notify||['failed','interrupted'].includes(s.state));
    const awaiting=steps.filter(s=>s.scope==='paused'&&['queued','running','offline'].includes(s.state));
    if(awaiting.length){
      const devices=[...new Set(awaiting.map(s=>s.deviceName+' · '+s.agentName))];
      reply+='\n\n已暂停的分工仍在等待停止或撤回回执（'+devices.join('、')+'），进度见任务卡。';
    }
    store.reply('delivery-'+turn.id,turn.id,reply,notify);
    store.db.prepare('UPDATE work_orders SET assessment=?,decision=NULL WHERE id=?').run(JSON.stringify(assessment),turn.id);
    store.work.setState(turn.id,state);
  });
}
function reviewCoverage(criteria,coverage,results,scopeReceipts){
  if(!Array.isArray(coverage)||coverage.length!==criteria.length)throw Error('Incomplete delivery checklist');
  return criteria.map((item,index)=>{
    const row=coverage.find(r=>r.index===index);
    if(!row||!['answered','missing'].includes(row.status)||!row.finding?.trim())throw Error('Invalid coverage row');
    const sources=Array.isArray(row.sources)?row.sources:[];
    const receipts=row.kind==='status'?scopeReceipts:[];
    const verified=id=>results.some(r=>r.id===id&&r.state==='succeeded'&&r.result)||receipts.some(r=>r.id===id&&r.finishedAt);
    const supported=sources.length>0&&sources.every(verified);
    return {item,finding:row.finding.trim(),sources:sources.filter(id=>results.some(r=>r.id===id)||receipts.some(r=>r.id===id)),answered:row.status==='answered'&&supported};
  });
}
function eligibleWorkers(workers,steps,revision){
  return workers.flatMap(worker=>{
    const grants=steps.filter(s=>s.target===worker.target&&s.deviceId===worker.deviceId);
    if(!grants.length||worker.needsCredentials)return [];
    const modes=(worker.capabilities||[]).filter(mode=>mode==='read-only'||
      (mode==='workspace-write'&&grants.some(s=>s.mode===mode&&s.introducedRevision===revision)));
    return modes.length?[{...actor(worker),modes}]:[];
  });
}
async function submitFollowUp(agent,turn,action){
  const {store,broker}=agent,work=store.work;
  const key=turn.id+':follow:'+turn.round,requestId='personal:'+key;
  const step=work.evidence(turn.id).find(s=>s.id===key);
  if(!step||step.scope!=='active'||!current(store,turn))return;
  if(step.taskId){work.clearDecision(turn.id);return;}
  // Decisions from earlier versions were exclusively read-only consults.
  let task;
  try{
    task=await broker('/submit',{target:action.target,mode:action.mode??'read-only',prompt:action.prompt,requestId});
  }catch(error){
    if(turn.failures<3||!current(store,turn))throw error;
    // A lost HTTP reply can hide an accepted task. Resolve its durable key before closing the step.
    task=await broker('/getByRequestId',{requestId});
    if(!task){
      if(!current(store,turn))return;
      const receipt=await broker('/cancelByRequestId',{requestId});
      if(!receipt?.cancelled)throw error;
      task=receipt.task;
      if(!task){
        if(current(store,turn))store.transact(()=>{
          work.stopUnsubmitted(key,'interrupted','未能提交分工，执行端未接单');
          work.clearDecision(turn.id);
        });
        return;
      }
    }
  }
  const obsolete=store.transact(()=>{
    work.bind(key,task);
    store.track(task.id,turn,action.notify);
    const fresh=work.order(turn.id);
    if(fresh.state==='cancelled'||work.evidence(turn.id).find(s=>s.id===key)?.scope==='paused')return true;
    if(fresh.revision===turn.revision&&fresh.round===turn.round&&fresh.decision===turn.decision)work.clearDecision(turn.id);
    return false;
  });
  if(obsolete){
    const receipt=await broker('/cancelByRequestId',{requestId});
    if(receipt?.task)store.transact(()=>work.observe(receipt.task));
  }
}
export async function deliverWork(agent){
  const {store,planner}=agent,work=store.work;
  const turn=work.ready(id=>store.heldForInput?.(id));if(!turn)return;
  const criteria=JSON.parse(turn.criteria);
  try{
    if(turn.decision){await submitFollowUp(agent,turn,JSON.parse(turn.decision));return;}
    const assignments=work.evidence(turn.id);
    const steps=assignments.filter(s=>s.scope==='active');
    const scopeReceipts=assignments.filter(s=>s.scope==='paused').map(s=>({
      id:'receipt:'+s.id,title:s.title,device:s.deviceName,agent:s.agentName,progress:s.progress,finishedAt:s.finishedAt,
      workerConfirmedStop:s.workerState==='cancelled',
    }));
    if(steps.some(s=>s.state==='cancelled')){
      finish(store,turn,'cancelled','这项工作的执行已取消。已收到的回执保留在原任务卡中。');return;
    }
    if(!steps.length){work.setState(turn.id,'paused');return;}
    const results=steps.map(s=>({id:s.taskId||s.id,device:s.deviceName,agent:s.agentName,state:s.state,title:s.title,result:clipped(s.result,14000)}));
    work.setState(turn.id,'synthesizing');
    const workers=await agent.broker('/workers');
    if(!current(store,turn))return;
    const eligible=eligibleWorkers(workers,steps,turn.revision);
    const canConsult=turn.round<2&&eligible.length>0;
    const question=turn.goal??turn.text;
    const output=await planner.plan({phase:'delivery',originalQuestion:question,amendment:turn.amendment,revision:turn.revision,
      criteria,results,scopeReceipts,canConsult,workers:eligible,preferences:store.preferences().map(p=>({text:p.text,scope:p.scope})),
      requestedFormat:'用用户的语言。先给结论，解释比较对象各自的具体依据和差别，只在当前证据支持的范围内作答。'});
    if(!current(store,turn))return;
    const coverage=reviewCoverage(criteria,output.coverage,results,scopeReceipts);
    const missing=coverage.filter(r=>!r.answered);
    const follow=output.actions?.length===1?output.actions[0]:null;
    if(missing.length&&canConsult&&['consult','dispatch'].includes(follow?.type)){
      const mode=follow.write===true?'workspace-write':'read-only';
      const worker=eligible.find(w=>w.target===follow.target&&w.modes.includes(mode));
      if(worker&&(follow.write==null||typeof follow.write==='boolean')&&(follow.type==='dispatch'||mode==='read-only')&&typeof follow.prompt==='string'&&follow.prompt.trim()){
        const title=String(follow.title||'核实剩余要求').slice(0,90);
        const prompt='仅处理本次分工，交回可核对的具体产出与依据。由总控核对整项工作与其他设备的回执。\n本次分工：'+follow.prompt.slice(0,6500);
        const action={target:worker.target,mode,title,prompt,notify:steps.some(s=>s.notify)};
        store.transact(()=>{
          if(!current(store,turn))return;
          work.saveDecision(turn.id,action);
          work.stage(turn.id,turn.id+':follow:'+(turn.round+1),worker,follow.type,title,action.notify,false,mode);
        });
        return;
      }
    }
    const reply=output.reply?.trim();
    if(!reply)throw Error('Missing synthesized answer');
    const unsupported=missing.filter(m=>!reply.includes(m.finding));
    const note=unsupported.length?'\n\n**仍待核实**\n'+unsupported.map(m=>'- '+m.item+'：'+m.finding).join('\n'):'';
    finish(store,turn,missing.length?'partial':'completed',reply+note,coverage);
  }catch(e){
    if(!current(store,turn))return;
    if(!turn.decision&&turn.failures>=3){
      finish(store,turn,'partial','已保存执行回执。总控暂时未能完成以下交付：\n'+criteria.map(x=>'- '+x).join('\n')+'\n可在原对话要求继续核对。');
    }else work.retry(turn.id,turn.failures);
    console.error('personal delivery retry:',e.name,String(e.message).slice(0,90));
  }
}
