/** Cloud Gateway receiver for Book Now, /book login, and explicit confirmations. */
import { Client, GatewayIntentBits, MessageFlags, Partials, Routes } from 'discord.js';
import { handleDistrictBooking } from './district-booking-discord.ts';
import { createMonitorPoller,sendDiscord,editDiscord } from './doomsday-monitor.ts';
import type {DiscordVoiceAlerts} from './discord-voice-alerts.ts';
import {DiscordReminders,reminderStopId,createReminderSender} from './discord-reminders.ts';
import {createPvrPoller} from './pvr-monitor.ts';
import {dmWatchHelp,dmSlashText} from './dm-watches.ts';
import {UserDmWatches} from './user-dm-watches.ts';
const dmWatches=new UserDmWatches();
const legacyDoomsday=process.env.LEGACY_DOOMSDAY_ENABLED==='true';
const reminders=new DiscordReminders();
const sendReminder=createReminderSender();
const token=process.env.DISCORD_TOKEN;
if(!token)throw Error('DISCORD_TOKEN missing');
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.DirectMessages],partials:[Partials.Channel]});
let voice:DiscordVoiceAlerts|undefined;
let voiceButtons=(components:import('./district-mcp.ts').Json[])=>components;
try{const module=await import('./discord-voice-alerts.ts');const target=module.voiceTarget();if(target){voice=new module.DiscordVoiceAlerts(client,target);voiceButtons=module.withVoiceStop}}catch{console.error('Voice alert setup unavailable; text monitoring continues.')}
const poller=createMonitorPoller(undefined,async(content,components=[])=>{
 components=voiceButtons(components);const receipt=await sendDiscord(content,components);reminders.observe(receipt,content,components);void voice?.alert(receipt.message,components).catch(()=>{});return receipt;
},async(delivery,content,components)=>{
 components=voiceButtons(components);const receipt=await editDiscord(delivery,content,components);reminders.observe(receipt,content,components);void voice?.alert(receipt.message,components).catch(()=>{});return receipt;
});
const pvrPoller=createPvrPoller(sendDiscord,d=>reminders.observePvrListing(d));
let dmWatchTimer:ReturnType<typeof setTimeout>|undefined;
let pvrTimer:ReturnType<typeof setTimeout>|undefined;
let reminderTimer:ReturnType<typeof setInterval>|undefined;
let stopping=false,timer:ReturnType<typeof setTimeout>|undefined;
let dmCommandQueue=Promise.resolve();
client.on('messageCreate',message=>{if(!message.guildId&&!message.author.bot){
 if(message.author.id===process.env.DISTRICT_BOOKING_OWNER_ID){voice?.acknowledge();reminders.acknowledge();}
 dmCommandQueue=dmCommandQueue.then(async()=>{try{const reply=await dmWatches.command(message.author.id,message.content);if(reply)await message.reply({content:reply,allowedMentions:{parse:[]}})}catch(e){await message.reply({content:`Could not create watch: ${e instanceof Error?e.message:'request failed'}`,allowedMentions:{parse:[]}})}}).catch(()=>console.error('DM watch command failed'));
}});
client.on('interactionCreate',async i=>{
 try{
  if(!i.guildId&&i.user.id===process.env.DISTRICT_BOOKING_OWNER_ID)voice?.acknowledge();
  if(!i.guildId&&i.user.id===process.env.DISTRICT_BOOKING_OWNER_ID&&((i.isButton()&&[reminderStopId,'district:holdonly','district:yes','district:no','district:stoprenewal'].some(id=>i.customId===id||i.customId.startsWith(id+':')))||i.isChatInputCommand()&&i.options.getString('action')==='cancel'))reminders.acknowledge();
  if(i.isButton()&&i.customId===reminderStopId){
   if(i.guildId||i.user.id!==process.env.DISTRICT_BOOKING_OWNER_ID){await i.reply({content:'These reminder controls are private to the configured owner.',flags:MessageFlags.Ephemeral});return}
   await i.reply({content:'Repeat alerts stopped. New seat alerts will still arrive; no hold or payment was submitted.',flags:MessageFlags.Ephemeral});return;
  }
  if(i.isButton()&&['seatsniper:voice:test','seatsniper:voice:ringtest','seatsniper:voice:stop'].includes(i.customId)){
   if(i.guildId||i.user.id!==process.env.DISTRICT_BOOKING_OWNER_ID){await i.reply({content:'This private voice test is available only to the configured owner.',flags:MessageFlags.Ephemeral});return}
   await i.deferReply({flags:MessageFlags.Ephemeral});
   try{await i.editReply({content:!voice?'Voice alerts are not configured yet.':i.customId==='seatsniper:voice:stop'?'Ringing stopped. Seat holds and payments still need their separate confirmations.':i.customId==='seatsniper:voice:ringtest'?await voice.testRing():await voice.test(),allowedMentions:{parse:[]}})}catch{await i.editReply({content:'Voice test could not connect. Keep the configured channel joined with audio on. Discord text alerts continue.',allowedMentions:{parse:[]}})}return;
  }
  if(i.isAutocomplete()){await i.respond([]);return;}
  if(i.isChatInputCommand()&&['watch','list','stop','help'].includes(i.commandName)){
   if(i.guildId){await i.reply({content:'Manage your watches in a private DM with this bot.',flags:MessageFlags.Ephemeral});return}
   await i.deferReply({flags:MessageFlags.Ephemeral});
   try{const text=dmSlashText(i.commandName,i.options);
    await i.editReply(await dmWatches.command(i.user.id,text)??dmWatchHelp);
   }catch(e){await i.editReply(`Could not create watch: ${e instanceof Error?e.message:'request failed'}`)}return;
  }
  if(await handleDistrictBooking(i))return;
  if(i.isChatInputCommand())await i.reply({content:'This cloud service handles District /book and Book Now alerts. Use /book action:help in a private DM.',flags:MessageFlags.Ephemeral});
 }catch{console.error('Discord interaction failed; no action retried')}
});
client.once('clientReady',()=>{
 reminderTimer=setInterval(()=>void reminders.step(sendReminder),100);
 console.log(`SeatSniper DM watch management connected to Discord; legacy polling interval ${poller.intervalMs/1000}s`);
 if(voice)void voice.start().catch(()=>console.error('Voice alerts could not connect; check bot server membership and voice-channel permissions. Text monitoring continues.'));
 const poll=async()=>{
  if(stopping)return;
  const delay=await poller.step();
  if(!stopping)timer=setTimeout(()=>void poll(),delay);
 };
 const pollPvr=async()=>{if(stopping)return;const delay=await pvrPoller.step();if(!stopping)pvrTimer=setTimeout(()=>void pollPvr(),delay)};
 const pollDm=async()=>{if(stopping)return;await dmWatches.step(async(userId,content,components=[])=>{const channel=await client.rest.post(Routes.userChannels(),{body:{recipient_id:userId}}) as {id:string};await client.rest.post(Routes.channelMessages(channel.id),{body:{content,components,allowed_mentions:{parse:[]}}});});if(!stopping)dmWatchTimer=setTimeout(()=>void pollDm(),1000)};
 void pollDm();
 if(legacyDoomsday){void pollPvr();void poll()}else console.log('Legacy Doomsday watches disabled; private per-user DM watch management active.');
});
client.on('error',()=>console.error('Discord connection error'));
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,async()=>{stopping=true;if(dmWatchTimer)clearTimeout(dmWatchTimer);await dmWatches.close();if(pvrTimer)clearTimeout(pvrTimer);if(reminderTimer)clearInterval(reminderTimer);if(timer)clearTimeout(timer);voice?.destroy();await client.destroy();process.exit(0)});
await client.login(token);
