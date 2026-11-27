// Candidate retrieval only. The planner resolves these hints in context;
// names in quotations or examples cannot authorize or veto an operation.
const analysisRequest=/对比|比较|区别|差异|可行性|核对|查证|调研|分析|compare|research|verify|analyze/iu;
const standing=/每次|每当|工作日|每天|每周|whenever|every (?:time|weekday|day|week)/iu;
export function actor(worker){
  return {target:worker.target,deviceId:worker.deviceId,deviceName:worker.deviceName||worker.deviceId,agentName:worker.agentName||worker.target};
}
export function routeHints(text,workers=[]){
  const request=text.toLocaleLowerCase();
  return {possiblyAnalysis:analysisRequest.test(text),possiblyRecurring:standing.test(text),
    mentionedTargets:workers.filter(w=>[w.deviceId,w.deviceName,w.platform,w.target,w.agentName,
      ...(w.deviceAliases??[]),...(w.aliases??[]),...(w.scopedAliases??[])].some(label=>
      typeof label==='string'&&label.trim()&&request.includes(label.toLocaleLowerCase()))).map(w=>w.target)};
}
