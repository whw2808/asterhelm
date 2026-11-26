import {createHash} from 'node:crypto';
import {excerpt} from './context-format.mjs';

const day=86400000;
const clock=value=>value===undefined?Date.now():new Date(value).getTime();
const list=value=>Array.isArray(value)?value:[];
const stageLabels={
  request:'用户请求',report:'助手报告',result:'助手报告结果',blocker:'助手报告阻碍',
  decision:'已记录决定','decision-needed':'需要决定',available:'执行端在线',unavailable:'执行端离线',unknown:'状态未知',
  'turn-in-progress':'索引记录回合处理中','turn-completed':'索引记录回合结束','turn-failed':'索引记录回合失败','turn-interrupted':'索引记录回合中断',
  queued:'任务已入队',claimed:'执行端已领取',preparing_workspace:'准备工作区',running_executor:'运行执行器',
  collecting_result:'收集结果',sending_result:'发送结果',working:'执行端处理任务',
  succeeded:'收到完成回执',failed:'收到失败回执',interrupted:'收到中断回执',cancelled:'任务已撤回',
};
const heartbeatStages=new Set(['preparing_workspace','running_executor','collecting_result','sending_result','working']);
const terminal=new Set(['succeeded','failed','interrupted','cancelled']);
const turnStages={inProgress:'turn-in-progress',completed:'turn-completed',failed:'turn-failed',interrupted:'turn-interrupted'};

function withTime(fact,timestamp,now,maxAge=day){
  const ms=typeof timestamp==='string'?Date.parse(timestamp):NaN;
  if(!Number.isFinite(ms)||!Number.isFinite(now)||ms>now+60000)return null;
  return {...fact,stageLabel:stageLabels[fact.stage],at:new Date(ms).toISOString(),freshness:now-ms>maxAge?'stale':'recent'};
}

function coverageFor(worker,coverage){
  if(!worker.contextSources?.length)return 'unsupported';
  const machine=list(coverage).find(d=>d.machine===worker.deviceId);
  const sources=list(machine?.sources).filter(s=>s.target===worker.target&&worker.contextSources.includes(s.source));
  if(sources.some(s=>s.online))return 'online';
  if(sources.some(s=>s.lastSyncAt))return 'offline';
  return sources.length?'never':'unknown';
}

function registeredRow(worker,row){
  return row?.id && row.readOnly===true && row.machine===worker.deviceId && row.target===worker.target && worker.contextSources?.includes(row.source) && !row.archived;
}
function speakerLabel(row,role){
  return row.source+(role==='user'?' · 用户原话':' · 助手原话');
}

const generated=/(?:星舵\s*[·•]\s*(?:工作更新|已收悉|回执请求|目标预览|关注预览)|\[Asterhelm (?:sync|receipt)\b|^\s*>)/iu;
// Quoted notifications, product controls, and recovery reports describe another source.
const quoted=/^目标「[^」]{1,180}」\s*·|^goal (?:preview|notification|alert)\s*[:：]|(?:上次|之前|此前)(?:的)?(?:助手|原会话).{0,12}(?:说|回复)|\b(?:previous|earlier) (?:assistant|agent|report) (?:said|reported)\b/iu;
const controlPatterns=[
  /(?:星舵|Asterhelm).{0,100}(?:目标|关注|看板|提醒|跟进|索引|goal|preview|board)/iu,
  /(?:关注|跟踪|预览|跟进).{0,35}(?:这个目标|此目标|目标进展|会提醒|跨设备)|(?:通知|提醒|推送).{0,25}(?:开启|打开|预览)/u,
  /(?:找回|查找|定位|检索|查看|检查|转述|引用).{0,50}(?:原(?:始)?会话|原对话|会话索引|(?:Codex\s*)?对话.{0,45}(?:进度|最新))|(?:原会话|原对话).{0,50}(?:记录|指令|最新|回复)/iu,
  /\b(?:track|follow|watch|monitor)\b.{0,90}\b(?:goal|notify|alert|preview|updates?)\b/iu,
  /\b(?:preview|quote|recover|locate|find|summarize)\b.{0,65}\b(?:(?:earlier|original|previous) (?:chat|thread|conversation)|goal (?:preview|notification|alerts?))\b/iu,
];
const isControl=text=>controlPatterns.some(pattern=>pattern.test(text));
const blocked=/阻塞|阻碍|受阻|卡在|卡住|缺失|仍缺|尚缺|被拒|无法(?:继续|运行|完成|访问)|未能(?:完成|运行)|(?:验证|运行|检查|实验|测试)(?:失败|未通过|没有通过)|\b(?:blocked|blocking|stalled|missing|failed|no (?:tests?|checks?) passed|couldn.t complete|unable to (?:run|complete|proceed))\b/iu;
const resolvedBlocker=/\b(?:no longer|not) (?:blocked|stalled)|\b(?:zero|0) (?:checks? |tests? )?failed\b|(?:已解除|不再)(?:阻塞|受阻)|阻塞已解除/giu;
const decision=/我(?:们)?(?:已)?(?:决定|选定|选择采用)|决定(?:采用|保留|停止|继续|改用)|最终选定|\b(?:I|we) (?:have )?(?:decided|chose|selected|approved)\b/iu;
// Remove negated requests before looking for a still-open decision in the same sentence.
const closedDecision=/(?:不再|不|并非|如果|假如|若)(?:需要|等待)(?:你|用户)(?:来|的)?(?:选择|决定|确认|批准|拍板)|\b(?:no longer|not|never|doesn['’]t|does not)\s+(?:needs?|awaiting)\s+(?:your|user|owner)\s+(?:approval|decision)\b/giu;
const needsDecision=/(?:需要|请)(?:你|用户)(?:来)?(?:选择|决定|确认|批准|拍板)|等待(?:你|用户)(?:的)?(?:决定|批准|确认|拍板)|\b(?:needs? (?:your|owner) (?:decision|approval)|awaiting (?:your|user) (?:approval|decision))\b/iu;
const resultPatterns=[
  /跑完|已(?:经)?(?:完成|训完|验证|交付|生成|导出|修复|实现|训练|更新|测得|发布|通过)|(?:校验|核验|验证|生成|对比|比较|测量|测得|修复|复现|完成|确认|证明|训完|新增|下降|提高|升至|降至)了|实测|测得|实验结果|结果显示|误差为/u,
  /\b(?:completed|finished|calibrated|measured|stabilized|passed|reproduced|verified|exported|delivered|published|reduced|improved|generated|reached|achieved|returned|fixed|implemented|validated|tested)\b/iu,
];
const progress=/正在|已开始|已启动|处理中|运行中|排查中|进行中|\b(?:working on|started|checking|investigating|running|in progress|processing|under way)\b/iu;
const uncertain=[
  /如果|假如|预计|计划(?:.*)(?:完成|验证|通过|运行)|(?:接下来|下一步)(?:我|我们)?(?:会|将)|(?:我|我们)(?:打算|计划|会先|将会)/u,
  /(?:尚未|还未|还没|并未|不能确认)(?:.*?)(?:完成|验证|通过|测得|运行)/u,
  /\b(?:if (?:we|it|the)|(?:I|we) (?:will|plan to|intend to)|expected to|unverified)\b/iu,
  /\b(?:will|should|would|might|may|could|can) (?:still )?(?:be |have )?(?:completed|published|delivered|running|finished|verified|passed|improved|reduced)\b/iu,
  /\b(?:not|never|not yet|yet to) (?:been )?(?:complete[d]?|verify|verified|tested|passed|confirmed|finished)\b/iu,
];
function classify(line,role){
  if(role==='assistant'&&needsDecision.test(line.replace(closedDecision,'')))return {stage:'decision-needed',importance:'decision'};
  if(/[？?]\s*$/u.test(line)||uncertain.some(pattern=>pattern.test(line)))return null;
  if(decision.test(line))return {stage:'decision',importance:'decision'};
  if(role!=='assistant')return null;
  const remaining=line.replace(resolvedBlocker,'');
  if(blocked.test(remaining))return {stage:'blocker',importance:'blocker'};
  if(remaining!==line||resultPatterns.some(pattern=>pattern.test(line)))return {stage:'result',importance:'result'};
  if(progress.test(line))return {stage:'report',importance:'progress'};
  return null;
}

function visibleMessage(item){
  if(!['user','assistant'].includes(item?.role)||!item.itemId||generated.test(item.text))return '';
  const visible=excerpt(item.text,700);
  if(quoted.test(visible))return '';
  // Path/URL targets and Markdown decoration add no evidence to the excerpt.
  return visible.replace(/\[([^\]]+)\]\([^)]*\)/gu,'$1').replace(/\*\*|__|\x60/gu,'').trim();
}
function sentences(text){
  return text.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/u).map(s=>s.trim()).filter(Boolean);
}
function dialogue(row,item,text,classification,now){
  const stage=classification?.stage??(item.role==='user'?'request':'report');
  return withTime({sourceKind:'dialogue',sourceLabel:speakerLabel(row,item.role),sourceId:row.id,itemId:item.itemId,
    turnId:item.turnId,sessionTitle:excerpt(row.title,120),stage,certainty:item.role==='assistant'?'reported':stage==='request'?'requested':'observed',
    summary:excerpt(text,300),importance:classification?.importance??'progress'},item.at,now);
}

function sessionActivity(row,now){
  let latest=null;
  if(row.visibility==='recent-dialogue'){
    for(const item of list(row.evidence)){
      const text=visibleMessage(item);
      if(!text)continue;
      const classification=sentences(text).map(line=>classify(line,item.role)).find(Boolean);
      const event=dialogue(row,item,text,classification,now);
      if(event&&(!latest||event.at>latest.at))latest=event;
    }
  }
  const stage=turnStages[row.status];
  if(!stage || (latest&&row.status!=='inProgress'))return latest;
  const sessionTitle=excerpt(row.title,120);
  const status=withTime({stage,certainty:'observed',sourceKind:'session-status',sourceId:row.id,sourceLabel:row.source+' · 回合状态',
    sessionTitle,summary:stageLabels[stage]+(sessionTitle?' · '+sessionTitle:'')},row.sourceUpdatedAt??row.updatedAt,now,row.status==='inProgress'?120000:day);
  return !latest || (status && status.at>latest.at)?status:latest;
}

function taskLabel(task){
  const title=excerpt(task.workStep?.title,100);
  if(title)return title;
  if(task.mode==='read-only')return '只读任务';
  if(task.mode==='workspace-write')return '工作区写入任务';
  return '队列任务';
}

function taskTopic(task){
  // A read or consult receipt proves the inquiry was returned, not the work it asked about.
  if(task.mode!=='workspace-write'||task.workStep?.kind==='consult')return '';
  const instruction=task.title??task.prompt;
  const visible=excerpt(instruction,160);
  const retrospective=/只读|(?:查证|核对|回顾|汇总|转述).{0,28}(?:已有|此前|历史|进展|进度|会话|证据)|(?:已有|现有|既有|本机).{0,25}(?:记录|证据).{0,20}(?:回答|核对|说明)|用户问[：:]|\bread[- ]only\b|\b(?:report|summari[sz]e|review|look up)\b.{0,45}\b(?:previous|prior|historical|existing|progress|last week)\b/iu;
  if(isControl(visible)||generated.test(visible)||retrospective.test(visible))return '';
  const title=excerpt(task.workStep?.title,100);
  if(title)return title;
  // The broker list truncates prompts into a field called title. Long or multi-line
  // instructions are not a reliable subject for automatic cross-source matching.
  if(typeof instruction!=='string'||instruction.length>72||/[\r\n？?！!。]/u.test(instruction))return '';
  return visible;
}
function taskFact(worker,task,now){
  if(!task?.id||task.target!==worker.target)return null;
  const title=taskLabel(task);
  let stage,at,sourceKind='task-receipt',sourceLabel='任务回执',maxAge=day,importance='progress';
  if(terminal.has(task.state)){
    stage=task.state;at=task.finishedAt;
    importance=stage==='succeeded'?'result':'blocker';
    if(stage==='cancelled'){sourceKind='queue';sourceLabel='任务队列';}
  }else if(task.state==='running'){
    const beat=task.lastHeartbeatAt;
    stage=beat?(heartbeatStages.has(task.progress)?task.progress:'working'):'claimed';
    at=beat??task.startedAt;sourceLabel=beat?'执行端任务心跳':'任务领取记录';maxAge=120000;
  }else if(task.state==='queued'){
    stage='queued';at=task.created;sourceKind='queue';sourceLabel='任务队列';
  }else return null;
  const artifact=task.attachment;
  // The queue exposes this digest only after verifying and storing the actual bytes.
  const verified=stage==='succeeded' && Number.isSafeInteger(artifact?.size) && artifact.size>=0 && /^[a-f0-9]{64}$/u.test(artifact.sha256);
  const summary=stageLabels[stage]+(title?' · '+title:'')+
    (verified?' · 已核验附件 '+artifact.size+' 字节，SHA-256 '+artifact.sha256.slice(0,12)+'…':'');
  return withTime({stage,certainty:'observed',sourceKind,sourceLabel,sourceId:task.id,summary,importance},at,now,maxAge);
}

// Pure projection from the data already admitted by the registry, index and queue.
export function agentActivity({worker,rows=[],tasks=[],coverage=[],now}={}){
  if(!worker?.deviceId||!worker.target)return null;
  const time=clock(now),coverageStatus=coverageFor(worker,coverage);
  const candidates=list(tasks).map(task=>taskFact(worker,task,time)).filter(Boolean);
  const running=candidates.filter(f=>f.freshness==='recent'&&heartbeatStages.has(f.stage)).sort(newest)[0];
  const observed=running??candidates.concat(list(rows).filter(row=>registeredRow(worker,row)).map(row=>sessionActivity(row,time)).filter(Boolean)).sort(newest)[0];
  if(observed)return {...observed,coverageStatus};
  const stage=worker.online?'available':worker.seen?'unavailable':'unknown';
  const workerFact={stage,certainty:'observed',sourceKind:'worker',sourceLabel:'执行端心跳',sourceId:worker.target,summary:stageLabels[stage]};
  return {...(withTime(workerFact,worker.seen,time,45000)??{...workerFact,stage:'unknown',stageLabel:stageLabels.unknown,summary:stageLabels.unknown,
    certainty:'unknown',at:null,freshness:'unknown'}),coverageStatus};
}
function newest(a,b){return b.at.localeCompare(a.at);}

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set(('的 了 和 与 及 在 把 我 你 他 这 那 是 从 对 于 为 让 要 有 目标 关注 进展 项目 工作 结果 目前 最近 最新 跟进 跟踪 跨 设备 观察 提醒 查看 进度 任务 会话 这项 帮我 关于 '+
  'a an the for to by of and or on in my our this that is are be with about goal project track follow watch latest current progress work task results update updates status notification notify please me').split(' '));
function termsFor(goal){
  const terms=new Set();
  for(const raw of [goal.title,...list(goal.terms).slice(0,32)]){
    if(typeof raw!=='string')continue;
    const words=[...segmenter.segment(raw.slice(0,320).normalize('NFKC').toLowerCase())].filter(x=>x.isWordLike);
    for(let i=0;i<words.length;i++){
      let term=words[i].segment;
      // ICU may return two adjacent single Han characters for a compound.
      if(/^\p{Script=Han}$/u.test(term)&&/^\p{Script=Han}$/u.test(words[i+1]?.segment??'')&&words[i+1].index===words[i].index+1){
        term+=words[++i].segment;
      }
      if(term.length>=2&&term.length<=80&&!stop.has(term)&&!/^\d+$/u.test(term))terms.add(term);
    }
  }
  return [...terms].slice(0,40).map(term=>({term,match:new RegExp((/^[\da-z]/u.test(term)?'(?<![a-z0-9])':'')+
    RegExp.escape(term)+(/[a-z]$/u.test(term)?'(?=$|[^a-z0-9]|[0-9]+(?![a-z0-9]))':/\d$/u.test(term)?'(?![a-z0-9])':''),'iu')}));
}
function anchors(terms,text){
  const normalized=text.normalize('NFKC');
  const hits=terms.filter(entry=>entry.match.test(normalized));
  return hits.filter(entry=>!hits.some(other=>other.term.length>entry.term.length&&entry.match.test(other.term)));
}
function identity(worker){
  return {deviceId:worker.deviceId,deviceName:worker.deviceName||worker.deviceId,target:worker.target,agentName:worker.agentName||worker.target};
}
function factWithKey(worker,fact){
  const key=createHash('sha256').update(JSON.stringify([worker.target,fact.sourceKind,fact.sourceId,fact.turnId??null,fact.itemId??fact.stage])).digest('hex').slice(0,32);
  return {key,...identity(worker),...fact};
}
function exact(scope,row){
  return scope?.machine===row.machine&&scope.id===row.id&&(!scope.target||scope.target===row.target);
}
function sourceFindings(worker,row,goal,terms,contrasts,now,retracted){
  if(row.visibility!=='recent-dialogue'||!registeredRow(worker,row)||exact(goal.origin,row)||isControl(row.title))return [];
  const scoped=list(goal.scopes).length>0;
  if(scoped&&!goal.scopes.some(s=>exact(s,row)))return [];
  const items=list(row.evidence);
  const excludedTurns=new Set(items.filter(item=>generated.test(item.text)||isControl(item.text)).map(x=>x.turnId));
  const matches=[];
  for(const item of items){
    const text=visibleMessage(item);
    if(!text||excludedTurns.has(item.turnId)||isControl(text))continue;
    const hits=anchors(terms,text);
    if(!scoped){
      if(!hits.length)continue;
      const request=items.find(e=>e.role==='user'&&e.turnId&&e.turnId===item.turnId&&e!==item);
      const topical=anchors(terms,visibleMessage(request)||'');
      // A second anchor in the same message, or a corroborating request under a matching title.
      const titleHits=anchors(terms,row.title);
      const qualifiedTitle=contrasts.length&&contrasts.every(group=>group.some(t=>hits.includes(t)))&&titleHits.some(t=>!hits.includes(t));
      if(hits.length<2&&!qualifiedTitle&&!(topical.some(t=>!hits.includes(t))&&titleHits.length>=2))continue;
    }
    const parts=sentences(text);
    const candidates=parts.flatMap((line,i)=>{
      const kind=classify(line,item.role);
      if(!kind)return [];
      // A sibling's qualifier in another paragraph cannot attribute this reported step.
      if(!scoped&&contrasts.some(group=>!anchors(group,line).length))return [];
      const local=anchors(terms,line).length;
      if(!scoped && !local && !anchors(terms,[parts[i-1],parts[i+1]].filter(Boolean).join(' ')).length)return [];
      return [{line,i,kind,weight:(local?3:0)+(kind.importance==='progress'?0:2)}];
    }).sort((a,b)=>b.weight-a.weight);
    const best=candidates[0];
    if(!best){
      if(!scoped&&contrasts.length){
        const source={sourceKind:'dialogue',sourceId:row.id,turnId:item.turnId,itemId:item.itemId};
        retracted.push(factWithKey(worker,source).key);
      }
      continue;
    }
    const evidence=parts.slice(best.i,best.i+3).join(' ');
    const event=dialogue(row,item,evidence,best.kind,now);
    if(event)matches.push(factWithKey(worker,event));
  }
  return matches;
}

export function goalProjection({goal,otherGoals=[],rows=[],workers=[],tasks=[],now}={}){
  const retracted=[];
  if(!goal?.title || (goal.scopes!=null&&!Array.isArray(goal.scopes)))return {findings:[],retracted};
  const time=clock(now),terms=termsFor(goal),scoped=list(goal.scopes).length>0;
  if(!scoped&&terms.length<2)return {findings:[],retracted};
  const contrasts=[];
  for(const other of otherGoals){
    if(other.title===goal.title)continue;
    const theirs=new Set(termsFor(other).map(t=>t.term));
    const distinctive=terms.filter(t=>!theirs.has(t.term));
    const sharedCount=terms.length-distinctive.length;
    if(distinctive.length&&theirs.size>sharedCount&&sharedCount>=2)contrasts.push(distinctive);
  }
  const targets=new Map(list(workers).filter(w=>w?.deviceId&&w.target).map(w=>[w.target,w]));
  const found=[];
  for(const row of list(rows)){
    const worker=targets.get(row?.target);
    if(worker)found.push(...sourceFindings(worker,row,goal,terms,contrasts,time,retracted));
  }
  // A session grant cannot establish a link to a separately dispatched task.
  if(!scoped)for(const task of list(tasks)){
    const worker=targets.get(task?.target),title=task?taskTopic(task):'';
    if(!worker||!title||isControl(title)||generated.test(title)||anchors(terms,title).length<2||contrasts.some(group=>!anchors(group,title).length))continue;
    const event=taskFact(worker,task,time);
    if(event&&event.stage!=='queued')found.push(factWithKey(worker,event));
  }
  const keys=new Set(),agents=new Map();
  for(const fact of found.sort(newest)){
    if(keys.has(fact.key))continue;
    keys.add(fact.key);
    if(!agents.has(fact.target))agents.set(fact.target,[]);
    agents.get(fact.target).push(fact);
  }
  // Reserve a place for each agent before filling the remaining slots by recency.
  const latest=[...agents.values()].map(facts=>facts.shift());
  const remaining=[...agents.values()].flat().sort(newest);
  return {findings:latest.concat(remaining).slice(0,60).sort(newest),retracted};
}

export function goalFindings(input){return goalProjection(input).findings;}
