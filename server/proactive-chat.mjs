export function nativeCardChoice(text){
  if(typeof text!=='string')return null;
  const match=/^星舵操作 ([A-Za-z0-9:_-]{1,160}) v([1-9][0-9]{0,8}) (approve|ignore|recheck|pause|resume|cancel|enable|preview|stop)$/u.exec(text.trim());
  return match?{id:match[1],version:Number(match[2]),decision:match[3]}:null;
}
