// Goal enrollment and notification consent come only from a paired user's own chat turn.
const segments=new Intl.Segmenter('zh',{granularity:'word'});
const filler=new Set('关注 目标 工作 完成 项目 计划 准备 进行 帮我 持续 跟进 追踪 我的 the and for goal track follow project'.split(' '));
const notifications='(?:目标推送|这个目标的推送|这个目标的通知)';
const following='(?:目标关注|关注这个目标)';
const actions=[
  ['enable','(?:开启|打开|启用)',notifications],
  ['preview','(?:暂停|关闭|关掉)',notifications],['preview','(?:切回|恢复)','(?:目标预览|预览模式)'],
  ['pause','暂停',following],['stop','(?:停止|结束|取消)',following]
];
const nativeCard=/^星舵操作 ([\w:-]{1,160}) v([1-9]\d{0,8}) (enable|pause|preview|stop)$/u;
const numbers={一:1,两:2,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
const horizon=/^(?:接下来|未来|接下来的|未来的|这)?(\d{1,3}|[一两二三四五六七八九十])(?:个)?(天|周|星期)[内里]?\s*[，,：: ]*/u;
const signals={result:/结果|交付|产出|评测|成果|results?/iu,decision:/决定|决策|拍板|确认选择|decisions?/iu,blocker:/阻塞|受阻|卡住|阻碍|阻挡|block(?:ed|ers?)/iu,progress:/一般进展|所有进展|每一步|每个进展|all progress/iu};
const tidy=s=>s.trim().replace(/^[「“『"]|[」”』"]$/gu,'').trim();
export function followIntent(text,{now=Date.now(),goalIds=[],titles=[]}={}){
  if(typeof text!=='string')return null;
  const words=text.trim().replace(/[。.!！?？]+$/u,'');
  const card=nativeCard.exec(words);
  if(card)return goalIds.includes(card[1])?{kind:'decision',id:card[1],version:Number(card[2]),decision:card[3]}:null;
  if(titles.length&&/^(?:先(?:别|不要|不用)(?:开|启用)推送[，, ]*)?(?:推送)?等我确认后再(?:开|开启)(?:推送)?$/u.test(words))return {kind:'hold'};
  for(const title of titles){
    const named=RegExp.escape(title);
    if(new RegExp('^重新核对[「“]?'+named+'[」”]?的(?:目标预览|进展)$','u').test(words))return {kind:'query',title,recheck:true};
    if(new RegExp('^(?:帮我看看|看看|查看)?[「“]?'+named+'[」”]?(?:这个目标)?(?:现在|目前|的)?(?:进度如何|进展如何|进展怎么样|进度怎么样|会提醒我什么|有哪些进展|做到哪一步了)$','u').test(words))
      return {kind:'query',title};
    if(new RegExp('^(?:我)?确认(?:给|为)[「“]?'+named+'[」”]?(?:开启|打开|开)推送$','u').test(words))
      return {kind:'decision',title,decision:'enable'};
  }
  for(const [decision,verb,object] of actions){
    const matched=new RegExp('^(?:请|帮我)?(?:我确认|确认|同意)?'+verb+'(?:[「“]([^」”]{1,120})[」”]的?)?'+object+'$','u').exec(words);
    if(matched)return {kind:'decision',decision,title:matched[1]??null};
  }
  if(/^(?:(?:帮我|给我)?(?:看看?|查看|列出|显示|预览))?(?:(?:目前|现在|当前|我的|这个|这些|所有|关注的)\s*)*目标(?:关注)?(?:预览|进展|进度|状态|有什么进展|会提醒我什么|有什么更新|到哪一步了|列表|的进展)(?:如何|怎么样|怎样|到哪了|有哪些|如何了|了吗|了)?$/u.test(words))return {kind:'query'};
  if(/^(?:看看|查看|显示|列出)(?:各个|每个|所有|各台设备的)\s*(?:agents?|智能体)\s*(?:在做什么|做到哪一步|的进度|的进展|的依据)(?:[，,、 ]*(?:依据是什么|依据|进度))?$/iu.test(words))return {kind:'activity'};
  if(/^(?:只关注|仅关注|只跟进|仅跟进)/u.test(words)&&/所选|选的|指定的|这两|这几/u.test(words))
    return {kind:'clarify',message:'请在看板上选定要关注的具体会话，再从这场对话告诉我目标。'};
  let body=words.replace(/^(?:请|麻烦)?(?:星舵[，, ]*)?/u,'');
  const time=horizon.exec(body);
  let until=null;
  if(time){
    const count=Number(time[1])||numbers[time[1]];
    if(count>0){until=new Date(now+count*(time[2]==='天'?1:7)*86400000).toISOString();body=body.slice(time[0].length);}
  }
  const first=body.split(/[。；;，,！!\n]/u)[0].trim();
  const direct=/^(?:(?:请)?(?:帮我|替我|我想(?:让你)?|我要你|请你|请|我希望你)?\s*(?:跨设备|持续|长期|跨机)?\s*(?:关注|跟进|追踪|跟踪|留意)|(?:我的|我这次的|我目前的)目标是|(?:track (?:my |the )?goal|my goal is)\s*[:：]?)\s*(.+)$/iu.exec(first);
  const focus=/^(.+?)是我(?:的|这段时间的|这(?:一|两)?周的|当前的|近期的)(?:重点|目标)$/u.exec(first);
  if(!direct&&!focus)return null;
  if(focus&&!time){
    const embedded=/是我这(一|两)?周的/u.exec(first);
    if(embedded)until=new Date(now+(embedded[1]==='两'?14:7)*86400000).toISOString();
  }
  const title=tidy((direct??focus)[1].replace(/(?:这个目标|这一目标|的进度|的进展)$/u,''));
  if(/^(?:一下|这(?:个|项)|该|那个|上述)?(?:目标|项目|工作|会话)?$/u.test(title)||title.length<2||title.length>140||/[？?]/u.test(first))
    return {kind:'clarify',message:'想持续跟进哪个具体目标？可以直接告诉我目标的名字。'};
  if(/(?:只在|仅在|只看|仅看|只关注|仅限|排除|除外|别看|不要看|选的|所选)(?:[^。；，,]{0,30})(?:设备|机器|会话|项目|电脑|目录)|(?:截至|截止到?|持续到|直到|未来\d+个?月)/u.test(body))
    return {kind:'clarify',message:'请先选定具体会话，或用“接下来两周，帮我关注……”指定时长，我会按这个范围预览。'};
  const terms=[...new Set([title,...Array.from(segments.segment(title.toLowerCase())).filter(s=>s.isWordLike&&s.segment.length>1&&!filler.has(s.segment)).map(s=>s.segment)])];
  const options=body.slice(first.length);
  const selected=Object.keys(signals).filter(s=>signals[s].test(options));
  // An unspecified alert filter uses the engine's default. Never infer a grant from future consent.
  const spec={title,terms,until};
  if(/(?:只在|遇到|出现|有(?:新|了)?(?:结果|进展)|需要我|遇阻|only when)/iu.test(options)){
    if(!selected.length)return {kind:'clarify',message:'你希望关注哪些变化？可以选择交付结果、需要决定、遇到阻塞或一般进展。'};
    spec.signals=selected;
  }
  return {kind:'register',spec};
}
export function resolveGoalChoice(intent,cards){
  if(intent.id)return {id:intent.id,version:intent.version,decision:intent.decision};
  const eligible=cards.filter(c=>(!intent.title||intent.title===c.title)&&c.actions.some(a=>a.decision===intent.decision));
  if(eligible.length!==1)return {error:eligible.length?'请在相应目标卡上选择，或说出具体目标的名字。':'没有符合这次操作的目标，请查看目标卡上的当前状态。'};
  return {id:eligible[0].id,version:eligible[0].version,decision:intent.decision};
}
