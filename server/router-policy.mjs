const analysisRequest=/对比|比较|区别|差异|可行性|核对|查证|调研|研究一下|研究下|帮我查|查一下|分析一下|分析下|分析原因|修复|实现|撰写|\b(?:compare|research|investigate|verify|implement|diagnose|analyze)\b/i;
const directReasons=new Set(['conversation','memory','known_result','reported_status','clarification']);
export const forbidDelegation=/不要(?:执行|派单|委派|分派|查证)|不用(?:执行|派单)|先别(?:做|派单)|仅用(?:当前|现有)|只(?:根据|用)(?:当前|现有)对话|只解释|仅解释|无需操作|do not (?:run|dispatch|delegate)|without delegating/i;
export function actor(worker){
  return {target:worker.target,deviceId:worker.deviceId,deviceName:worker.deviceName||worker.deviceId,agentName:worker.agentName||worker.target};
}
function named(text,value){
  if(typeof value!=='string'||!value.trim())return false;
  const prefix=/^[a-z0-9]/i.test(value)?'(?<![a-z0-9])':'',suffix=/[a-z0-9]$/i.test(value)?'(?![a-z0-9])':'';
  return new RegExp(prefix+RegExp.escape(value)+suffix,'iu').test(text);
}
export function mentions(text,worker){
  return [worker.deviceName,worker.platform,worker.deviceId,...(worker.deviceAliases||[]),worker.target].some(label=>named(text,label));
}
function namedAgents(text,workers){
  const scoped=workers.filter(w=>w.scopedAliases?.some(a=>named(text,a)));
  const specific=workers.filter(w=>[w.deviceId,w.deviceName,w.target,...(w.deviceAliases||[])].some(label=>named(text,label)));
  const devices=scoped.length?scoped:specific.length?specific:workers.filter(w=>mentions(text,w));
  const pool=devices.length?devices:workers;
  const agents=pool.filter(w=>[w.target,w.agentName,...(w.aliases||[])].some(label=>named(text,label)));
  return agents.length?agents:devices;
}
export function requireConsult(turn,snap,plan){
  if(forbidDelegation.test(turn.text))return plan;
  if(plan.actions.some(a=>a?.type==='revise'&&snap.activeWork?.some(order=>order.id===a.id)))return plan;
  const physical=snap.workers||[];
  const explicit=namedAgents(turn.text,physical);
  const requestedDevices=new Set(explicit.map(w=>w.deviceId));
  const deviceCandidates=new Set(physical.filter(w=>mentions(turn.text,w)).map(w=>w.deviceId));
  const selected=snap.attachedSession?.machine;
  const delegation=plan.actions.filter(a=>['consult','dispatch','handoff'].includes(a.type));
  // One ambiguous OS/agent name can match several machines. An explicitly requested multi-device operation is different.
  const distinctTargets=new Set(delegation.map(a=>a.target));
  if(requestedDevices.size>1&&!selected&&!delegation.some(a=>a.type==='handoff')&&distinctTargets.size<=1){
    const specificallyNamed=new Set(physical.filter(w=>[w.deviceName,w.deviceId,w.target].some(n=>named(turn.text,n))).map(w=>w.deviceId));
    if(specificallyNamed.size!==1&&(deviceCandidates.size||delegation.length||analysisRequest.test(turn.text)))
      return {...plan,reply:'有多个匹配的设备。你要找'+[...new Set(explicit.map(w=>w.deviceName))].join('还是')+'？',actions:[]};
  }
  if(delegation.length||plan.actions.length)return plan;
  if(!analysisRequest.test(turn.text)&&directReasons.has(plan.directBasis))return plan;
  const eligible=physical.filter(w=>w.deviceId&&!w.needsCredentials&&w.capabilities?.includes('read-only'));
  const explicitEligible=explicit.filter(w=>eligible.includes(w));
  const cited=(plan.references||[]).filter(ref=>(snap.sessions||[]).some(s=>s.machine===ref.machine&&s.id===ref.id));
  const source=snap.attachedSession||cited[0]||snap.lastMentioned?.[0];
  const pool=explicit.length?explicitEligible:eligible;
  const owner=(snap.sessions||[]).find(s=>s.id===source?.id&&s.machine===source?.machine)?.target;
  const worker=pool.find(w=>w.target===owner)||pool.find(w=>w.deviceId===source?.machine&&w.online)||pool.find(w=>w.deviceId===source?.machine)||pool.find(w=>w.online)||pool[0];
  if(!worker)return {...plan,reply:'目前没有登记可接手这项只读查证的 Agent。',actions:[]};
  return {...plan,reply:'',actions:[{type:'consult',target:worker.target,sessionId:source?.machine===worker.deviceId?source.id:undefined,
    title:'查证并回答原问题',prompt:turn.text,evidence:turn.text}],criteria:plan.criteria};
}
