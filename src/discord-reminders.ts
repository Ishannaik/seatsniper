/** Owner-requested DM reminders. Never copies consent buttons or submits booking actions. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {HttpError} from './http-error.ts';
import type {Json} from './json.ts';
import {sendDiscord,type DiscordDelivery,type AlertSender} from './discord-delivery.ts';
type Notice={channel:string;message:string;expires:number;key:string};
type State={pending:Notice[];dismissed:string[];nextAt:number;failures:number};
export const reminderIntervalMs=500;
import {classifySeatNotice,reminderStopId} from './alert-notice.ts';
export {reminderStopId} from './alert-notice.ts';
export const reminderControls:Json[]=[{type:1,components:[{type:2,style:2,label:'Stop alerts',custom_id:reminderStopId}]}];
export class DiscordReminders {
 private state:State;private path:string;private busy=false;private generation=0;
 constructor(directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor',private now=Date.now){
  mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'discord-reminders.json');
  this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{pending:[],dismissed:[],nextAt:0,failures:0};
 }
 observe(delivery:DiscordDelivery,content:string,components:Json[]){
  const notice=classifySeatNotice(components,content);
  const key=`${delivery.message}:${notice.reminderKind}`;
  const expires=notice.expires;
  this.state.pending=this.state.pending.filter(n=>n.message!==delivery.message);
  if(notice.holdReady&&expires>this.now()&&!this.state.dismissed.includes(key)){
   this.state.pending.push({...delivery,key,expires});
   if(!this.state.nextAt)this.state.nextAt=this.now()+reminderIntervalMs;
  }
  this.save();
 }
 observePvrListing(delivery:DiscordDelivery|undefined){
  this.state.pending=this.state.pending.filter(n=>!n.key.endsWith(':pvr'));
  if(delivery){const key=delivery.message+':pvr';if(!this.state.dismissed.includes(key)){
   this.state.pending.push({...delivery,key,expires:this.now()+75_000});
   if(!this.state.nextAt)this.state.nextAt=this.now()+reminderIntervalMs;
  }}
  this.save();
 }
 acknowledge(){
  this.generation++;this.state.dismissed=[...new Set([...this.state.dismissed,...this.state.pending.map(n=>n.key)])].slice(-200);
  this.state.pending=[];this.state.nextAt=0;this.state.failures=0;this.save();
 }
 async step(send:AlertSender){
  if(this.busy)return;
  const hadPending=this.state.pending.length>0;
  this.state.pending=this.state.pending.filter(n=>n.expires>this.now());
  if(!this.state.pending.length){if(hadPending||this.state.nextAt){this.state.nextAt=0;this.save()}return}
  if(this.now()<this.state.nextAt)return;
  this.busy=true;const generation=this.generation;
  // Reserve the next slot before sending: restarting never causes a burst.
  this.state.nextAt=this.now()+reminderIntervalMs;this.save();
  const links=this.state.pending.slice(-4).map(n=>`https://discord.com/channels/@me/${n.channel}/${n.message}`).join('\n');
  try{
   await send(`SeatSniper reminder: a seat or PVR listing alert is waiting for your attention. Open the current alert below and review its latest details. Availability can change; no hold or payment happens automatically.\n${links}\nReply here, confirm a hold, or press Stop alerts to stop these reminders.`,reminderControls);
   if(generation===this.generation){this.state.failures=0;this.save()}
  }catch(error){
   if(generation!==this.generation)return;
   const e=error as {status?:number;retryAfterMs?:number};
   if(e.status===401||e.status===403||e.status===404)this.acknowledge();
   else {this.state.failures++;this.state.nextAt=this.now()+(e.status===429?Math.max(reminderIntervalMs,e.retryAfterMs||60_000):Math.max(60_000*Math.min(16,2**this.state.failures),e.retryAfterMs??0));this.save()}
   console.error('Discord reminder delayed or stopped; no booking action retried');
  }finally{this.busy=false}
 }
 private save(){writeFileSync(this.path+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
}

/** Cache the DM channel and pause from server rate headers before exhausting its bucket.
 * Leave the last reported message slot for fresh seat alerts. No retry queue.
 */
export function createReminderSender(request:typeof fetch=fetch,now=Date.now):AlertSender {
 let channel:Json|undefined,blockedUntil=0;
 const guarded=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=String(input),dm=url.endsWith('/users/@me/channels');
  if(dm&&channel)return Response.json(channel);
  if(now()<blockedUntil)throw new HttpError(429,new Headers({'Retry-After':String((blockedUntil-now())/1000)}),'Discord reminder');
  const response=await request(input,init);
  const reset=Number(response.headers.get('x-ratelimit-reset-after'))*1000;
  const remaining=response.headers.get('x-ratelimit-remaining');
  if(remaining!==null&&Number(remaining)<=1&&Number.isFinite(reset)&&reset>0)blockedUntil=Math.max(blockedUntil,now()+reset+250);
  if(response.status===429){
   const body=await response.clone().json().catch(()=>({})) as Json;
   const retry=Math.max(Number(response.headers.get('retry-after'))||0,Number(body.retry_after)||0)*1000;
   blockedUntil=Math.max(blockedUntil,now()+(retry||60_000));
   throw new HttpError(429,new Headers({'Retry-After':String((blockedUntil-now())/1000)}),'Discord reminder');
  }
  if(dm&&response.ok)channel=await response.clone().json() as Json;
  return response;
 }) as typeof fetch;
 return (content,components)=>sendDiscord(content,components,guarded);
}
