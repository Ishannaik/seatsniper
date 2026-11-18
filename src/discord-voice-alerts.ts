import {classifySeatNotice} from './alert-notice.ts';
import {Client,ChannelType,PermissionFlagsBits,type VoiceState} from 'discord.js';
import {joinVoiceChannel,createAudioPlayer,createAudioResource,entersState,AudioPlayerStatus,NoSubscriberBehavior,StreamType,VoiceConnectionStatus,type VoiceConnection} from '@discordjs/voice';
import {createReadStream,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Json} from './json.ts';
export type VoiceTarget={guild:string;channel:string;owner:string;audio:string;ringtone:string};
export function voiceTarget(env:NodeJS.ProcessEnv=process.env):VoiceTarget|undefined {
 if(!env.VOICE_ALERT_GUILD_ID&&!env.VOICE_ALERT_CHANNEL_ID)return;
 const ids=[env.VOICE_ALERT_GUILD_ID,env.VOICE_ALERT_CHANNEL_ID,env.DISTRICT_BOOKING_OWNER_ID];
 if(!ids.every(id=>/^\d{17,20}$/.test(id??'')))throw Error('Voice alert server, channel and owner configuration is incomplete');
 return {guild:ids[0]!,channel:ids[1]!,owner:ids[2]!,audio:env.VOICE_ALERT_AUDIO??resolve('assets/seat-alert.ogg'),ringtone:env.VOICE_ALERT_RINGTONE??resolve('assets/seat-ringtone.ogg')};
}
export function voiceNoticeKey(message:string,components:Json[]):string|undefined {
 const kind=classifySeatNotice(components).voiceKind;
 return kind?`${message}:${kind}`:undefined;
}
export class VoiceNoticeLedger {
 private seen:string[]=[];
 private path:string;
 constructor(directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor') {
  mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'voice-notices.json');
  if(existsSync(this.path)){const d=JSON.parse(readFileSync(this.path,'utf8'));if(!Array.isArray(d)||d.some(k=>typeof k!=='string'))throw Error('Invalid voice notification ledger');this.seen=d.slice(-100)}
 }
 has(key:string){return this.seen.includes(key)}
 mark(key:string){this.seen=[...this.seen.filter(k=>k!==key),key].slice(-100);writeFileSync(this.path+'.tmp',JSON.stringify(this.seen),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
}
export function withVoiceStop(components:Json[]):Json[] {
 if(!voiceNoticeKey('notice',components))return components;
 const rows=components.map(row=>({...row,components:[...(row.components??[])]}));
 if(!rows.some(row=>row.components.some((b:Json)=>b.custom_id==='seatsniper:voice:stop')))rows[0]!.components.push({type:2,style:2,label:'Stop ringing',custom_id:'seatsniper:voice:stop'});
 return rows;
}
export class VoiceRingState {
 private key?:string;
 private path:string;
 constructor(directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor'){
  mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'voice-ringing.json');
  if(existsSync(this.path)){const d=JSON.parse(readFileSync(this.path,'utf8'));if(d.key!==undefined&&typeof d.key!=='string')throw Error('Invalid ringing state');this.key=d.key}
 }
 get pending(){return Boolean(this.key)}
 begin(key:string){if(!this.key){this.key=key;this.save()}}
 acknowledge(){this.key=undefined;this.save()}
 private save(){writeFileSync(this.path+'.tmp',JSON.stringify({key:this.key}),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
}
/** Output only: self-deafened, no receiver subscriptions, recordings or user-account automation. */
export class DiscordVoiceAlerts {
 private connection?:VoiceConnection;
 private readonly player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Stop}});
 private readonly ledger=new VoiceNoticeLedger();
 private syncing?:Promise<void>;
 private notifying=false;
 private readonly ringing=new VoiceRingState();
 private ringTimer?:ReturnType<typeof setTimeout>;
 private generation=0;
 private stopped=false;
 private retry?:ReturnType<typeof setTimeout>;
 private retryCount=0;
 private statusText='not started';
 constructor(private client:Client,readonly target:VoiceTarget) {
  if(!existsSync(target.audio)||!existsSync(target.ringtone))throw Error('Voice alert audio file is missing');
  this.player.on('error',()=>{this.statusText='audio playback failed';console.error('Voice alert playback failed; Discord text alert is still available')});
 }
 private changed=(_old:VoiceState,current:VoiceState)=>{
  if(current.guild.id===this.target.guild&&[this.target.owner,this.client.user?.id].includes(current.id))void this.sync().catch(()=>this.scheduleRetry());
 };
 async start(){this.client.on('voiceStateUpdate',this.changed);this.client.on('guildCreate',this.guildAdded);try{await this.sync()}catch(error){this.scheduleRetry();throw error}}
 private guildAdded=(guild:{id:string})=>{if(guild.id===this.target.guild)void this.sync().catch(()=>this.scheduleRetry())};
 private scheduleRetry(){
  if(this.stopped||this.retry)return;
  const delay=Math.min(120_000,10_000*2**Math.min(4,this.retryCount++));
  this.retry=setTimeout(()=>{this.retry=undefined;void this.sync().catch(()=>this.scheduleRetry())},delay);
 }
 private sync():Promise<void>{
  if(!this.syncing)this.syncing=this.syncOnce().finally(()=>{this.syncing=undefined});return this.syncing;
 }
 private async syncOnce(){
  if(this.stopped)return;
  const guild=await this.client.guilds.fetch(this.target.guild);
  const channel=await guild.channels.fetch(this.target.channel);
  if(!channel||channel.type!==ChannelType.GuildVoice)throw Error('Configured voice alert channel must be a regular server voice channel');
  const me=await guild.members.fetchMe();
  if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw Error('Bot needs View Channel, Connect and Speak in the alert channel');
  const owner=await guild.voiceStates.fetch(this.target.owner).catch(()=>undefined);
  if(owner?.channelId!==this.target.channel){
   this.statusText='waiting for you to join the configured voice channel';this.player.stop();if(this.connection&&this.connection.state.status!==VoiceConnectionStatus.Destroyed)this.connection.destroy();this.connection=undefined;return;
  }
  if(owner.selfDeaf||owner.serverDeaf){this.statusText='you are deafened; turn on channel audio to hear alerts';return}
  if(this.connection?.state.status===VoiceConnectionStatus.Ready){this.statusText='connected, self-deafened, ready to play alerts';this.scheduleRing();return}
  if(this.connection&&this.connection.state.status!==VoiceConnectionStatus.Destroyed)this.connection.destroy();
  const connection=joinVoiceChannel({guildId:guild.id,channelId:channel.id,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true,selfMute:false,daveEncryption:true,group:'seatsniper-alerts'});
  this.connection=connection;
  connection.on('error',()=>{this.statusText='voice connection error';this.scheduleRetry()});
  connection.on('stateChange',(_before,after)=>{if(after.status===VoiceConnectionStatus.Disconnected)this.scheduleRetry()});
  await entersState(connection,VoiceConnectionStatus.Ready,15_000);
  connection.subscribe(this.player);this.retryCount=0;this.statusText='connected, self-deafened, ready to play alerts';
  console.log('Discord voice alerts connected to configured channel; self-deafened, DAVE enabled');this.scheduleRing();
 }
 private ownerCanHear(){
  const state=this.client.guilds.cache.get(this.target.guild)?.voiceStates.cache.get(this.target.owner);
  return state?.channelId===this.target.channel&&!state.selfDeaf&&!state.serverDeaf;
 }
 async status(){await this.sync();return this.statusText}
 private async play(ringtoneOnly=false,generation=this.generation){
  if(this.connection?.state.status!==VoiceConnectionStatus.Ready)await this.sync();
  if(generation!==this.generation||this.stopped)return false;
  if(!this.ownerCanHear()||this.connection?.state.status!==VoiceConnectionStatus.Ready)return false;
  this.player.play(createAudioResource(createReadStream(ringtoneOnly?this.target.ringtone:this.target.audio),{inputType:StreamType.OggOpus}));
  await entersState(this.player,AudioPlayerStatus.Playing,5000);
  await entersState(this.player,AudioPlayerStatus.Idle,20_000);console.log('Discord voice alert playback completed');return true;
 }
 acknowledge(){
  this.generation++;this.ringing.acknowledge();if(this.ringTimer)clearTimeout(this.ringTimer);this.ringTimer=undefined;this.player.stop();
  console.log('Discord voice ringing acknowledged and stopped');
 }
 private scheduleRing(delay=5000){
  if(this.stopped||!this.ringing.pending||this.ringTimer||this.notifying)return;
  this.ringTimer=setTimeout(()=>{this.ringTimer=undefined;void this.ringCycle(false)},delay);
 }
 private async ringCycle(fullMessage:boolean){
  if(this.stopped||!this.ringing.pending||this.notifying)return;
  if(!this.ownerCanHear()){this.scheduleRing();return}
  const generation=this.generation;this.notifying=true;
  try{await this.play(!fullMessage,generation)}catch{if(generation===this.generation){this.statusText='Voice playback unavailable; text alerts continue';console.error(this.statusText);this.scheduleRetry()}}
  finally{this.notifying=false;if(generation===this.generation)this.scheduleRing()}
 }
 async test(){
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(this.notifying)return 'An alert is already playing. Please wait.';
  this.notifying=true;
  try{return await this.play()?'Voice test played. Keep channel audio on to hear future seat and expiry alerts.':this.statusText}finally{this.notifying=false;this.scheduleRing()}
 }
 async testRing(){
  await new Promise<void>(resolve=>setImmediate(resolve));
  this.ringing.begin('test:'+Date.now());void this.ringCycle(true);
  return 'Test ringing started. Reply in this DM or click Stop ringing to stop it. No seats held or payment initiated.';
 }
 async alert(message:string,components:Json[]):Promise<void>{
  const key=voiceNoticeKey(message,components);if(!key||this.ledger.has(key))return;
  this.ledger.mark(key);
  if(this.ringing.pending)return;
  this.ringing.begin(key);void this.ringCycle(true);
 }
 destroy(){this.stopped=true;this.generation++;if(this.ringTimer)clearTimeout(this.ringTimer);if(this.retry)clearTimeout(this.retry);this.client.off('voiceStateUpdate',this.changed);this.client.off('guildCreate',this.guildAdded);this.player.stop();this.connection?.destroy();this.connection=undefined}
}
