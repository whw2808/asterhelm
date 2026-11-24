import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const digest=s=>createHash('sha256').update(String(s||'')).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
export class PhoneAuth{
  constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, expires INTEGER); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER)');}
  invite(now=Date.now()){
    const key=token();
    this.db.prepare('DELETE FROM invites WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('INSERT INTO invites VALUES(?,?)').run(digest(key),now+15*60000);return key;
  }
  redeem(key,now=Date.now()){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const hit=this.db.prepare('DELETE FROM invites WHERE hash=? AND expires>? RETURNING hash').get(digest(key),now);
      const session=hit?token():null;
      if(session)this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(session),now+90*86400000);
      this.db.exec('COMMIT');return session;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  valid(key,now=Date.now()){return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE hash=? AND expires>?').get(digest(key),now));}
  logout(key){this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(key));}
}
