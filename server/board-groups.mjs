export function groupBoard({workers,tasks,sessions,coverage}){
  const devices=new Map(),byTarget=new Map(),bySource=new Map();
  for(const worker of workers){
    if(!worker.deviceId)continue;
    const id=worker.deviceId;
    if(!devices.has(id))devices.set(id,{id,name:worker.deviceName,platform:worker.platform,formFactor:worker.formFactor??null,aliases:worker.deviceAliases??[],online:false,agents:[]});
    const machine=devices.get(id);
    machine.online ||= Boolean(worker.online);
    const agent={id:worker.target,name:worker.agentName,kind:worker.kind,aliases:worker.aliases??[],
      capabilities:worker.capabilities??[],worker,sessionsIndexed:false,tasks:[],sessions:[]};
    machine.agents.push(agent);
    byTarget.set(agent.id,agent);
    for(const source of worker.contextSources??[]){
      const key=id+'|'+source;
      if(!bySource.has(key)){bySource.set(key,agent);agent.sessionsIndexed=true;}
    }
  }
  for(const connector of coverage){
    const device=devices.get(connector.machine);
    if(device && connector.online)device.online=true;
  }
  const unassignedTasks=[],unassignedSessions=[];
  for(const task of tasks)(byTarget.get(task.target)?.tasks??unassignedTasks).push(task);
  for(const session of sessions)(bySource.get(session.machine+'|'+session.source)?.sessions??unassignedSessions).push(session);
  return {machines:[...devices.values()],unassignedTasks,unassignedSessions};
}
