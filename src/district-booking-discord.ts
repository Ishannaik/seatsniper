import { randomBytes } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction } from "discord.js";
import { DistrictStore, DistrictMcp, type ConnectionState } from "./district-mcp.ts";
import { DistrictBooking, type BookingReply } from "./district-booking.ts";
import { parseDistrictUrl as parseWatchUrl } from "./district.ts";
import { DistrictAlertStore, type SeatSuggestion } from "./district-alerts.ts";
import { getMonitorSession } from './monitor-runtime.ts';
import {renewalPhase,renewalComponents,renewalSuggestion,type HoldRenewal,type RenewalSend,type RenewalEdit} from './hold-renewal.ts';
const isDistrictEvent = (target: {eventCode: string}) => target.eventCode.startsWith("EV:");
const busy = new Set<string>();
let store: DistrictStore | undefined;
const clients = new Map<string, { state: ConnectionState; mcp: DistrictMcp }>();
function connectionFor(user:string) {
  store ??= new DistrictStore();
  let connection=clients.get(user);
  if(!connection){const state=store.read(user);connection={state,mcp:new DistrictMcp(state,()=>store!.save(user,state))};clients.set(user,connection)}
  return connection;
}
function activeHold(state:ConnectionState){return state.flow?.held&&(state.flow.holdExpiresAt??(state.flow.holdConfirmedAt??0)+600_000)>Date.now()}
export type HoldAlertPreview = {id:string;summary:string;expires:number}|{unavailable:string;quiet:boolean};
/** Preparation obtains consent text only. No confirmation ID is submitted here. */
export async function prepareHoldAlert(user:string,suggestion:SeatSuggestion):Promise<HoldAlertPreview> {
  if(user!==process.env.DISTRICT_BOOKING_OWNER_ID)throw Error('Invalid confirmation alert owner');
  if(busy.has(user))return {unavailable:'Another District request is in progress.',quiet:true};
  busy.add(user);
  try{return await prepareHoldDraft(user,suggestion)}finally{busy.delete(user)}
}
async function prepareHoldDraft(user:string,suggestion:SeatSuggestion,renewalFor?:string):Promise<HoldAlertPreview> {
    const {state,mcp}=connectionFor(user);
    if(!state.authenticated)return {unavailable:'Connect District privately using /book action:connect and /book action:verify to enable one-click hold confirmations.',quiet:false};
    if(state.pending||state.uncertain||state.flow?.paymentStarted||activeHold(state)||(!renewalFor&&state.flow?.renewal&&!state.flow.renewal.stopped))return {unavailable:'Finish the current confirmation or check your existing hold in District first.',quiet:true};
    if(renewalFor&&(!state.flow?.renewal||state.flow.renewal.nonce!==renewalFor||state.flow.renewal.stopped||state.flow.renewal.expiresAt>Date.now()))return {unavailable:'This renewal is no longer current.',quiet:true};
    const previousFlow=state.flow;
    const engine=new DistrictBooking(state,()=>store!.save(user,state),(name,args)=>mcp.call(name,args));
    const reply=await engine.alertHold(suggestion,()=>{});
    const pending=(state as ConnectionState).pending;
    if(!reply.confirmation||!pending)throw Error('District did not prepare an exact hold confirmation');
    const alerts=new DistrictAlertStore(),id=alerts.createPrepared(user,suggestion,state,Date.now(),renewalFor),expires=pending.expires;
    // Each alert keeps its own draft; no background preview overwrites another.
    state.flow=previousFlow;state.pending=undefined;store!.save(user,state);
    return {id,summary:reply.text,expires};
 }
/** Warn before expiry; prepare a replacement only after the exact seats are available. */
export async function processHoldExpiry(user:string,send:RenewalSend,edit:RenewalEdit):Promise<boolean> {
 if(user!==process.env.DISTRICT_BOOKING_OWNER_ID)throw Error('Invalid hold expiry owner');
 if(busy.has(user))return true;
 busy.add(user);
 try{
  const {state}=connectionFor(user),watch=state.flow?.renewal as HoldRenewal|undefined;
  if(!watch||watch.stopped||state.flow?.paymentStarted)return false;
  const phase=renewalPhase(watch);
  if(phase==='waiting')return true;
  const save=()=>store!.save(user,state);
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
  if(!suggestion){await publish(context+'\nThe hold expired. These same three seats are not currently available within ₹1,200 each. I’ll keep checking. No re-hold or payment was initiated.','unavailable');return true}
  const preview=await prepareHoldDraft(user,suggestion,watch.nonce);
  if('unavailable' in preview)return true;
  const footer=`\n\nNew hold only; no payment. Confirm before <t:${Math.floor(preview.expires/1000)}:R>.`;
  const text=preview.summary+footer;
  if(text.length>2000)throw Error('District renewal confirmation is too long for Discord');
  await publish(text,'ready',{id:preview.id,expires:preview.expires});return true;
 }finally{busy.delete(user)}
}
const help = "District booking (private DMs only):\n1. `/book action:connect` → SMS OTP, then `/book action:verify`.\n2. Movies: `/book action:shows link:<District movie> date:YYYY-MM-DD latitude:<search area> longitude:<search area>`.\n3. `/book action:seats show:1`, then `/book action:hold seats:F7,F8`.\n4. Read and approve District's hold confirmation. Choose `/book action:pay method:1`, then approve the exact amount and method.\n5. Complete UPI in your payment app; `/book action:status` checks the result.\nEvents: `/book action:event link:<District event>`, then `/book action:event_hold tickets:1:2`.\nNo payment or hold is approved automatically. Existing holds follow District's expiry timer.";
function buttons(reply: BookingReply) {
  if (reply.confirmation) return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(reply.confirmationKind==='payment'?"Confirm Payment":"Confirm exactly as shown").setCustomId(`district:yes:${reply.confirmation}`),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Cancel").setCustomId(`district:no:${reply.confirmation}`),
  )];
  const actions=(reply.actions??[]).slice(0,20);
  const rows:ActionRowBuilder<ButtonBuilder>[]=[];
  for(let i=0;i<actions.length;i+=5)rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actions.slice(i,i+5).map(a=>new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(a.label).setCustomId(a.id))));
  return rows;
}
export async function handleDistrictBooking(i: Interaction): Promise<boolean> {
  const command = i.isChatInputCommand() && i.commandName === "book";
  const modal = i.isModalSubmit() && i.customId.startsWith("district:");
  const button = i.isButton() && i.customId.startsWith("district:");
  if (!command && !modal && !button) return false;
  if (!(i.isChatInputCommand() || i.isModalSubmit() || i.isButton())) return false;
  const error = async (content: string) => { if (i.deferred || i.replied) await i.editReply({ content, components: [], allowedMentions: { parse: [] } }); else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); };
  if (i.guildId) { await error("Use /book in a private DM. Account connections and booking confirmations stay private."); return true; }
  if (!process.env.DISTRICT_BOOKING_OWNER_ID || i.user.id !== process.env.DISTRICT_BOOKING_OWNER_ID) { await error("Personal District booking is enabled only for this bot's configured owner."); return true; }
  const user = i.user.id;
  if (busy.has(user)) { await error("Your previous District request is still running. Please wait."); return true; }
  busy.add(user);
  try {
    if (command && i.isChatInputCommand()) {
      const action = i.options.getString("action", true);
      if (action === "connect" || action === "verify") {
        const field = new TextInputBuilder().setCustomId("value").setLabel(action === "connect" ? "District mobile number (10 digits, India)" : "SMS OTP from District").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(action === "connect" ? 10 : 4).setMaxLength(action === "connect" ? 10 : 8);
        await i.showModal(new ModalBuilder().setCustomId(`district:${action}`).setTitle(action === "connect" ? "Connect your District account" : "Verify District SMS code").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
        return true;
      }
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const connection=connectionFor(user);
    const { state, mcp } = connection;
    // Never reuse the owner's credentials for an independent inventory observation.
    const engine = new DistrictBooking(state, () => store!.save(user, state), (name, args) => mcp.call(name, args), (name, args) => {
      if(name!=='execute')throw Error('Independent verification is read-only');
      return getMonitorSession().read(args!.operation,args!.arguments);
    });
    let reply: BookingReply;
    if (i.isModalSubmit()) reply = i.customId === "district:connect" ? await engine.loginPhone(i.fields.getTextInputValue("value").trim()) : await engine.verify(i.fields.getTextInputValue("value").trim());
    else if (i.isButton()) {
      const [, action, nonce, index] = i.customId.split(":");
      if (!nonce) throw new Error("Unknown booking button.");
      if(action==="holdonly"){
        if(!state.authenticated)throw Error('Reconnect your District account before confirming a hold.');
        if(state.pending||state.uncertain||activeHold(state))throw Error('Finish the current confirmation or check your existing hold first. No new hold submitted.');
        const alerts=new DistrictAlertStore(),record=alerts.readPrepared(nonce,user);
        if(record.renewalFor&&(!state.flow?.renewal||state.flow.renewal.nonce!==record.renewalFor||state.flow.renewal.stopped||state.flow.renewal.expiresAt>Date.now()))throw Error('This renewal was stopped or belongs to an older hold.');
        if(!record.renewalFor&&state.flow?.renewal&&!state.flow.renewal.stopped)throw Error('Use your latest renewal alert or stop renewal alerts before choosing different seats.');
        const draft=alerts.claimPrepared(nonce,user),previousFlow=state.flow;
        state.flow=draft.flow;state.pending=draft.pending;store!.save(user,state);
        try{reply=await engine.confirmAlertHold(draft.suggestion,draft.pending.nonce)}
        catch(error){if(!state.uncertain){state.flow=previousFlow;state.pending=undefined;store!.save(user,state)}throw error}
        if(state.flow?.holdExpiresAt){
          const watch:HoldRenewal={nonce:randomBytes(16).toString('hex'),suggestion:draft.suggestion,expiresAt:state.flow.holdExpiresAt,stopped:false};
          state.flow.renewal=watch;store!.save(user,state);
          reply.text+='\nI’ll warn you near expiry and check these same seats for a fresh hold confirmation. Each new hold still needs your click.';
          reply.actions=[...(reply.actions??[]),{label:'Stop renewal alerts',id:`district:stoprenewal:${watch.nonce}`}];
        }
        if(i.message?.editable)await i.message.edit({components:[]}).catch(()=>{});
      } else if(action==="stoprenewal"){
        const watch=state.flow?.renewal as HoldRenewal|undefined;
        if(!watch||watch.nonce!==nonce)throw Error('This stop button belongs to an older hold.');
        watch.stopped=true;store!.save(user,state);
        reply={text:'Renewal alerts stopped for this hold. The current hold follows District’s expiry timer. No further re-hold confirmations will be prepared for it.'};
        if(i.message?.editable)await i.message.edit({components:[]}).catch(()=>{});
      } else if(action==="booknow"){
        const alerts=new DistrictAlertStore();
        reply=await engine.alertHold(alerts.read(nonce,user),()=>{alerts.claim(nonce,user)});
      } else if(action==="checkout")reply=await engine.continuePayment(nonce);
      else if(action==="method")reply=await engine.paymentButton(nonce,Number(index));
      else if(action==="status")reply=await engine.statusButton(nonce);
      else if(action==="yes")reply=await engine.confirm(nonce);
      else if(action==="no")reply=engine.cancel(nonce);
      else throw new Error("Unknown booking button.");
    } else {
      const action = i.options.getString("action", true);
      if (action === "help") reply = { text: help };
      else if (action === "shows" || action === "event") {
        const target = parseWatchUrl(i.options.getString("link", true));
        if (target.provider !== "district") throw new Error("/book currently supports District only.");
        if (action === "event") { if (!isDistrictEvent(target)) throw new Error("Use a District event link."); reply = await engine.event(target.slug); }
        else { if (isDistrictEvent(target)) throw new Error("Use action:event for an event link."); reply = await engine.shows(target.eventCode.slice(2), i.options.getString("date", true), i.options.getNumber("latitude", true), i.options.getNumber("longitude", true)); }
      } else if (action === "seats") reply = await engine.seats(i.options.getInteger("show", true));
      else if (action === "hold") reply = await engine.hold(i.options.getString("seats", true).split(",").map((s) => s.trim()).filter(Boolean));
      else if (action === "event_hold") reply = await engine.eventHold(i.options.getString("tickets", true));
      else if (action === "pay") reply = await engine.pay(i.options.getInteger("method", true));
      else if (action === "status") reply = await engine.status();
      else if (action === "disconnect") {
        store!.remove(user); clients.delete(user);
        reply = { text: "Local District connection removed. This does not cancel bookings or release holds; check District for any outstanding hold/payment." };
      } else throw new Error("Unknown action. Use /book action:help.");
    }
    await i.editReply({ content: reply.text.slice(0, 2000), components: buttons(reply), allowedMentions: { parse: [] } });
  } catch (e) {
    // Do not log interaction arguments, phone numbers, OTPs, tokens or cart contents.
    await error(e instanceof Error ? e.message.slice(0, 1900) : "District request failed. Check the app before retrying.").catch(() => {});
  } finally { busy.delete(user); }
  return true;
}
