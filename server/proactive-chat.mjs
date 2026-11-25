const commands={
  approve:/^(?:同意立项|立项|同意建立这项工作|把这件事立项|开始这件工作)$/,
  ignore:/^(?:忽略(?:这个|这条|该)?(?:事项|提案|候选)?|忽略这件事)$/,
  recheck:/^(?:再查(?:证)?一次|再核对一次)(?:[，, ]*(?:先别|暂不|不要)立项)?$/,
  pause:/^(?:暂停(?:这条|该)规则|暂停这个监视)$/,
  resume:/^(?:恢复(?:这条|该)规则|恢复这个监视)$/,
  cancel:/^(?:取消(?:这条|该)规则|停止这个监视)$/
};
export function cardChoice(text,cards,lastId=null){
  const raw=text.trim();
  if(raw.startsWith('星舵操作')){
    const match=/^星舵操作 ([A-Za-z0-9:_-]{1,160}) v([1-9][0-9]{0,8}) (approve|ignore|recheck|pause|resume|cancel)$/u.exec(raw);
    return match?{id:match[1],version:Number(match[2]),decision:match[3]}:{error:'卡片操作无效，请打开最新卡片。'};
  }
  const words=raw.replace(/[。！!]+$/u,'');
  const short=/^(?:可以|同意|好|好的|批准)$/.test(words);
  const decision=short?'approve':Object.keys(commands).find(key=>commands[key].test(words));
  if(!decision)return null;
  const eligible=cards.filter(c=>c.actions.some(a=>a.decision===decision));
  if(short&&!eligible.some(c=>c.messageId===lastId||c.reportMessageId===lastId))return null;
  if(eligible.length!==1)return short&&!eligible.length?null:{error:eligible.length?'有多张卡可以执行这个操作，请在对应卡片上选择。':'当前没有符合条件的卡片。'};
  return {id:eligible[0].id,version:eligible[0].version,decision};
}
