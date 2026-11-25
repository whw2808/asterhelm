// Unattended checks use only the evidence supplied by the coordinator.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

export function isolatedReader(cfg, adapter) {
  const options={cwd:cfg.state,env:{...process.env,...cfg.env},encoding:'utf8',timeout:10000};
  if(adapter==='codex'){
    const help=spawnSync(cfg.executable,['exec','--help'],options);
    if(help.status!==0||!help.stdout.includes('--ignore-user-config'))return null;
    return {args:['--ignore-user-config','--ignore-rules','-c','mcp_servers={}','-c','web_search="disabled"',
      ...['apps','plugins','hooks','multi_agent','unified_exec','shell_tool'].flatMap(name=>['--disable',name])]};
  }
  if(adapter!=='deepseek')return null;
  try{
    const yaml=createRequire(cfg.dshEntry)('js-yaml');
    const probe=spawnSync(cfg.executable,[cfg.dshEntry,'--profile','headless','--patch',cfg.dshPatch,'--dump-config'],
      {...options,maxBuffer:1500000});
    if(probe.status!==0)return null;
    const ids=[...probe.stdout.matchAll(/^- id: ([\w-]+)$/gm)].map(match=>match[1]);
    if(!ids.some(id=>id.startsWith('tool-')))return null;
    const disabled=ids.filter(id=>(id.startsWith('tool-')&&!id.startsWith('tool-executor-')&&id!=='tool-result-pruner')||id.includes('mcp')||id.startsWith('agent-instructions')||
      id.startsWith('session-persistence')||id==='session-projection-cache'||id.startsWith('session-query')||['session-log-deepseek','session-title-llm','session-telemetry-otel'].includes(id));
    return {patch(base){
      const output=path.join(cfg.state,'isolated-read.patch.yml');
      const entries=yaml.load(fs.readFileSync(base,'utf8'))||[];
      fs.writeFileSync(output,yaml.dump([...entries.filter(e=>!disabled.includes(e?.id)),...disabled.map(id=>({id,disabled:true}))]),{mode:0o600});
      return output;
    }};
  }catch{return null;}
}
