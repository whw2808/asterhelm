// Convert a calendar day and wall clock into an instant in the rule's own zone.
const dayMs=86400000;
function localClock(formatter,millis){
  const parts=Object.fromEntries(formatter.formatToParts(millis).map(p=>[p.type,Number(p.value)]));
  return Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
}
function toInstant(formatter,wall){
  const offsets=new Set([-dayMs,0,dayMs].map(delta=>localClock(formatter,wall+delta)-wall-delta));
  const options=[...offsets].map(offset=>wall-offset).sort((a,b)=>a-b);
  // First occurrence in a fold. In a gap, advance by the offset change.
  return options.find(t=>localClock(formatter,t)===wall)??options.at(-1);
}
export function nextCalendarTime({timeZone,dueAt,repeat},after){
  if(repeat==='once')return null;
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const anchor=localClock(formatter,Date.parse(dueAt));
  const today=localClock(formatter,after);
  const clock=anchor%dayMs,weekday=new Date(anchor).getUTCDay();
  let wall=Math.max(today-today%dayMs+clock,anchor);
  for(let i=0;i<9;i++,wall+=dayMs){
    const day=new Date(wall).getUTCDay();
    if(repeat==='weekly'&&day!==weekday||repeat==='weekdays'&&(day===0||day===6))continue;
    const instant=toInstant(formatter,wall);
    if(instant>after)return new Date(instant).toISOString();
  }
  throw Error('无法计算下个日历时点');
}
