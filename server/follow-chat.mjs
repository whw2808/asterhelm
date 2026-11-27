// Offline mode can serve existing account information using local query shortcuts.
import {isUsageQuestion} from './token-usage.mjs';

export function offlineQuery(text,titles){
  if(typeof text!=='string')return null;
  if(isUsageQuestion(text))return {query:'usage'};
  const words=text.trim().replace(/[。.!！?？]+$/u,'');
  for(const title of titles){
    const named=RegExp.escape(title);
    if(new RegExp('^重新核对[「“]?'+named+'[」”]?的(?:目标预览|进展)$','u').test(words))return {query:'goals',title};
    if(new RegExp('^(?:帮我看看|看看|查看)?[「“]?'+named+'[」”]?(?:这个目标)?(?:现在|目前|的)?(?:进度如何|进展如何|进展怎么样|进度怎么样|会提醒我什么|有哪些进展|做到哪一步了)$','u').test(words))
      return {query:'goals',title};
  }
  if(/^(?:(?:帮我|给我)?(?:看看?|查看|列出|显示|预览))?(?:(?:目前|现在|当前|我的|这个|这些|所有|关注的)\s*)*目标(?:关注)?(?:预览|进展|进度|状态|有什么进展|会提醒我什么|有什么更新|到哪一步了|列表|的进展)(?:如何|怎么样|怎样|到哪了|有哪些|如何了|了吗|了)?$/u.test(words))return {query:'goals'};
  if(/^(?:看看|查看|显示|列出)(?:各个|每个|所有|各台设备的)\s*(?:agents?|智能体)\s*(?:在做什么|做到哪一步|的进度|的进展|的依据)(?:[，,、 ]*(?:依据是什么|依据|进度))?$/iu.test(words))return {query:'activity'};
  return null;
}
