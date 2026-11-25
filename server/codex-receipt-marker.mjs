import {idPattern} from './context-format.mjs';

export function isReceiptTurnInput(text,threadId) {
  if(typeof text!=='string'||typeof threadId!=='string'||!idPattern.test(threadId))return false;
  const lines=text.split('\n');
  const match=lines[1]?.match(/^\[Asterhelm receipt v1 ([a-f0-9-]{36}) ([a-f0-9-]{36})\]$/i);
  return lines[0]==='星舵 · 回执请求'&&match?.[1]===threadId&&idPattern.test(match[2])
    &&lines.at(-1)==='[Asterhelm sync '+match[2]+']';
}
