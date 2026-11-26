// Review only normalized dispatches, before any part of the plan is persisted
// or submitted. The reviewer never gets access to the broker.
export async function workspaceDecision(planner,turn,snap,plan){
  const proposals=[];
  for(const [index,step] of plan.actions.entries()){
    if(step.type==='dispatch'&&step.mode==='workspace-write'){
      proposals.push({index,target:step.target,device:step.actor.deviceName,agent:step.actor.agentName,
        title:step.title,assignment:step.prompt});
    }
  }
  if(!proposals.length)return null;
  const input={phase:'dispatchAuthority',currentUser:turn.text,history:snap.history,attachedSession:snap.attachedSession,
    criteria:plan.criteria,proposals};
  const review=await planner.plan(input);
  const grants=new Map();
  for(const action of review.actions??[]){
    if(action?.type!=='allow_workspace'||!Number.isSafeInteger(action.index)||grants.has(action.index)||
      typeof action.evidence!=='string'||!action.evidence.trim()||!turn.text.includes(action.evidence))break;
    grants.set(action.index,action.target);
  }
  if(review.actions?.length===proposals.length&&proposals.every(p=>grants.get(p.index)===p.target))return null;
  const reason=typeof review.reply==='string'?review.reply.trim().slice(0,360):'';
  return '尚未派单。'+(reason||'我没能核实这项分工的执行范围，请指出需要哪位 Agent 接手哪项工作。');
}
