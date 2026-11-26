import {sourceTerms} from './agent-evidence.mjs';

// The model selects a subject. This handler can only ask for clarification or
// record or pause an observation. No worker, wake or push grant is accepted.
const bounded=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const sameSource=(a,b)=>a&&b&&a.machine===b.machine&&a.id===b.id;
const fallback='你想持续了解哪个项目？可以告诉我项目名称，或指出对应的 Agent 会话。';
const observationActions=new Set(['follow_goal','dismiss_follow','pause_follow']);
const hasFollowAction=proposal=>proposal.actions?.some(a=>observationActions.has(a?.type));
const fields=new Set(['type','evidence','question','goalId','source','title','terms','signals','until']);

const normalized=name=>name.normalize('NFKC').trim().toLocaleLowerCase();
export function subjectConflict(plan,snap){
  const a=plan.actions?.length===1?plan.actions[0]:null;
  if(a?.type!=='follow_goal'||!a.goalId||a.question)return false;
  const goal=snap.follow?.candidates.find(g=>g.id===a.goalId);
  if(!goal)return true;
  if(a.title&&(!bounded(a.title,140)||normalized(a.title)!==normalized(goal.title)))return true;
  // An existing card cannot adopt another subject merely because it is the
  // only candidate. Require a name, a bound source, or a conversational link.
  const linked=snap.follow.focus?.id===goal.id||sameSource(a.source,goal.subjectSource)||
    goal.scopes.some(s=>sameSource(s,a.source));
  if(linked)return false;
  const names=[snap.currentUser,snap.follow.pending?.request,...(snap.history??[]).filter(m=>m.role==='user').slice(-2).map(m=>m.text)];
  return !names.some(name=>name&&normalized(name).includes(normalized(goal.title)));
}

export class FollowRouting{
  constructor(store,goals){
    this.store=store;
    this.goals=goals;
    store.db.exec(`CREATE TABLE IF NOT EXISTS follow_dialogue(
      scope TEXT PRIMARY KEY,requestId TEXT NOT NULL,lastTurn TEXT NOT NULL,goalId TEXT,question TEXT)`);
  }
  context(scope='main'){
    const db=this.store.db;
    const row=db.prepare(`SELECT d.*,m.text AS request FROM follow_dialogue d JOIN messages m ON m.id=d.requestId AND m.role='user'
      WHERE d.scope=? AND NOT EXISTS(SELECT 1 FROM memory_exclusions WHERE id IN (d.requestId,d.lastTurn))`).get(scope);
    const candidates=db.prepare(`SELECT id,status,version,spec FROM follow_goals WHERE status IN ('preview','enabled','paused')
      AND (untilAt IS NULL OR untilAt>?) ORDER BY rowid DESC`).all(Date.now()).map(r=>{
      const {title,terms,scopes,subjectSource}=JSON.parse(r.spec);
      return {id:r.id,status:r.status,version:r.version,title,terms,scopes,...(subjectSource?{subjectSource}:{})};
    }).filter(g=>scope==='main'?!g.scopes.length:g.scopes.some(s=>scope===JSON.stringify([s.machine,s.id])));
    return {candidates,pending:row?.question?{requestId:row.requestId,request:row.request,question:row.question}:null,
      focus:row?.goalId?candidates.find(g=>g.id===row.goalId)??null:null};
  }
  clear(scope){
    this.store.db.prepare('DELETE FROM follow_dialogue WHERE scope=?').run(scope);
  }
  handle(turn,proposal,snap,{scope='main',selected=null}={}){
    const actions=proposal.actions??[];
    const pending=snap.follow.pending;
    if(!hasFollowAction(proposal)&&!pending&&!['focusedFollow','selectedFollow'].includes(snap.phase))return null;
    const apply=()=>{
      const remember=(goalId,question)=>{
        this.store.db.prepare('INSERT OR REPLACE INTO follow_dialogue VALUES(?,?,?,?,?)')
          .run(scope,pending?.requestId??turn.id,turn.id,goalId,question);
      };
      const ask=(question=fallback)=>{
        if(pending||hasFollowAction(proposal))remember(null,question);
        this.store.finish(turn,question);
        return {};
      };
      if(actions.length!==1)return ask(pending?.question);
      const [a]=actions;
      if(!a||!bounded(a.evidence,16000)||!turn.text.includes(a.evidence))return ask(pending?.question);
      if(a.type==='dismiss_follow'&&pending&&Object.keys(a).every(k=>['type','evidence'].includes(k))){
        this.clear(scope);
        this.store.finish(turn,'已撤回刚才等待补充的跟进请求。');
        return {};
      }
      if(a.type==='pause_follow'&&Object.keys(a).every(k=>['type','goalId','evidence'].includes(k))){
        const goal=snap.follow.candidates.find(c=>c.id===a.goalId);
        const current=goal&&this.goals.get(goal.id);
        if(!current||goal.version!==current.version||!current.actions.some(item=>item.decision==='pause'))return ask();
        this.goals.decide(turn,{id:goal.id,version:goal.version,decision:'pause'});
        this.clear(scope);
        this.store.finish(turn,'已暂停跟进「'+goal.title+'」。');
        return {};
      }
      if(a.type!=='follow_goal'||Object.keys(a).some(k=>!fields.has(k)))return ask(pending?.question);
      if(a.question)return ask(bounded(a.question,220)?a.question:fallback);
      if(subjectConflict(proposal,snap))return ask();
      const matches=snap.follow.candidates.filter(c=>a.goalId?c.id===a.goalId:
        bounded(a.title,140)&&normalized(c.title)===normalized(a.title));
      if(matches.length>1)return ask();
      const [known]=matches;
      const requestedSource=a.source??known?.subjectSource;
      const source=requestedSource?snap.sessions.find(s=>sameSource(s,requestedSource)&&s.target):selected;
      if(a.source&&!source||selected&&(!sameSource(source,selected)||!selected.target))return ask();
      if(source&&!selected&&!snap.workers.some(w=>w.deviceId===source.machine&&w.target===source.target))return ask();
      const candidate=known&&this.goals.get(known.id);
      if(known&&(!candidate||candidate.version!==known.version||candidate.status==='stopped'))return ask();
      if(candidate?.status==='paused'){
        this.store.finish(turn,'「'+candidate.title+'」已暂停。可以在原卡片上选择恢复预览。');
        return {};
      }
      const title=known?.title??a.title??source?.title;
      if(!bounded(title,140))return ask();
      // A registered goal or session supplies its own identity. For a new
      // unindexed topic require a name from the user's request, not model prose.
      const evidence=[turn.text,pending?.request,source?.title,source?.summary,known?.title,
        ...(source?.evidence??[]).map(e=>e.text),...(snap.history??[]).filter(m=>m.role==='user').slice(-3).map(m=>m.text)].filter(Boolean);
      const contains=word=>evidence.some(line=>line.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
      if(!known&&!contains(title))return ask();
      const terms=a.terms??[];
      if(!Array.isArray(terms)||terms.length>10||terms.some(t=>!bounded(t,100)))return ask();
      const signals=a.signals??[];
      if(!Array.isArray(signals)||signals.some(s=>!['result','decision','blocker','progress'].includes(s)))return ask();
      if(a.until!=null&&(!bounded(a.until,50)||!/(Z|[+-]\d\d:\d\d)$/iu.test(a.until)||!(Date.parse(a.until)>Date.now())))return ask();
      const ref=source?{machine:source.machine,id:source.id,target:source.target}:null;
      const qualifiers=(pending||known&&snap.follow.focus?.id===known.id)&&source?sourceTerms(turn.text,source):[];
      const spec={title,terms:[...new Set([title,...terms.filter(contains),...qualifiers])],signals,until:a.until??null,
        scopes:selected?[ref]:[],...(ref?{subjectSource:ref}:{})};
      const card=known?this.goals.refine(turn,known,spec):this.goals.register(turn,spec);
      remember(card.id,null);
      const receipt=card.messageId===turn.id?'已开始跟进「'+card.title+'」，当前仅预览。':
        '「'+card.title+'」已在原目标卡持续跟进（'+(card.status==='enabled'?'推送已开启':'仅预览')+'）。';
      this.store.finish(turn,receipt);
      return card.status==='preview'?{previewId:card.id}:{};
    };
    return this.store.db.isTransaction?apply():this.store.transact(apply);
  }
}
