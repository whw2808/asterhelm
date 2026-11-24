import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function safeDeviceId(value){
  return typeof value==='string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value);
}
const safeTarget=value=>typeof value==='string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value);
function requireValue(ok,message){if(!ok)throw Error(message);}
function label(value){
  requireValue(typeof value==='string' && value.trim() && value.length<=100 && !/[\u0000-\u001f\u007f]/.test(value),'Invalid registry label');
  return value.trim();
}
function labels(value=[]){
  requireValue(Array.isArray(value) && value.length<=24,'Invalid registry list');
  return [...new Set(value.map(label))];
}

export function projectAliasesFor(device,project){
  if(typeof project!=='string'||!project.trim())return [];
  const current=project.trim().replaceAll('\\','/').replace(/\/$/,'');
  return (device.projectAliases??[]).filter(entry=>{
    const scope=entry.project.replaceAll('\\','/').replace(/\/$/,'');
    const absolute=scope.startsWith('/')||/^[A-Za-z]:\//.test(scope);
    return current===scope||(absolute&&current.startsWith(scope+'/'));
  }).map(entry=>entry.alias);
}

const catalogFields=`d.deviceId,d.deviceName,d.platform,d.aliases AS deviceAliases,
  a.target,a.agentName,a.kind,a.aliases,a.capabilities,a.contextSources,a.registeredAt`;
const devicesAndAgents='FROM registered_devices d JOIN registered_agents a ON a.deviceId=d.deviceId';
function deviceCatalog(hasPresentation=true){return `SELECT ${catalogFields},h.observation AS hardware,
  ${hasPresentation?'p.formFactor':'NULL'} AS formFactor,
  (SELECT json_group_array(json_object('project',p.project,'alias',p.alias))
   FROM project_aliases p WHERE p.deviceId=d.deviceId) AS projectAliases
  ${devicesAndAgents} LEFT JOIN worker_hardware h ON h.target=a.target
  ${hasPresentation?'LEFT JOIN device_presentation p ON p.deviceId=d.deviceId':''}`;}
const catalogQuery=deviceCatalog();
const olderCatalogQuery=`SELECT ${catalogFields},NULL AS hardware,NULL AS formFactor,'[]' AS projectAliases ${devicesAndAgents}`;
function publicRow(row){
  return {...row,hardware:JSON.parse(row.hardware??'null'),
    ...Object.fromEntries(['aliases','deviceAliases','capabilities','contextSources','projectAliases'].map(key=>[key,JSON.parse(row[key])]))};
}

export class Registry{
  constructor(db,localDeviceId){
    this.db=db;this.localDeviceId=localDeviceId;
    db.exec(`CREATE TABLE IF NOT EXISTS registered_devices(deviceId TEXT PRIMARY KEY,principal TEXT NOT NULL UNIQUE,
      deviceName TEXT NOT NULL,platform TEXT NOT NULL,aliases TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registered_agents(target TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES registered_devices(deviceId),
      agentName TEXT NOT NULL,kind TEXT NOT NULL,aliases TEXT NOT NULL,capabilities TEXT NOT NULL,contextSources TEXT NOT NULL,registeredAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_hardware(target TEXT PRIMARY KEY REFERENCES registered_agents(target),observedAt TEXT NOT NULL,observation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_presentation(deviceId TEXT PRIMARY KEY REFERENCES registered_devices(deviceId),formFactor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_aliases(project TEXT COLLATE NOCASE NOT NULL,alias TEXT COLLATE NOCASE NOT NULL,deviceId TEXT NOT NULL,PRIMARY KEY(project,alias));
      CREATE INDEX IF NOT EXISTS project_aliases_device ON project_aliases(deviceId);`);
  }
  list(){return this.db.prepare(catalogQuery+' ORDER BY d.rowid,a.rowid').all().map(publicRow);}
  get(target){
    const row=this.db.prepare(catalogQuery+' WHERE a.target=?').get(target);
    requireValue(row,'Unknown worker');return publicRow(row);
  }
  deviceFor(principal){
    const device=this.db.prepare('SELECT deviceId FROM registered_devices WHERE principal=?').get(principal);
    if(device)return device.deviceId;
    const id=principal==='local'?this.localDeviceId:principal.startsWith('cert:')?principal.slice(5):null;
    requireValue(safeDeviceId(id),'Invalid device identity');return id;
  }
  authorizeDevice(principal,deviceId){
    requireValue(safeDeviceId(deviceId) && this.db.prepare('SELECT 1 FROM registered_devices WHERE deviceId=? AND principal=?').get(deviceId,principal),'Unregistered device or identity mismatch');
    return deviceId;
  }
  authorizeTarget(principal,target){
    const owns=this.db.prepare('SELECT 1 '+devicesAndAgents+' WHERE a.target=? AND d.principal=?');
    requireValue(typeof target==='string' && owns.get(target,principal),'Unregistered worker or identity mismatch');
    return target;
  }
  setProjectAliases(rows){
    requireValue(Array.isArray(rows) && rows.length<=2000,'Invalid project alias list');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.exec('DELETE FROM project_aliases');
      const add=this.db.prepare('INSERT INTO project_aliases VALUES(?,?,?)');
      for(const row of rows){
        requireValue(safeDeviceId(row.deviceId),'Invalid project alias device');
        requireValue(typeof row.project==='string' && row.project.trim() && row.project.length<=512 && !/[\u0000-\u001f\u007f]/.test(row.project),'Invalid project alias scope');
        add.run(row.project.trim(),label(row.alias),row.deviceId);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  recordHardware(principal,target,report){
    this.authorizeTarget(principal,target);
    const deviceId=this.get(target).deviceId;
    requireValue(report && report.subjectDeviceId===deviceId,'Inventory subject does not match the registered device');
    const fields=['subjectDeviceId','observedAt','scope','scopeSource','systemSource','platform','architecture','gpu'];
    requireValue(Object.keys(report).every(key=>fields.includes(key)),'Inventory provenance is assigned by the broker');
    const measured=Date.parse(report.observedAt);
    requireValue(Number.isFinite(measured) && measured<=Date.now()+300000,'Invalid observation time');
    const observedAt=new Date(measured).toISOString();
    const scopeSources={host:'launchd',container:'container-marker',unknown:'unclassified'};
    requireValue(Object.hasOwn(scopeSources,report.scope) && report.scopeSource===scopeSources[report.scope] && report.systemSource==='node:os','Invalid inventory evidence source');
    const platform=label(report.platform),architecture=label(report.architecture);
    requireValue(/^[a-z0-9_-]{1,32}$/i.test(platform) && /^[a-z0-9_-]{1,40}$/i.test(architecture),'Invalid operating system or architecture');
    requireValue(report.scope!=='host'||platform==='darwin','Host evidence requires the macOS launchd probe');
    requireValue(report.scope!=='container'||platform==='linux','Container evidence requires the Linux marker probe');
    const gpu=report.gpu;
    const source=platform==='darwin'?'system_profiler/SPDisplaysDataType':platform==='linux'?'nvidia-smi':'unavailable';
    requireValue(gpu && gpu.source===source && ['unknown','detected','none-visible'].includes(gpu.status),'Invalid GPU evidence source');
    requireValue(Array.isArray(gpu.devices) && gpu.devices.length<=32 && (gpu.status==='detected')===(gpu.devices.length>0),'Invalid GPU observations');
    requireValue(source!=='unavailable'||gpu.status==='unknown','Missing GPU probe');
    const observation={subjectDeviceId:deviceId,observedBy:target,observedAt,receivedAt:new Date().toISOString(),evidenceType:'authenticated-worker-probe',
      scope:report.scope,scopeSource:report.scopeSource,platform,architecture,systemSource:'node:os',
      gpu:{status:gpu.status,source,devices:gpu.devices.map(label),truncated:gpu.truncated===true}};
    this.db.prepare(`INSERT INTO worker_hardware VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET
      observation=excluded.observation,observedAt=excluded.observedAt WHERE excluded.observedAt>=worker_hardware.observedAt`)
      .run(target,observedAt,JSON.stringify(observation));
    return {ack:true};
  }
  register(principal,descriptor){
    requireValue(!['hardware','inventory','projectAliases'].some(key=>Object.hasOwn(descriptor,key)),'Inventory and project mappings require their own source');
    return this.store(principal,descriptor,false);
  }
  // Only called with private configuration loaded by the broker owner at startup.
  provision(principal,descriptor){
    return this.store(principal,descriptor,true);
  }
  store(principal,r,provisioned){
    requireValue(principal==='local' || principal.startsWith('cert:') && safeDeviceId(principal.slice(5)),'Invalid device identity');
    requireValue(safeDeviceId(r.deviceId) && safeTarget(r.target),'Invalid device or target ID');
    const current=this.db.prepare('SELECT principal FROM registered_devices WHERE deviceId=?').get(r.deviceId);
    requireValue(!current || current.principal===principal,'Device belongs to another identity');
    requireValue(provisioned || this.deviceFor(principal)===r.deviceId,'Device identity mismatch');
    const agent=this.db.prepare('SELECT deviceId FROM registered_agents WHERE target=?').get(r.target);
    requireValue(!agent || agent.deviceId===r.deviceId,'Target belongs to another device');
    requireValue(provisioned || agent || r.target===r.deviceId || r.target.startsWith(r.deviceId+'.'),'Use the device namespace for a new target');
    const deviceName=label(r.deviceName),platform=label(r.platform),agentName=label(r.agentName),kind=label(r.kind);
    const aliases=labels(r.aliases),deviceAliases=labels(r.deviceAliases),capabilities=labels(r.capabilities),contextSources=labels(r.contextSources);
    if(r.formFactor!==undefined)requireValue(['desktop','laptop','generic'].includes(r.formFactor),'Unsupported device form factor');
    requireValue(capabilities.includes('read-only')||capabilities.includes('workspace-write'),'Worker must declare a supported task mode');
    const others=this.db.prepare('SELECT contextSources FROM registered_agents WHERE deviceId=? AND target<>?').all(r.deviceId,r.target);
    for(const other of others){
      const assigned=JSON.parse(other.contextSources);
      requireValue(!contextSources.some(source=>assigned.includes(source)),'Context source already assigned on this device');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare(`INSERT INTO registered_devices VALUES(?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET
        deviceName=excluded.deviceName,platform=excluded.platform,aliases=excluded.aliases`)
        .run(r.deviceId,principal,deviceName,platform,JSON.stringify(deviceAliases));
      if(r.formFactor!==undefined){
        this.db.prepare('INSERT INTO device_presentation VALUES(?,?) ON CONFLICT(deviceId) DO UPDATE SET formFactor=excluded.formFactor').run(r.deviceId,r.formFactor);
      }
      this.db.prepare(`INSERT INTO registered_agents VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET
        agentName=excluded.agentName,kind=excluded.kind,aliases=excluded.aliases,capabilities=excluded.capabilities,contextSources=excluded.contextSources`)
        .run(r.target,r.deviceId,agentName,kind,JSON.stringify(aliases),JSON.stringify(capabilities),JSON.stringify(contextSources),new Date().toISOString());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.get(r.target);
  }
}

export function readRegistry(home){
  const file=path.join(home,'tasks.sqlite');
  if(!fs.existsSync(file))return [];
  const db=new DatabaseSync(file,{readOnly:true,timeout:2500});
  try{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    if(!tables.has('registered_agents'))return [];
    const query=tables.has('worker_hardware') && tables.has('project_aliases')?deviceCatalog(tables.has('device_presentation')):olderCatalogQuery;
    return db.prepare(query+' ORDER BY d.rowid,a.rowid').all().map(publicRow);
  }finally{db.close();}
}
