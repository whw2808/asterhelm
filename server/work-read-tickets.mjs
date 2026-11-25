import {randomBytes} from 'node:crypto';

// Hooks know their real thread. Give the model a short-lived read capability
// scoped to that thread and connector rather than accepting a guessed thread ID.
export class WorkReadTickets {
  constructor(now=Date.now){this.now=now;this.grants=new Map();}
  issue(machine,target,threadId){
    const now=this.now();
    for(const [key,g] of this.grants)if(g.until<=now)this.grants.delete(key);
    const ticket=randomBytes(24).toString('base64url');
    this.grants.set(ticket,{machine,target,threadId,until:now+300000});
    return ticket;
  }
  resolve(machine,target,ticket){
    const g=this.grants.get(ticket);
    if(!g||g.machine!==machine||g.target!==target||g.until<=this.now())return null;
    return g.threadId;
  }
}
