import {HttpError} from './http-error.ts';
import type {Json} from './json.ts';
export type DiscordDelivery={channel:string;message:string};
export type AlertSender=(content:string,components?:Json[])=>Promise<DiscordDelivery|void>;
export type DiscordPost=(path:`/${string}`,body:Json)=>Promise<Json>;
export function privateDiscordSender(post:DiscordPost){
 return async(user:string,content:string,components:Json[]=[]):Promise<DiscordDelivery>=>{
  if(!/^\d+$/.test(user))throw Error('Invalid Discord recipient');
 const channel=await post('/users/@me/channels',{recipient_id:user});
 if(!/^\d+$/.test(channel.id))throw Error('Discord returned invalid channel');
 const message=await post(`/channels/${channel.id}/messages`,{content,components,allowed_mentions:{parse:[]}});
 if(!/^\d+$/.test(message.id))throw Error('Discord returned invalid message');
 return {channel:channel.id,message:message.id};
 };
}
export async function sendDiscord(content:string,components:Json[]=[],request:typeof fetch=fetch):Promise<DiscordDelivery>{
 const token=process.env.DISCORD_TOKEN,user=process.env.DISTRICT_BOOKING_OWNER_ID;
 if(!token||!/^\d+$/.test(user??''))throw Error('Discord monitor configuration missing');
 const call=async(path:string,body:Json)=>{const r=await request(`https://discord.com/api/v10${path}`,{method:'POST',headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw new HttpError(r.status,r.headers,'Discord delivery');return r.json() as Promise<Json>};
 return privateDiscordSender(call)(user!,content,components);
}
export async function editDiscord(delivery:DiscordDelivery,content:string,components:Json[]):Promise<DiscordDelivery> {
 if(![delivery.channel,delivery.message].every(id=>/^\d+$/.test(id)))throw Error('Invalid Discord alert receipt');
 const r=await fetch(`https://discord.com/api/v10/channels/${delivery.channel}/messages/${delivery.message}`,{method:'PATCH',headers:{Authorization:`Bot ${process.env.DISCORD_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({content,components,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(20000),redirect:'error'});
 if(r.status===404)return sendDiscord(content,components);
 if(!r.ok)throw new HttpError(r.status,r.headers,'Discord alert refresh');
 return delivery;
}
