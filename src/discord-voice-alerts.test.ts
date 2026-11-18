import {test,expect} from 'bun:test';
import {createReadStream,mkdtempSync,rmSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createAudioPlayer,createAudioResource,entersState,AudioPlayerStatus,NoSubscriberBehavior,StreamType,TransformerType} from '@discordjs/voice';
import {voiceTarget,voiceNoticeKey,VoiceNoticeLedger,VoiceRingState,withVoiceStop,DiscordVoiceAlerts} from './discord-voice-alerts.ts';
import {holdOnlyComponents} from './district-alerts.ts';import {renewalComponents} from './hold-renewal.ts';
test('voice target is optional and requires an explicit server, channel and owner',()=>{
 expect(voiceTarget({})).toBeUndefined();expect(()=>voiceTarget({VOICE_ALERT_GUILD_ID:'123'})).toThrow('incomplete');
 const t=voiceTarget({VOICE_ALERT_GUILD_ID:'100000000000000003',VOICE_ALERT_CHANNEL_ID:'100000000000000004',DISTRICT_BOOKING_OWNER_ID:'100000000000000001'});
 expect(t?.channel).toBe('100000000000000004');expect(t?.audio).toEndWith('assets/seat-alert.ogg');
});
test('voice alarms distinguish new seats, expiry and available renewal without replaying refreshes',()=>{
 const id='a'.repeat(32),other='b'.repeat(32);
 expect(voiceNoticeKey('123',holdOnlyComponents(id))).toBe('123:seats');
 expect(voiceNoticeKey('123',holdOnlyComponents(other))).toBe('123:seats');
 expect(voiceNoticeKey('123',renewalComponents(id))).toBe('123:expiry');
 expect(voiceNoticeKey('123',renewalComponents(id,other))).toBe('123:renewal-ready');
 const sample=holdOnlyComponents(id);Object.assign(sample[0]!.components[0]!,{disabled:true});expect(voiceNoticeKey('123',sample)).toBeUndefined();
 expect(voiceNoticeKey('123',[])).toBeUndefined();
});
test('voice deduplication persists across restarts and is stored privately',()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-notices-'));try{
  const ledger=new VoiceNoticeLedger(dir);expect(ledger.has('123:seats')).toBe(false);ledger.mark('123:seats');
  expect(new VoiceNoticeLedger(dir).has('123:seats')).toBe(true);expect(statSync(join(dir,'voice-notices.json')).mode&0o777).toBe(0o600);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('shipped Opus alert plays directly without a runtime encoder or FFmpeg',async()=>{
 const player=createAudioPlayer({behaviors:{noSubscriber:NoSubscriberBehavior.Play}});
 const resource=createAudioResource(createReadStream(resolve('assets/seat-alert.ogg')),{inputType:StreamType.OggOpus});
 try{player.play(resource);await entersState(player,AudioPlayerStatus.Playing,5000);await entersState(player,AudioPlayerStatus.Idle,15000);expect(resource.playbackDuration).toBeGreaterThan(7000);expect(resource.encoder).toBeUndefined();expect(resource.edges.map(e=>e.type)).toEqual([TransformerType.OggOpusDemuxer])}
 finally{player.stop()}
},20000);

test('pending ringing survives restart and acknowledgement clears it privately',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ring-state-'));try{
  const state=new VoiceRingState(dir);expect(state.pending).toBe(false);state.begin('123:seats');expect(new VoiceRingState(dir).pending).toBe(true);
  state.acknowledge();expect(new VoiceRingState(dir).pending).toBe(false);expect(statSync(join(dir,'voice-ringing.json')).mode&0o777).toBe(0o600);
  const original=holdOnlyComponents('a'.repeat(32)),updated=withVoiceStop(original);
  expect(original[0]!.components).toHaveLength(1);expect(updated[0]!.components).toHaveLength(2);expect(withVoiceStop(updated)[0]!.components).toHaveLength(2);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('a seat notice plays the message once, repeats ringtone only, then stops on acknowledgement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ring-loop-')),old=process.env.MONITOR_STATE_DIR;process.env.MONITOR_STATE_DIR=dir;
 const target=voiceTarget({VOICE_ALERT_GUILD_ID:'100000000000000003',VOICE_ALERT_CHANNEL_ID:'100000000000000004',DISTRICT_BOOKING_OWNER_ID:'100000000000000001'})!;
 const member={channelId:target.channel,selfDeaf:false,serverDeaf:false};
 const client:any={guilds:{cache:new Map([[target.guild,{voiceStates:{cache:new Map([[target.owner,member]])}}]])},off:()=>{}};
 const voice:any=new DiscordVoiceAlerts(client,target);const played:boolean[]=[];voice.play=async(ringtoneOnly:boolean)=>{played.push(ringtoneOnly);return true};
 try{
  await voice.alert('123',holdOnlyComponents('a'.repeat(32)));await Bun.sleep(20);expect(played).toEqual([false]);
  await Bun.sleep(5100);expect(played).toEqual([false,true]);voice.acknowledge();
  await Bun.sleep(5100);expect(played).toEqual([false,true]);
 }finally{voice.destroy();if(old===undefined)delete process.env.MONITOR_STATE_DIR;else process.env.MONITOR_STATE_DIR=old;rmSync(dir,{recursive:true,force:true})}
},20000);
