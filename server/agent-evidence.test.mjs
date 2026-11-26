import test from 'node:test';
import assert from 'node:assert/strict';
import {agentActivity,goalFindings} from './agent-evidence.mjs';

const now=Date.parse('2026-01-08T12:00:00Z');
const stamp=(offset=0)=>new Date(now+offset).toISOString();
const worker={deviceId:'garden',deviceName:'Garden',target:'garden.editor',agentName:'Editor',contextSources:['Codex Desktop'],online:true,status:'ready',seen:stamp()};
const goal={title:'Glacier pollen calibration',terms:['glacier','pollen','calibration']};
const message=(text,role='assistant',offset=-1000,itemId='item-1')=>({role,text,at:stamp(offset),itemId,turnId:'turn-a'});
const session=(evidence,values={})=>({id:'00000000-0000-4000-8000-000000000001',machine:'garden',target:'garden.editor',source:'Codex Desktop',title:'Glacier pollen calibration',visibility:'recent-dialogue',readOnly:true,updatedAt:stamp(),sourceUpdatedAt:stamp(),status:'completed',archived:false,evidence,...values});
const activity=(rows=[],tasks=[],opts={})=>agentActivity({worker,rows,tasks,coverage:[],now,...opts});
const findings=(rows=[],tasks=[],opts={})=>goalFindings({goal,rows,tasks,workers:[worker],coverage:[],now,...opts});

// Attribution for an observed turn, messages and the task runtime is intentionally different.
test('a request and an assistant result each retain the speaker and actual message time',()=>{
  const request=message('Please calibrate the pollen sensor.','user',-4000);
  const ask=activity([session([request])]);
  assert.equal(ask.certainty,'requested');assert.equal(ask.at,request.at);assert.equal(ask.stage,'request');
  const report=message('Glacier pollen calibration passed all 18 checks.');
  const reply=activity([session([request,report])]);
  assert.equal(reply.certainty,'reported');assert.equal(reply.sourceKind,'dialogue');assert.equal(reply.itemId,'item-1');
  assert.match(reply.summary,/18 checks/);assert.equal(reply.at,report.at);
});

test('active turn metadata records the source timestamp and never promotes old status to a live run',()=>{
  const old=stamp(-3*86400000);
  const run=activity([session([],{status:'inProgress',sourceUpdatedAt:old,updatedAt:stamp(),visibility:'metadata-only'})]);
  assert.equal(run.at,old);assert.equal(run.sourceKind,'session-status');assert.equal(run.freshness,'stale');
  assert.equal(run.stage,'turn-in-progress');
});

test('running executor evidence requires a recent task heartbeat; a claim identifies only the claim',()=>{
  const task={id:'task-A',target:worker.target,title:'Measure pollen baseline',state:'running',progress:'running_executor',created:stamp(-9000),updated:stamp(),startedAt:stamp(-7000)};
  const claimed=activity([], [task]);
  assert.equal(claimed.stage,'claimed');assert.equal(claimed.at,task.startedAt);
  const receipt=activity([session([message('I will start checking soon.')])],[{...task,lastHeartbeatAt:stamp(-2000)}]);
  assert.equal(receipt.sourceKind,'task-receipt');assert.equal(receipt.stage,'running_executor');assert.equal(receipt.at,stamp(-2000));
  assert.equal(receipt.certainty,'observed');assert.equal(receipt.sourceId,'task-A');
  const missing=activity([], [{...task,startedAt:null}]);
  assert.equal(missing.sourceKind,'worker');
});

test('unsupported indexing and worker presence are disclosed even when no task exists',()=>{
  const unsupported=activity([session([message('unrelated private notes')])],[],{worker:{...worker,contextSources:[]}});
  assert.equal(unsupported.sourceKind,'worker');assert.equal(unsupported.coverageStatus,'unsupported');
  assert.equal(unsupported.stage,'available');assert.doesNotMatch(unsupported.summary,/private/);
  assert.equal(findings([session([message('Glacier pollen calibration passed 18 tests.')])],[],{workers:[]}).length,0);
});

test('goal results require substantive local evidence, including from active sessions',()=>{
  const evidence=message('We calibrated the glacier pollen sampler. The pollen baseline stabilized at 14 ppm.');
  const row=session([evidence],{status:'inProgress'});
  const [fact]=findings([row]);
  assert.equal(fact.sourceId,row.id);assert.equal(fact.itemId,evidence.itemId);assert.equal(fact.at,evidence.at);
  assert.equal(fact.certainty,'reported');assert.equal(fact.deviceId,'garden');assert.equal(fact.target,worker.target);
  assert.equal(fact.importance,'result');assert.match(fact.summary,/14 ppm|calibrated/);
  assert.equal(findings([row],[],{now:now+50000})[0].key,fact.key);
  assert.deepEqual(findings([session([message('All 18 tests passed.')])]),[]);
  assert.deepEqual(findings([session([message('Use Glacier as the next calendar theme.','user')])]),[]);
});

test('an exact selected source admits its substantive observations only within that source',()=>{
  const a=session([message('Reviewed the inventory. All 16 measurements passed.')]);
  const b={...a,machine:'meadow',target:'meadow.editor'};
  const registered=[worker,{...worker,deviceId:'meadow',target:'meadow.editor'}];
  const scoped={title:'Audit',scopes:[{machine:'garden',id:a.id,target:worker.target}]};
  assert.deepEqual(findings([a,b],[],{workers:registered,goal:scoped}).map(x=>x.deviceId),['garden']);
  assert.deepEqual(findings([a,b],[],{workers:registered,goal:{...scoped,scopes:[{machine:'garden'}]}}),[]);
  assert.deepEqual(findings([a,b],[],{workers:registered,goal:{...scoped,origin:{machine:'garden',id:a.id}}}),[]);
});

test('goal titles, questions, echoed previews and control turns never create milestones',()=>{
  const example='Glacier pollen calibration passed 12 measurement checks.';
  for(const row of [session([]), session([message('Glacier pollen calibration')]),
    session([message('Have all glacier pollen calibration tests passed?','user')]),
    session([message('星舵 · 工作更新 '+example)]),session([message('> '+example)]),
    session([message('Track glacier pollen calibration and notify me about each result.','user'),message(example)]),
    session([message(example)],{source:'Unregistered Reader'}),session([message(example)],{visibility:'metadata-only'}),
  ])assert.deepEqual(findings([row]),[]);
});

test('Chinese findings preserve decision and blocker evidence; weak/overlapping terms cannot auto-link',()=>{
  const options={goal:{title:'湿地花粉校准'}};
  const first=session([message('我决定采用湿地花粉样本作为对照组。','user')]);
  const second=session([message('湿地花粉校准仍被缺失的对照样本阻塞。')]);
  assert.equal(findings([first],[],options)[0].importance,'decision');
  assert.equal(findings([second],[],options)[0].importance,'blocker');
  const one={goal:{title:'Garden',terms:['garden','Garden']}};
  assert.deepEqual(findings([session([message('Garden passed every test.')])],[],one),[]);
});

test('terminal task receipt confirms the broker event without verifying text or inventing missing evidence',()=>{
  const task={id:'task-1',target:worker.target,mode:'workspace-write',title:'Glacier pollen calibration',state:'succeeded',finishedAt:stamp(-3000),updated:stamp(),result:'I measured 14 ppm.'};
  const [fact]=findings([], [task]);
  assert.equal(fact.sourceKind,'task-receipt');assert.equal(fact.at,task.finishedAt);assert.equal(fact.certainty,'observed');
  assert.equal(fact.importance,'result');assert.doesNotMatch(fact.summary,/14 ppm/);
  assert.deepEqual(findings([], [{...task,finishedAt:null}]),[]);
});

test('rendered goal notifications and quoted reports cannot become new evidence',()=>{
  const report='Glacier pollen calibration passed 12 checks.';
  for(const text of ['目标「Glacier pollen calibration」 · Garden / Editor '+report,
    'Goal preview: '+report,'The previous assistant said: “'+report+'”']){
    assert.deepEqual(findings([session([message(text)])]),[]);
  }
});

test('conditional, negated and quoted outcomes cannot promote a goal to a result',()=>{
  for(const text of ['Glacier pollen calibration will be completed tomorrow.',
    'We have not verified the glacier pollen calibration.',
    'Glacier pollen calibration should be running once approved.']){
    assert.ok(findings([session([message(text)])]).every(f=>f.importance!=='result'));
  }
});

test('invalid grants fail closed and read-only context boundaries are enforced',()=>{
  const row=session([message('Glacier pollen calibration passed all 12 tests.')]);
  assert.deepEqual(findings([row],[],{goal:{...goal,scopes:{id:row.id}}}),[]);
  assert.deepEqual(findings([{...row,readOnly:false}]),[]);
});

test('recurring display text in different turns retains distinct traceable identities',()=>{
  const a=message('Glacier pollen calibration passed all 12 tests.');
  const b={...a,turnId:'turn-b',at:stamp()};
  const facts=findings([session([a,b])]);
  assert.deepEqual(facts.map(f=>f.turnId),['turn-b','turn-a']);
});

test('nested text anchors are one piece of evidence and a busy device cannot hide another device',()=>{
  const tablet={...worker,deviceId:'ridge',target:'ridge.editor'};
  const ambiguous=session([message('The archive_v2 export passed all checks.')]);
  assert.deepEqual(findings([ambiguous],[],{goal:{title:'archive_v2',terms:['archive']}}),[]);
  const busy=Array.from({length:85},(_,i)=>session([message('Glacier pollen calibration passed 19 checks.')],{id:'garden-'+i}));
  const quiet=session([message('Glacier pollen calibration passed 11 checks.','assistant',-2000)],{machine:'ridge',target:'ridge.editor'});
  const found=findings([...busy,quiet],[],{workers:[worker,tablet]});
  assert.ok(found.some(f=>f.target==='ridge.editor'));assert.ok(found.length<=60);
});

test('failed checks stay blockers and planned or unverified outcomes stay out of result notices',()=>{
  const options={goal:{title:'湿地花粉校准'}};
  for(const line of ['湿地花粉校准还没完成。','湿地花粉校准并未完成。','湿地花粉校准预计明天完成。','计划完成湿地花粉校准。',
    '湿地花粉校准计划在明天验证通过后再发布。']){
    assert.ok(findings([session([message(line)])],[],options).every(f=>f.importance!=='result'),line);
  }
  for(const line of ['湿地花粉校准测试没有通过。','湿地花粉校准验证失败了。']){
    assert.equal(findings([session([message(line)])],[],options)[0]?.importance,'blocker',line);
  }
  for(const line of ['Glacier pollen calibration did not complete.','Glacier pollen calibration has not yet been verified.',
    'The glacier pollen calibration remains unverified; no tests passed.','Glacier pollen calibration is expected to be completed tomorrow.']){
    assert.ok(findings([session([message(line)])]).every(f=>f.importance!=='result'),line);
  }
  assert.equal(findings([session([message('Glacier pollen calibration failed 3 checks.')])])[0]?.importance,'blocker');
});

test('the broker-validated attachment is separate evidence from an executor’s report',()=>{
  const task={id:'task-2',target:worker.target,title:'Glacier pollen calibration',state:'succeeded',finishedAt:stamp(),attachment:{size:47,sha256:'ab'.repeat(32)},result:'Claims 100 percent accuracy.'};
  const fact=activity([], [task]);
  assert.match(fact.summary,/47 字节/);assert.match(fact.summary,/abababababab/);assert.doesNotMatch(fact.summary,/accuracy/);
  assert.doesNotMatch(activity([], [{...task,attachment:{size:47,sha256:'not verified'}}]).summary,/47 字节/);
});

test('resolved blockers and zero failed checks are not new blockers',()=>{
  for(const line of ['Glacier pollen calibration checks passed, 0 failed.',
    'Glacier pollen calibration is no longer blocked.','湿地花粉校准已解除阻塞。']){
    const opts=line.startsWith('湿地')?{goal:{title:'湿地花粉校准'}}:{};
    assert.ok(findings([session([message(line)])],[],opts).every(f=>f.importance!=='blocker'),line);
  }
});

test('goal matching excludes retrospective receipts and consults regardless of matching instruction text or worker state',()=>{
  const task={id:'follow-up',target:worker.target,state:'succeeded',finishedAt:stamp(),mode:'read-only'};
  const requests=[
    {prompt:'Read-only check. Based on existing local records, report whether Glacier pollen calibration was completed; do not modify any files.'},
    {title:'Glacier pollen calibration: summarize last week’s results from the device records.',workStep:{kind:'dispatch',title:'回顾进度'}},
    {title:'只读核对，不修改文件。用户问：湿地花粉校准完成了吗？请根据本机已有记录回答。'},
    {title:'Glacier pollen calibration',mode:'workspace-write',workStep:{kind:'consult',title:'Review Glacier pollen calibration'}},
    {title:'Glacier pollen calibration',mode:'read-only',workStep:{kind:'dispatch',title:'Glacier pollen calibration report'}},
    {title:'Glacier pollen calibration',mode:null}
  ];
  for(const datum of requests){
    const row={...task,...datum};
    const opts=(row.title??'').includes('湿地')?{goal:{title:'湿地花粉校准'}}:{};
    assert.deepEqual(findings([], [row],opts),[]);
  }
});

test('board evidence uses the local work step title or a short task label without exposing instruction fragments',()=>{
  const prompt='Review the wetland pollen ledger and compare all previous results from the calibration notebooks. Private instructions follow here.';
  const task={id:'inquiry',target:worker.target,state:'succeeded',finishedAt:stamp(),mode:'read-only'};
  for(const variant of [{title:prompt},{prompt}, {prompt,workStep:{kind:'consult',title:'复核校准记录'}}]){
    const fact=activity([], [{...task,...variant}]);
    assert.equal(fact.sourceKind,'task-receipt');assert.doesNotMatch(fact.summary,/ledger|Private instructions/);
    if(variant.workStep)assert.match(fact.summary,/复核校准记录/);
  }
});
