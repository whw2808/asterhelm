// One row per coordinator inference attempt. Store only accounting metadata.
const phases = ['chat','workWake','delivery','review'];
const metrics = ['inputTokens','outputTokens','totalTokens','cachedInputTokens','calls','reportedCalls',
  'unknownCalls','partialCalls','incompleteCalls','inputReportedCalls','outputReportedCalls','cachedReportedCalls','totalReportedCalls'];
const empty = () => Object.fromEntries(metrics.map(key=>[key,0]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export class TokenUsage {
  constructor(db, now=()=>new Date()) {
    this.db=db;
    this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS coordinator_usage(
      id INTEGER PRIMARY KEY, startedAt INTEGER NOT NULL, phase TEXT NOT NULL, model TEXT,
      inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, cachedInputTokens INTEGER,
      incomplete INTEGER NOT NULL DEFAULT 0)`);
    db.prepare("INSERT OR IGNORE INTO settings VALUES('tokenUsageSince',?)").run(now().toISOString());
    this.since=db.prepare("SELECT value FROM settings WHERE key='tokenUsageSince'").get().value;
    this.timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.begin=db.prepare('INSERT INTO coordinator_usage(startedAt,phase) VALUES(?,?)');
    this.receipt=db.prepare(`UPDATE coordinator_usage SET model=?,inputTokens=?,outputTokens=?,totalTokens=?,
      cachedInputTokens=?,incomplete=? WHERE id=?`);
    this.groups=db.prepare(`SELECT phase, startedAt>=? AS today, count(*) AS calls,
      coalesce(sum(inputTokens),0) AS inputTokens, coalesce(sum(outputTokens),0) AS outputTokens,
      coalesce(sum(totalTokens),0) AS totalTokens, coalesce(sum(cachedInputTokens),0) AS cachedInputTokens,
      count(inputTokens) AS inputReportedCalls, count(outputTokens) AS outputReportedCalls,
      count(cachedInputTokens) AS cachedReportedCalls, count(totalTokens) AS totalReportedCalls,
      sum(totalTokens IS NOT NULL AND NOT incomplete) AS reportedCalls,
      sum(totalTokens IS NULL OR incomplete) AS unknownCalls, sum(incomplete) AS incompleteCalls,
      sum(totalTokens IS NOT NULL AND NOT incomplete AND (inputTokens IS NULL OR outputTokens IS NULL)) AS partialCalls
      FROM coordinator_usage GROUP BY phase,today`);
  }
  wrap(planner) {
    if(!planner?.plan || planner.offline)return planner;
    return {plan:async(input,options={})=>{
      const stage=options.phase??input.phase;
      const phase=phases.includes(stage)?stage:'chat';
      // An interrupted or unreported request remains visible even across a restart.
      const id=this.begin.run(this.now().getTime(),phase).lastInsertRowid;
      this.cached=null;
      const onUsage=(usage={})=>{
        const inputTokens=count(usage.inputTokens), outputTokens=count(usage.outputTokens);
        const total=count(usage.totalTokens)??(inputTokens!==null && outputTokens!==null?count(inputTokens+outputTokens):null);
        try {
          this.receipt.run(typeof usage.model==='string'?usage.model.slice(0,180):null,inputTokens,outputTokens,
            total,count(usage.cachedInputTokens),Number(usage.incomplete===true),id);
          this.cached=null;
        } catch (error) {
          // The model has already run. Keep the original result and the outstanding receipt.
          console.error('Token usage receipt could not be saved:',error.code||error.name);
        }
      };
      return planner.plan(input,{onUsage});
    }};
  }
  summary() {
    const midnight=new Date(this.now()).setHours(0,0,0,0);
    const {data_version:version}=this.db.prepare('PRAGMA data_version').get();
    if(this.cached?.midnight===midnight && this.cached.version===version)return this.cached.value;
    const today=empty(),allTime=empty(),byPhase=new Map();
    for(const row of this.groups.all(midnight)){
      if(!byPhase.has(row.phase))byPhase.set(row.phase,{phase:row.phase,...empty()});
      for(const key of metrics){
        allTime[key]+=row[key];
        if(row.today)today[key]+=row[key];
        byPhase.get(row.phase)[key]+=row[key];
      }
    }
    const value={since:this.since,timeZone:this.timeZone,today,allTime,byPhase:phases.filter(p=>byPhase.has(p)).map(p=>byPhase.get(p))};
    this.cached={midnight,version,value};
    return value;
  }
}

export function isUsageQuestion(text) {
  if(typeof text!=='string')return false;
  const words=text.trim().toLowerCase().replace(/\s+/gu,'').replace(/[。？！?!]+$/u,'');
  return /^(?:请|帮我)?(?:看看|看下|查一下|查下|查看|查询)?(?:星舵|总控|你)?(?:的)?(?:今天|今日|累计|一共|总共)?(?:的)?(?:token用量(?:是多少|多少了|如何)?|(?:用|使用|消耗)了多少tokens?|tokens?用了多少)$/u.test(words)
    || /^(?:today['’]s|my|asterhelm)?tokenusage$/u.test(words);
}

export function usageAnswer(usage) {
  const fmt=n=>n.toLocaleString('zh-CN');
  const line=(label,b)=>{
    if(!b.calls)return label+'尚无模型调用。';
    const field=(key,reports)=>{
      if(!b[reports])return '未上报';
      return (b[reports]<b.calls || b.incompleteCalls?'至少 ':'')+fmt(b[key]);
    };
    const total=b.totalReportedCalls?(b.unknownCalls?'至少 ':'')+fmt(b.totalTokens)+' token':'总量未上报';
    let text=label+'已记录 '+total+'（输入 '+field('inputTokens','inputReportedCalls')+'，输出 '+field('outputTokens','outputReportedCalls')+'）。';
    if(b.unknownCalls)text+=' '+fmt(b.unknownCalls)+' 次调用缺少完整用量。';
    return text;
  };
  return [line('星舵今天',usage.today),line('累计',usage.allTime)].join('\n');
}
