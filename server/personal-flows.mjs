// Durable dependencies for two-machine work and read-only scheduled reviews.
export class Flows {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS handoffs(first TEXT PRIMARY KEY, source TEXT, target TEXT, prompt TEXT, notify INTEGER, second TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, source TEXT, text TEXT, dueAt TEXT, intervalDays INTEGER, active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS review_events(id TEXT PRIMARY KEY, rule TEXT, source TEXT, text TEXT, state TEXT, retryAt INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0);`);
  }
  handoff(first,turn,a){
    this.db.prepare("INSERT OR IGNORE INTO handoffs VALUES(?,?,?,?,?,NULL,'waiting')").run(first,turn.id,a.to,a.second,a.notify?1:0);
  }
  async advance(broker){
    for(const f of this.db.prepare("SELECT first FROM handoffs WHERE state='stopping'").all()){
      await broker('/cancelByRequestId',{requestId:'handoff:'+f.first});
      await broker('/cancel',{id:f.first});
      const first=this.db.prepare('SELECT id FROM work_steps WHERE taskId=?').get(f.first);
      if(first)this.store.work.stopUnsubmitted(first.id+':next','cancelled','接力已取消');
      this.db.prepare("UPDATE handoffs SET state='stopped' WHERE first=? AND state='stopping'").run(f.first);
    }
    const waiting=this.db.prepare("SELECT * FROM handoffs WHERE state IN ('waiting','forwarding')").all();
    for(const flow of waiting){
      const task=await broker('/get',{id:flow.first});
      if(['queued','running'].includes(task.state))continue;
      if(!this.ownedFirst(flow.first))continue;
      if(task.state==='succeeded'&&task.attachment){
        const fenced=this.db.prepare("UPDATE handoffs SET state='forwarding' WHERE first=? AND state IN ('waiting','forwarding')").run(flow.first);
        if(!fenced.changes)continue;
        const next=await broker('/submit',{target:flow.target,prompt:flow.prompt,mode:'read-only',requestId:'handoff:'+flow.first,inputTaskId:flow.first});
        if(!this.ownedFirst(flow.first)){await broker('/cancel',{id:next.id});continue;}
        this.store.transact(()=>{
          const changed=this.db.prepare("UPDATE handoffs SET second=?,state='transferred' WHERE first=? AND state='forwarding'").run(next.id,flow.first);
          if(changed.changes){
            this.store.track(next.id,{id:flow.source},!!flow.notify);
            const first=this.db.prepare('SELECT id FROM work_steps WHERE taskId=?').get(flow.first);
            if(first)this.store.work.bind(first.id+':next',next);
          }
        });
      }else{
        this.store.transact(()=>{
          const first=this.db.prepare('SELECT id FROM work_steps WHERE taskId=?').get(flow.first);
          if(first)this.store.work.stopUnsubmitted(first.id+':next',task.state==='cancelled'?'cancelled':'interrupted','前序任务未提供可交接文件');
          else this.store.message('handoff-failure-'+flow.first,'assistant','第一步未交回可验证的文件，后续步骤已暂停。'+(task.state==='succeeded'?'':' 来源任务状态：'+task.state),flow.source,true);
          this.db.prepare("UPDATE handoffs SET state='stopped' WHERE first=?").run(flow.first);
        });
      }
    }
  }
  ownedFirst(id){return !!this.db.prepare("SELECT first FROM handoffs WHERE first=? AND state IN ('waiting','forwarding')").get(id);}
  stopFlow(id){return this.db.prepare("UPDATE handoffs SET state='stopping' WHERE first=? AND state IN ('waiting','forwarding','transferred','stopping')").run(id).changes>0;}
  addReview(id,turn,text,dueAt,days){
    this.db.prepare('INSERT OR IGNORE INTO reviews(id,source,text,dueAt,intervalDays) VALUES(?,?,?,?,?)').run(id,turn.id,text,dueAt,days);
  }
  listReviews(){return this.db.prepare("SELECT id,text,dueAt,intervalDays,'定期复查' AS status FROM reviews WHERE active=1").all();}
  close(id){
    this.db.prepare('UPDATE reviews SET active=0 WHERE id=?').run(id);
    this.db.prepare("UPDATE review_events SET state='stopped' WHERE rule=? AND state='new'").run(id);
  }
  wake(now=new Date()){
    this.store.transact(()=>{
      for(const rule of this.db.prepare('SELECT * FROM reviews WHERE active=1 AND dueAt<=?').all(now.toISOString())){
        const event=rule.id+'@'+rule.dueAt;
        this.db.prepare("INSERT OR IGNORE INTO review_events(id,rule,source,text,state) VALUES(?,?,?,?,'new')").run(event,rule.id,rule.source,rule.text);
        if(!rule.intervalDays){this.db.prepare('UPDATE reviews SET active=0 WHERE id=?').run(rule.id);continue;}
        const start=Date.parse(rule.dueAt),interval=rule.intervalDays*86400000;
        this.db.prepare('UPDATE reviews SET dueAt=? WHERE id=?').run(new Date(start+(Math.floor((now-start)/interval)+1)*interval).toISOString(),rule.id);
      }
    });
  }
  async processReview(planner,context){
    const event=this.db.prepare("SELECT * FROM review_events WHERE state='new' AND retryAt<=? ORDER BY rowid LIMIT 1").get(Date.now());
    if(!event)return;
    try{
      const snap=await context(event);
      const result=await planner.plan({...snap,currentUser:'这是已登记的到期复查：“'+event.text+'”。根据提供的最新上下文做一次简明汇报。只分析现有状态，actions 必须为空。若此规则要求仅在异常或有变化时联系，且没有支持该条件的证据，请仅回复 NO_UPDATE。'},{phase:'review'});
      if(!result.reply)throw Error('Empty review');
      this.store.transact(()=>{
        const fresh=this.db.prepare('SELECT state FROM review_events WHERE id=?').get(event.id);
        if(fresh.state!=='new')return;
        if(result.reply.trim()!=='NO_UPDATE')this.store.message('review-'+event.id,'assistant',result.reply,event.source,true);
        this.db.prepare("UPDATE review_events SET state='done' WHERE id=?").run(event.id);
      });
    }catch{
      if(event.attempts>=2){
        this.store.transact(()=>{
          this.store.message('review-error-'+event.id,'assistant','定时复查暂未取得模型结果：'+event.text,event.source,true);
          this.db.prepare("UPDATE review_events SET state='failed' WHERE id=? AND state='new'").run(event.id);
        });
      }else this.db.prepare('UPDATE review_events SET retryAt=?,attempts=attempts+1 WHERE id=?').run(Date.now()+60000,event.id);
    }
  }
}
