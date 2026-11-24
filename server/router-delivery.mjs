import {actor} from './router-policy.mjs';

function clipped(text,limit){
  if(text.length<=limit)return text;
  const half=Math.floor(limit/2);
  return text.slice(0,half)+'\n[中段省略]\n'+text.slice(-half);
}
function finish(store,turn,state,reply,assessment=[]){
  store.transact(()=>{
    if(!['working','synthesizing'].includes(store.work.order(turn.id)?.state))return;
    const notify=store.work.evidence(turn.id).some(s=>s.notify||['failed','interrupted'].includes(s.state));
    store.message('delivery-'+turn.id,'assistant',reply,turn.id,notify);
    store.db.prepare('UPDATE work_orders SET assessment=?,decision=NULL WHERE id=?').run(JSON.stringify(assessment),turn.id);
    store.work.setState(turn.id,state);
  });
}
function reviewCoverage(criteria,coverage,results){
  if(!Array.isArray(coverage)||coverage.length!==criteria.length)throw Error('Incomplete delivery checklist');
  return criteria.map((item,index)=>{
    const row=coverage.find(r=>r.index===index);
    if(!row||!['answered','missing'].includes(row.status)||!row.finding?.trim())throw Error('Invalid coverage row');
    const sources=Array.isArray(row.sources)?row.sources:[];
    const supported=sources.length>0&&sources.every(id=>results.some(r=>r.id===id&&r.state==='succeeded'&&r.result));
    return {item,finding:row.finding.trim(),sources:sources.filter(id=>results.some(r=>r.id===id)),answered:row.status==='answered'&&supported};
  });
}
async function submitFollowUp(agent,turn,action){
  const {store,broker}=agent;
  const key=turn.id+':follow:'+turn.round;
  const existing=store.work.evidence(turn.id).find(s=>s.id===key);
  if(!existing?.taskId){
    const task=await broker('/submit',{target:action.target,mode:'read-only',prompt:action.prompt,requestId:'personal:'+key});
    if(store.work.order(turn.id).state==='cancelled'){await broker('/cancel',{id:task.id});return;}
    store.transact(()=>{store.work.bind(key,task);store.track(task.id,turn,action.notify);store.work.clearDecision(turn.id);});
  }else store.work.clearDecision(turn.id);
}
export async function deliverWork(agent){
  const {store,planner}=agent,work=store.work;
  const turn=work.ready();if(!turn)return;
  const criteria=JSON.parse(turn.criteria);
  try{
    if(turn.decision){await submitFollowUp(agent,turn,JSON.parse(turn.decision));return;}
    const steps=work.evidence(turn.id);
    if(steps.some(s=>s.state==='cancelled')){
      finish(store,turn,'cancelled','这项工作的执行已取消。已收到的回执保留在原任务卡中。');return;
    }
    const results=steps.map(s=>({id:s.taskId||s.id,device:s.deviceName,agent:s.agentName,state:s.state,title:s.title,result:clipped(s.result,14000)}));
    work.setState(turn.id,'synthesizing');
    const workers=await agent.broker('/workers');
    const targets=new Set(steps.map(s=>s.target));
    const eligible=workers.filter(w=>targets.has(w.target)&&w.capabilities?.includes('read-only')&&!w.needsCredentials);
    const canConsult=turn.round<2&&eligible.length>0;
    const output=await planner.plan({phase:'delivery',originalQuestion:turn.text,criteria,results,canConsult,
      workers:eligible.map(actor),preferences:store.preferences().map(p=>({text:p.text,scope:p.scope})),
      requestedFormat:'用用户的语言。先给结论，解释比较对象各自的具体依据和差别，只在当前证据支持的范围内作答。'});
    if(work.order(turn.id)?.state!=='synthesizing')return;
    const coverage=reviewCoverage(criteria,output.coverage,results);
    const missing=coverage.filter(r=>!r.answered);
    const follow=output.actions?.find(a=>a.type==='consult');
    if(missing.length&&canConsult&&follow){
      const worker=eligible.find(w=>w.target===follow.target);
      if(!worker||typeof follow.prompt!=='string'||!follow.prompt.trim())throw Error('Invalid follow-up consult');
      const action={target:worker.target,title:String(follow.title||'核实剩余证据').slice(0,90),
        prompt:'仅作与下列原问题相关的只读核实。\n原问题：'+turn.text+'\n待核实：'+missing.map(m=>m.item).join('；')+'\n问题：'+follow.prompt.slice(0,6500),
        notify:steps.some(s=>s.notify)};
      store.transact(()=>{
        work.saveDecision(turn.id,action);
        work.stage(turn.id,turn.id+':follow:'+(turn.round+1),actor(worker),'consult',action.title,action.notify);
      });
      return;
    }
    const reply=output.reply?.trim();
    if(!reply)throw Error('Missing synthesized answer');
    const unsupported=missing.filter(m=>!reply.includes(m.finding));
    const note=unsupported.length?'\n\n**仍待核实**\n'+unsupported.map(m=>'- '+m.item+'：'+m.finding).join('\n'):'';
    finish(store,turn,missing.length?'partial':'completed',reply+note,coverage);
  }catch(e){
    if(!['working','synthesizing'].includes(work.order(turn.id)?.state))return;
    if(turn.failures>=3){
      const pending=work.evidence(turn.id).filter(s=>!s.taskId);
      for(const step of pending)work.stopUnsubmitted(step.id,'interrupted','未能提交补查');
      finish(store,turn,'partial','已保存执行回执。总控暂时未能完成以下交付：\n'+criteria.map(x=>'- '+x).join('\n')+'\n可在原对话要求继续核对。');
    }else work.retry(turn.id,turn.failures);
    console.error('personal delivery retry:',e.name,String(e.message).slice(0,90));
  }
}
