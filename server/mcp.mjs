import readline from 'node:readline';
import {call} from './control.mjs';
import packageInfo from '../package.json' with {type:'json'};
const string={type:'string'}, id={id:string};
const defs=[
  ['list_workers','/workers','Show configured workers, health and last heartbeat.',{},[]],
  ['submit_task','/submit','Queue the user’s goal on the selected machine. Each job gets a separate workspace. Reuse requestId when retrying the same submission. Return the task ID immediately.',{target:{type:'string',description:'Registered target ID returned by list_workers'},prompt:string,mode:{enum:['read-only','workspace-write']},requestId:string},['target','prompt','requestId']],
  ['list_tasks','/list','List recent tasks across registered devices.',{},[]],
  ['get_task','/get','Read progress and final answer for one task.',id,['id']],
  ['cancel_task','/cancel','Stop the specified task.',id,['id']]
];
const send=(id,body)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...body})+'\n');
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  let msg;try{msg=JSON.parse(line);}catch{continue;}
  if(msg.id==null)continue;
  try{
    let result;
    if(msg.method==='initialize')result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'asterhelm',version:packageInfo.version}};
    else if(msg.method==='ping')result={};
    else if(msg.method==='tools/list')result={tools:defs.map(([name,,description,properties,required])=>({
      name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
      annotations:{readOnlyHint:['list_workers','list_tasks','get_task'].includes(name),destructiveHint:name==='cancel_task',idempotentHint:true,openWorldHint:name==='submit_task'}
    }))};
    else if(msg.method==='tools/call'){
      const def=defs.find(([name])=>name===msg.params.name);
      if(!def)throw Error('Unknown tool');
      try{const value=await call(def[1],msg.params.arguments||{});result={content:[{type:'text',text:JSON.stringify(value)}]};}
      catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
    }else{send(msg.id,{error:{code:-32601,message:'Method not found'}});continue;}
    send(msg.id,{result});
  }catch(e){send(msg.id,{error:{code:-32602,message:e.message}});}
}
