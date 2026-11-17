import {DistrictStore,DistrictMcp} from './district-mcp.ts';
import type {ConnectionState} from './district-state.ts';
import { DistrictBooking } from './district-booking.ts';
import {DistrictAlertStore} from './district-alerts.ts';
import type {SeatSuggestion} from './seat-suggestion.ts';
import { getMonitorSession } from './monitor-runtime.ts';
import { renewalPhase, renewalComponents, renewalSuggestion, type HoldRenewal, type RenewalSend, type RenewalEdit } from './hold-renewal.ts';
import { legacyPriceLabel } from './legacy-movie-policy.ts';

/** One session owner and lock shared by interactive actions and background previews. */
class BookingSessions {
  private busy = new Set<string>();
  private store?: DistrictStore;
  private clients = new Map<string, { state: ConnectionState; mcp: DistrictMcp }>();
  tryAcquire(user: string): boolean {
    if (this.busy.has(user)) return false;
    this.busy.add(user);
    return true;
  }
  release(user: string) { this.busy.delete(user); }
  connectionFor(user: string) {
    this.store ??= new DistrictStore();
    let connection = this.clients.get(user);
    if (!connection) {
      const state = this.store.read(user);
      connection = { state, mcp: new DistrictMcp(state, () => this.save(user, state)) };
      this.clients.set(user, connection);
    }
    return connection;
  }
  save(user: string, state: ConnectionState) {
    this.store ??= new DistrictStore();
    this.store.save(user, state);
  }
  remove(user: string) {
    this.store ??= new DistrictStore();
    this.store.remove(user);
    this.clients.delete(user);
  }
}
export const bookingSessions = new BookingSessions();

export function activeHold(state:ConnectionState){return state.flow?.held&&(state.flow.holdExpiresAt??(state.flow.holdConfirmedAt??0)+600_000)>Date.now()}
export type HoldAlertPreview = {id:string;summary:string;expires:number}|{unavailable:string;quiet:boolean};
/** Preparation obtains consent text only. No confirmation ID is submitted here. */
export async function prepareHoldAlert(user:string,suggestion:SeatSuggestion):Promise<HoldAlertPreview> {
  if(user!==process.env.DISTRICT_BOOKING_OWNER_ID)throw Error('Invalid confirmation alert owner');
  if(!bookingSessions.tryAcquire(user))return {unavailable:'Another District request is in progress.',quiet:true};
  try{return await prepareHoldDraft(user,suggestion)}finally{bookingSessions.release(user)}
}
async function prepareHoldDraft(user:string,suggestion:SeatSuggestion,renewalFor?:string):Promise<HoldAlertPreview> {
    const {state,mcp}=bookingSessions.connectionFor(user);
    if(!state.authenticated)return {unavailable:'Connect District privately using /book action:connect and /book action:verify to enable one-click hold confirmations.',quiet:false};
    if(state.pending||state.uncertain||state.flow?.paymentStarted||activeHold(state)||(!renewalFor&&state.flow?.renewal&&!state.flow.renewal.stopped))return {unavailable:'Finish the current confirmation or check your existing hold in District first.',quiet:true};
    if(renewalFor&&(!state.flow?.renewal||state.flow.renewal.nonce!==renewalFor||state.flow.renewal.stopped||state.flow.renewal.expiresAt>Date.now()))return {unavailable:'This renewal is no longer current.',quiet:true};
    const previousFlow=state.flow;
    const engine=new DistrictBooking(state,()=>bookingSessions.save(user,state),(name,args)=>mcp.call(name,args));
    const reply=await engine.alertHold(suggestion,()=>{});
    const pending=(state as ConnectionState).pending;
    if(!reply.confirmation||!pending)throw Error('District did not prepare an exact hold confirmation');
    const alerts=new DistrictAlertStore(),id=alerts.createPrepared(user,suggestion,state,Date.now(),renewalFor),expires=pending.expires;
    // Each alert keeps its own draft; no background preview overwrites another.
    state.flow=previousFlow;state.pending=undefined;bookingSessions.save(user,state);
    return {id,summary:reply.text,expires};
 }
/** Warn before expiry; prepare a replacement only after the exact seats are available. */
export async function processHoldExpiry(user:string,send:RenewalSend,edit:RenewalEdit):Promise<boolean> {
 if(user!==process.env.DISTRICT_BOOKING_OWNER_ID)throw Error('Invalid hold expiry owner');
 if(!bookingSessions.tryAcquire(user))return true;
 try{
  const {state}=bookingSessions.connectionFor(user),watch=state.flow?.renewal as HoldRenewal|undefined;
  if(!watch||watch.stopped||state.flow?.paymentStarted)return false;
  const phase=renewalPhase(watch);
  if(phase==='waiting')return true;
  const save=()=>bookingSessions.save(user,state);
  const context=`Same seats: ${watch.suggestion.seats.join(', ')} · ${watch.suggestion.date} · ${watch.suggestion.format} at Oberoi Mall PXL.`;
  const publish=async(text:string,status:string,prepared?:{id:string;expires:number},closed=false)=>{
   if(!prepared&&watch.lastStatus===status)return;
   const components=closed?[]:renewalComponents(watch.nonce,prepared?.id);
   const delivery=watch.delivery?await edit(watch.delivery,text,components):await send(text,components);
   watch.delivery=delivery??watch.delivery;watch.lastStatus=status;watch.warnedAt??=Date.now();watch.preview=prepared;save();
  };
  if(phase==='show-started'){watch.stopped=true;save();await publish(context+'\nThe show has started. Renewal alerts stopped.','show-started',undefined,true);return false}
  if(state.pending||state.uncertain||!state.authenticated){await publish(context+'\nExpiry monitoring needs attention: finish the pending request or check your District account. No re-hold or payment was initiated.','blocked');return true}
  if(phase==='warning'){
   await publish(`Your hold expires <t:${Math.floor(watch.expiresAt/1000)}:R>.\n${context}\nI’ll recheck these same three seats at expiry and enable a fresh confirmation if they are available. Every re-hold needs your click; no payment.`, 'warning');
   return true;
  }
  if(watch.preview&&watch.preview.expires>Date.now()+45_000)return true;
  const map=await getMonitorSession().read('consumer.movie_select_seat',{cinema_id:watch.suggestion.cinema,session_id:watch.suggestion.session});
  if(map.error||map.code||map.status==='error')throw Error('District renewal seat read failed');
  const suggestion=renewalSuggestion(watch.suggestion,state.flow!.map,map);
  if(!suggestion){await publish(context+`\nThe hold expired. These same three seats are not currently available within ₹${legacyPriceLabel()} each. I’ll keep checking. No re-hold or payment was initiated.`,'unavailable');return true}
  const preview=await prepareHoldDraft(user,suggestion,watch.nonce);
  if('unavailable' in preview)return true;
  const footer=`\n\nNew hold only; no payment. Confirm before <t:${Math.floor(preview.expires/1000)}:R>.`;
  const text=preview.summary+footer;
  if(text.length>2000)throw Error('District renewal confirmation is too long for Discord');
  await publish(text,'ready',{id:preview.id,expires:preview.expires});return true;
 }finally{bookingSessions.release(user)}
}
