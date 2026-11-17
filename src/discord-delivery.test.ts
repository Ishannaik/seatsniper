import {test,expect} from 'bun:test';
import {privateDiscordSender} from './discord-delivery.ts';
import {HttpError} from './http-error.ts';
import {MonitorPoller} from './polling.ts';
test('private delivery binds recipient and receipt without mentions or hidden owner fallback',async()=>{
 const calls:{path:string;body:any}[]=[];
 const send=privateDiscordSender(async(path,body)=>{calls.push({path,body});return path==='/users/@me/channels'?{id:body.recipient_id==='111'?'222':'333'}:{id:'444'}});
 expect(await send('111','first')).toEqual({channel:'222',message:'444'});
 expect(await send('555','second')).toEqual({channel:'333',message:'444'});
 expect(calls.map(c=>c.path)).toEqual(['/users/@me/channels','/channels/222/messages','/users/@me/channels','/channels/333/messages']);
 expect(calls[1]!.body.allowed_mentions).toEqual({parse:[]});
 await expect(send('../channel','bad')).rejects.toThrow('Invalid Discord recipient');expect(calls).toHaveLength(4);
});
test('generic provider/delivery cooldowns override polling caps without any automatic retry',async()=>{
 let calls=0;
 const poller=new MonitorPoller(async()=>{calls++;throw new HttpError(429,new Headers({'Retry-After':'1800'}),'PVR')},30_000,{},()=>{},()=>1000,()=>0);
 expect(await poller.step()).toBe(1_800_000);expect(await poller.step()).toBe(1_800_000);expect(calls).toBe(1);
});
