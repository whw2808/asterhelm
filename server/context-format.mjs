import {createHash} from 'node:crypto';

export const sources=['Codex Desktop','Codex CLI'];
export const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const maxEvidence=8;
export function contextDigest(row){return createHash('sha256').update(JSON.stringify(row)).digest('hex');}

const controls=/<(?:environment_context|developer|system|user_instructions|subagent_notification|send_user_message_question_reply|permissions instructions|app-context|skills_instructions|turn_aborted|user_action|command-message|local-command-stdout|sandbox_permissions|multi_agent_role|agent_system|collaboration_mode|INSTRUCTIONS)(?:\s|>)/i;
const sensitive=[
  /(?:密码|口令|助记词|配对码|验证码|(?:访问|刷新)令牌|密钥|私钥)|\b(?:password|passwd|passphrase|sshpass|seed phrase|recovery phrase|mnemonic phrase|access token|refresh token|pairing token|api[ _-]?key|client[ _-]?secret|personal access token)\b/i,
  /\b(?:pin|token|secret|credential)\b.{0,40}(?:\b(?:is|was|equals)\b|[:=：])\s*\S+/i,
  /-----BEGIN [^-\n]*(?:PRIVATE KEY|CERTIFICATE)|(?:Authorization|Set-Cookie|Cookie|Proxy-Authorization)\s*:/i,
  /(?:api[ _-]?key|access[ _-]?key|client[ _-]?secret|refresh[ _-]?token|access[ _-]?token|auth[ _-]?token|pass(?:word|wd|phrase)|secret|credential|pairing[ _-]?(?:code|token)|pin[ _-]?code|one[ -]time[ -]?(?:code|passcode)|密码|口令|秘钥|私钥|密钥|验证码|配对码|访问令牌)\s*(?:["']?\s*[:=：]|\s+is\b|\s+was\b|是|为|为：)/i,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|https?|rediss?|amqp):\/\/[^\s/@]+:[^\s/@]+@/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z\d+._/=-]{8,}/i,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|hf_|xox[baprs]-|npm_|AIza|AKIA|ASIA|glpat-|ya29\.|eyJ)[A-Za-z0-9_.-]{12,})/,
  /[?&#](?:token|key|code|auth|sig|secret|access_token|password|signature|x-amz-signature)=[^\s&#]+/i,
  /(?:^|[\s`"'=:(])(?=[A-Za-z0-9_+/=-]{32,}(?:[\s`"'.,;:!?)}\]]|$))(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{32,}/,
];
export function excerpt(value,limit){
  if(typeof value!=='string' || !value.trim() || controls.test(value) ||
    /(?:^|\n)(?:# AGENTS\.md instructions|\[?subagent_notification\]?|Message Type: (?:NEW_TASK|MESSAGE)|Chunk ID:|Original token count:|Tool calls? results?:)/i.test(value) ||
    sensitive.some(pattern=>pattern.test(value)))return '';
  const text=value.replace(/```[^]*?(?:```|$)/g,' [代码段] ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(text==='[代码段]')return '';
  const bounded=Array.from(text).slice(0,limit).join('').trimEnd();
  if(bounded==='[代码段]'||controls.test(bounded)||sensitive.some(pattern=>pattern.test(bounded)))return '';
  return bounded;
}

export function validRow(row){
  if(!row || !idPattern.test(row.id) || (typeof row.source!=='string' || !row.source.trim() || row.source.length>100 || row.source!==excerpt(row.source,100)) || row.readOnly!==true ||
     !['metadata-only','recent-dialogue'].includes(row.visibility) || !Array.isArray(row.evidence) ||
     row.evidence.length>maxEvidence || typeof row.archived!=='boolean' || !Number.isFinite(Date.parse(row.updatedAt)) ||
     !Number.isFinite(Date.parse(row.createdAt)) || !['unknown','completed','failed','interrupted','inProgress'].includes(row.status))return false;
  const fields=['id','title','cwd','source','summary','createdAt','updatedAt','status','lastMessageAt','sourceUpdatedAt','archived','visibility','readOnly','evidence'];
  if(Object.keys(row).some(k=>!fields.includes(k)))return false;
  for(const [k,len] of [['title',180],['cwd',512],['summary',1100]]){
    if(typeof row[k]!=='string'||Array.from(row[k]).length>len)return false;
  }
  return row.evidence.every(e=>e && Object.keys(e).every(k=>['role','text','at','turnId','itemId'].includes(k)) &&
    ['user','assistant'].includes(e.role) && typeof e.text==='string' && Array.from(e.text).length<=700 &&
    e.text===excerpt(e.text,700) && typeof e.turnId==='string' && e.turnId.length<=160 &&
    typeof e.itemId==='string' && e.itemId.length<=160 && Number.isFinite(Date.parse(e.at)));
}
