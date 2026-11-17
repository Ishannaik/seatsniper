import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionState, Json } from './district-mcp.ts';
export type SeatSuggestion = { movie:string; cinema:string; session:string; date:string; showDateTime:string; screen:string; language:string; format:string; seats:string[]; price:number };
export type PreparedHold = { suggestion:SeatSuggestion; flow:Json; pending:Json; expires:number; renewalFor?:string };
export class DistrictAlertStore {
 constructor(readonly directory=join(process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor','book-now')){mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700)}
 private path(id:string){if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid alert button.');return join(this.directory,`${id}.json`)}
 create(owner:string,suggestion:SeatSuggestion,now=Date.now()):string {
  if(!/^\d+$/.test(owner))throw Error('Alert owner missing');
  const id=randomBytes(16).toString('hex');writeFileSync(this.path(id),JSON.stringify({owner,suggestion,expires:now+24*60*60*1000}),{mode:0o600,flag:'wx'});return id;
 }
 read(id:string,owner:string,now=Date.now()):SeatSuggestion{
  const path=this.path(id);if(!existsSync(path))throw Error('This Book Now button was already used or is unavailable. Check your current booking.');
  const d=JSON.parse(readFileSync(path,'utf8'));
  if(d.owner!==owner)throw Error('This alert belongs to a different user.');
  if(d.expires<=now||Date.parse(d.suggestion.showDateTime)<=now)throw Error('This alert expired. Refresh availability in District.');
  return d.suggestion;
 }
 claim(id:string,owner:string):SeatSuggestion{const suggestion=this.read(id,owner);try{renameSync(this.path(id),join(this.directory,`${id}.used.json`))}catch{throw Error('This alert is already being used. Check your current booking.')}return suggestion}
 createPrepared(owner:string,suggestion:SeatSuggestion,state:ConnectionState,now=Date.now(),renewalFor?:string):string {
  const p=state.pending;
  if(!p||p.stage!=='hold'||p.tool!=='act'||p.args?.operation!=='consumer.movie_set_seat'||p.expires<=now||!state.flow)throw Error('No valid hold-only confirmation prepared');
  this.prune(now);
  const id=this.create(owner,suggestion,now);
  // Store only the exact draft, never the owner's OAuth credentials.
  const d={owner,suggestion,kind:'hold-only',renewalFor,flow:state.flow,pending:p,expires:Math.min(p.expires,now+120_000)};
  writeFileSync(this.path(id),JSON.stringify(d),{mode:0o600});return id;
 }
 readPrepared(id:string,owner:string,now=Date.now()):PreparedHold {
  this.read(id,owner,now);const d=JSON.parse(readFileSync(this.path(id),'utf8'));
  if(d.kind!=='hold-only'||!d.pending||d.pending.expires<=now||d.pending.stage!=='hold'||d.pending.tool!=='act'||d.pending.args?.operation!=='consumer.movie_set_seat')throw Error('This hold-only confirmation is unavailable. Wait for a refreshed alert.');
  return d;
 }
 claimPrepared(id:string,owner:string):PreparedHold {
  const d=this.readPrepared(id,owner);this.claim(id,owner);
  writeFileSync(join(this.directory,`${id}.used.json`),JSON.stringify({owner,expires:d.expires,kind:'used'}),{mode:0o600});return d;
 }
 private prune(now:number) {
  for(const name of readdirSync(this.directory)){
   if(!/^[a-f0-9]{32}(\.used)?\.json$/.test(name))continue;
   const path=join(this.directory,name),d=JSON.parse(readFileSync(path,'utf8'));
   if(d.kind&&typeof d.expires==='number'&&d.expires<now-600_000)unlinkSync(path);
  }
 }
}
export function bookNowComponents(id:string){if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid alert id');return [{type:1,components:[{type:2,style:1,label:'Book Now',custom_id:`district:booknow:${id}`}]}]}
export function holdOnlyComponents(id:string){if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid alert id');return [{type:1,components:[{type:2,style:1,label:'Confirm Hold — No Payment',custom_id:`district:holdonly:${id}`}]}]}
