import { randomBytes } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction } from "discord.js";
import { DistrictBooking, type BookingReply } from "./district-booking.ts";
import { parseDistrictUrl as parseWatchUrl } from "./district.ts";
import { DistrictAlertStore } from "./district-alerts.ts";
import { getMonitorSession } from './monitor-runtime.ts';
import type { HoldRenewal } from './hold-renewal.ts';
import { bookingSessions, activeHold } from './district-booking-application.ts';
export { prepareHoldAlert, processHoldExpiry, type HoldAlertPreview } from './district-booking-application.ts';
const isDistrictEvent = (target: {eventCode: string}) => target.eventCode.startsWith("EV:");
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
  if (!bookingSessions.tryAcquire(user)) { await error("Your previous District request is still running. Please wait."); return true; }
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
    const connection=bookingSessions.connectionFor(user);
    const { state, mcp } = connection;
    // Never reuse the owner's credentials for an independent inventory observation.
    const engine = new DistrictBooking(state, () => bookingSessions.save(user, state), (name, args) => mcp.call(name, args), (name, args) => {
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
        state.flow=draft.flow;state.pending=draft.pending;bookingSessions.save(user,state);
        try{reply=await engine.confirmAlertHold(draft.suggestion,draft.pending.nonce)}
        catch(error){if(!state.uncertain){state.flow=previousFlow;state.pending=undefined;bookingSessions.save(user,state)}throw error}
        if(state.flow?.holdExpiresAt){
          const watch:HoldRenewal={nonce:randomBytes(16).toString('hex'),suggestion:draft.suggestion,expiresAt:state.flow.holdExpiresAt,stopped:false};
          state.flow.renewal=watch;bookingSessions.save(user,state);
          reply.text+='\nI’ll warn you near expiry and check these same seats for a fresh hold confirmation. Each new hold still needs your click.';
          reply.actions=[...(reply.actions??[]),{label:'Stop renewal alerts',id:`district:stoprenewal:${watch.nonce}`}];
        }
        if(i.message?.editable)await i.message.edit({components:[]}).catch(()=>{});
      } else if(action==="stoprenewal"){
        const watch=state.flow?.renewal as HoldRenewal|undefined;
        if(!watch||watch.nonce!==nonce)throw Error('This stop button belongs to an older hold.');
        watch.stopped=true;bookingSessions.save(user,state);
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
        bookingSessions.remove(user);
        reply = { text: "Local District connection removed. This does not cancel bookings or release holds; check District for any outstanding hold/payment." };
      } else throw new Error("Unknown action. Use /book action:help.");
    }
    await i.editReply({ content: reply.text.slice(0, 2000), components: buttons(reply), allowedMentions: { parse: [] } });
  } catch (e) {
    // Do not log interaction arguments, phone numbers, OTPs, tokens or cart contents.
    await error(e instanceof Error ? e.message.slice(0, 1900) : "District request failed. Check the app before retrying.").catch(() => {});
  } finally { bookingSessions.release(user); }
  return true;
}
