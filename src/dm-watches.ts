/** Per-user persistent Discord DM watches. Public availability reads; no bookings. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {parseWatchUrl,fetchShowtimes,fetchBookableDates,showtimesUrl,showsOnDate,type Target,type Show} from './providers.ts';
import {initBms,closeBms} from './bms.ts';
import {parseTimeFilter,matchesTimeFilter} from './time-filter.ts';
import {matchesFormat,matchesTheatre} from './filters.ts';
import type {Json} from './district-mcp.ts';
export type DmWatch={id:number;target:Target;time?:number;after?:number;before?:number;theatre?:string;format?:string;title?:string;created:number;nextAt:number;failures:number;lastCheck?:number;lastError?:string};
export type WatchDraft=Omit<DmWatch,'id'|'created'|'nextAt'|'failures'>;
export const dmWatchHelp='SeatSniper DM watches (BookMyShow and District):\n`watch <movie link> date:YYYY-MM-DD time:18:30 theatre:"Oberoi Mall" format:PXL`\nDate is required unless it is in the link. All times are IST. Optional `after:18:00 before:23:00` replaces exact time. Quote theatre names with spaces. Omit filters to watch any show.\n`list` — watches and health\n`stop <id>` — stop one watch\n`stop all` — stop all your DM watches\n`help` — these instructions\nYour watches and alerts are private to your Discord account. Five active watches per person. Checks every 30 seconds after each cycle, with backoff on failures. A matching listed show sends one alert and completes that watch. To monitor again, create a new watch. No seats held or payment initiated.';
function dateCode(raw:string,now=Date.now()){
 const d=raw.replaceAll('-','');if(!/^\d{8}$/.test(d))throw Error('Use date:YYYY-MM-DD.');
 const actual=new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00Z`);
 if(!Number.isFinite(actual.getTime())||actual.toISOString().slice(0,10).replaceAll('-','')!==d)throw Error('That date does not exist.');
 if(d<new Date(now+19_800_000).toISOString().slice(0,10).replaceAll('-',''))throw Error('That date has already passed in IST.');return d;
}
export function parseDmWatch(text:string,now=Date.now()):WatchDraft {
 let rest=text.trim().replace(/^watch\s+/i,'');const link=rest.match(/^<?https?:\/\/[^\s>]+>?/i)?.[0];
 if(!link)throw Error('Start with watch and a full BookMyShow or District movie link.');
 // Enforce exact domains before handing the URL to provider-specific parsers.
 const url=new URL(link.replace(/^<|>$/g,''));
 if(!['in.bookmyshow.com','bookmyshow.com','www.bookmyshow.com','district.in','www.district.in'].includes(url.hostname)||url.username||url.password||url.port)throw Error('Use an official BookMyShow or District link.');
 const parsed=parseWatchUrl(link);if(parsed.eventCode.startsWith('EV:'))throw Error('DM watches currently accept movie links; use /watch for supported events.');
 rest=rest.slice(link.length).trim();const values:Record<string,string>={};
 // Also accept a bare ISO date and optional bare 24h time after the link.
 rest=rest.replace(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?=\s|$)/,(_,d,t)=>{values.date=d;if(t)values.time=t;return ''}).trim();
 const token=/^(date|time|after|before|theatre|format):(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))(?:\s+|$)/i;
 while(rest){const m=rest.match(token);if(!m)throw Error('Unreadable option. Use date:, time:, after:, before:, theatre:"name", or format:.');const key=m[1]!.toLowerCase();if(key in values)throw Error(`Duplicate ${key} option.`);values[key]=m[2]??m[3]??m[4]!;rest=rest.slice(m[0].length)}
 const date=dateCode(values.date??parsed.date??'',now);
 const draft:WatchDraft={target:{...parsed,date}};
 for(const key of ['time','after','before'] as const)if(values[key]){const t=parseTimeFilter(values[key]);if(t===null)throw Error(`Invalid ${key}; use 18:30 or "6:30 PM".`);draft[key]=t}
 if(draft.time!==undefined&&(draft.after!==undefined||draft.before!==undefined))throw Error('Use either time: or after:/before:, not both.');
 if(draft.after!==undefined&&draft.before!==undefined&&draft.after>=draft.before)throw Error('after must be earlier than before; windows do not cross midnight.');
 for(const key of ['theatre','format'] as const)if(values[key]){if(values[key].length>100)throw Error(`${key} is too long.`);draft[key]=values[key].trim()}
 return draft;
}
export function filterDmShows(w:WatchDraft,shows:Show[],now=Date.now()):Show[]{return showsOnDate(shows,w.target.date).filter(s=>{
 if(s.epoch*1000<=now)return false;
 if(w.target.provider==='district'&&!/^(AVAILABLE|FILLING_FAST|FAST_FILLING)$/i.test(s.availStatus))return false;
 if(w.theatre&&!matchesTheatre(s.venueName,s.venueCode,w.theatre.toUpperCase()))return false;
 if(w.format&&!matchesFormat(s.attributes,w.format.toUpperCase()))return false;
 if(w.time!==undefined){const d=new Date(s.epoch*1000+19_800_000);if(d.getUTCHours()*60+d.getUTCMinutes()!==w.time)return false}
 return matchesTimeFilter(s.epoch,w.after,w.before);
})}
export class DmWatches {
 private path:string;private state:{nextId:number;watches:DmWatch[]};private busy=false;private bmsReady?:Promise<void>;private commands:Promise<unknown>=Promise.resolve();
 constructor(directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor',private read:typeof fetchShowtimes=fetchShowtimes,private now=Date.now){
  mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'dm-watches.json');this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{nextId:1,watches:[]};
 }
 private save(){writeFileSync(this.path+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
 private async snapshot(w:WatchDraft){if((w.target.provider??'bms')==='bms'&&this.read===fetchShowtimes){this.bmsReady??=initBms().catch(e=>{this.bmsReady=undefined;throw e});await this.bmsReady}const first=await this.read(w.target);
  if((w.target.provider??'bms')==='bms'&&w.format&&this.read===fetchShowtimes){
   const dates=await fetchBookableDates(w.target);
   for(const chip of dates.chips.filter(c=>matchesFormat(c.title,w.format!.toUpperCase()))){
    const child=await this.read({...w.target,slug:chip.slug,eventCode:chip.eventCode});first.shows.push(...child.shows);
   }
  }
  return first}

 command(text:string):Promise<string|undefined>{
  const next=this.commands.then(()=>this.runCommand(text));this.commands=next.catch(()=>{});return next;
 }
 private async runCommand(text:string):Promise<string|undefined>{
  text=text.trim();if(/^(help|\/help)$/i.test(text))return dmWatchHelp;
  if(/^(list|\/list)$/i.test(text))return this.state.watches.length?this.state.watches.map(w=>`#${w.id} ${w.target.provider==='district'?'District':'BookMyShow'} · ${w.target.date} · ${w.title??w.target.slug}\n${w.time!==undefined?'Time '+Math.floor(w.time/60).toString().padStart(2,'0')+':'+String(w.time%60).padStart(2,'0')+' IST · ':''}${w.theatre??'Any theatre'} · ${w.format??'Any format'}\n${w.lastError?'Check failing: '+w.lastError:w.lastCheck?'Last checked '+new Date(w.lastCheck).toISOString():'Waiting for first check'}`).join('\n\n').slice(0,1900):'No active DM watches. Send help for an example.';
  if(/^stop(?:\s|$)/i.test(text)){
   const arg=text.slice(4).trim();if(arg==='all'){const n=this.state.watches.length;this.state.watches=[];this.save();return `Stopped ${n} DM watch(es). No tickets or bookings changed.`}
   if(!/^\d+$/.test(arg))return 'Use stop <id> or stop all. Send list to see IDs.';
   const n=this.state.watches.length;this.state.watches=this.state.watches.filter(w=>w.id!==Number(arg));this.save();return this.state.watches.length<n?`Stopped watch #${arg}. No booking changed.`:'No active watch with that ID.';
  }
  if(!/^watch(?:\s|$)|^<?https?:\/\//i.test(text))return;
  if(this.state.watches.length>=5)throw Error('You have five active DM watches. Stop one first.');
  const draft=parseDmWatch(text,this.now());
  const identity=(w:WatchDraft)=>JSON.stringify([w.target.provider??'bms',w.target.city,w.target.eventCode,w.target.date,w.time,w.after,w.before,w.theatre,w.format]);
  if(this.state.watches.some(w=>identity(w)===identity(draft)))return 'That exact watch already exists. Send list.';
  const snapshot=await this.snapshot(draft); // A blocked or unreadable link is not saved silently.
  if(this.state.watches.length>=5)throw Error('Five active watches; stop one first.');
  const id=this.state.nextId++;const w:DmWatch={...draft,id,title:snapshot.title,created:this.now(),nextAt:this.now(),failures:0};this.state.watches.push(w);this.save();
  const open=filterDmShows(draft,snapshot.shows,this.now()).length;
  return `Watching #${id}: ${snapshot.title}\nDate ${draft.target.date} · ${draft.target.city} · ${draft.target.provider==='district'?'District':'BookMyShow'} · all times IST.\n${open?'A matching show is listed now; an alert will follow on the next check.':'I’ll DM when a matching listed show appears.'}\nFilters: ${draft.time!==undefined?'exact time '+String(Math.floor(draft.time/60)).padStart(2,'0')+':'+String(draft.time%60).padStart(2,'0'):draft.after!==undefined||draft.before!==undefined?'time window':'any time'}; ${draft.theatre??'any theatre'}; ${draft.format??'any format'}.\nSend list, stop ${id}, or stop all. No seats held or payment initiated.`;
 }
 async step(send:(content:string,components?:Json[])=>Promise<unknown>){
  if(this.busy)return;this.busy=true;
  const cache=new Map<string,Promise<{title:string;shows:Show[]}>>();
  try{for(const w of [...this.state.watches]){
   if(w.nextAt>this.now()||!this.state.watches.some(x=>x.id===w.id))continue;
   if(w.target.date<new Date(this.now()+19_800_000).toISOString().slice(0,10).replaceAll('-','')){this.state.watches=this.state.watches.filter(x=>x.id!==w.id);this.save();continue}
   try{
    const key=JSON.stringify([w.target,w.format]);let res=cache.get(key);if(!res){res=this.snapshot(w);cache.set(key,res)}const data=await res;
    if(!this.state.watches.some(x=>x.id===w.id))continue;
    const shows=filterDmShows(w,data.shows,this.now());
    if(shows.length){const details=shows.slice(0,6).map(s=>`${s.venueName} · ${s.showTime} IST · ${s.attributes||'Standard'}`).join('\n');
     await send(`Watch #${w.id}: ${data.title} has matching listed shows on ${w.target.date}.\n${details}\nSeat availability, adjacency and final price must be checked on the booking page. No hold or payment initiated. This watch is complete; send a new watch to monitor again.`,[{type:1,components:[{type:2,style:5,label:'Open booking page',url:showtimesUrl(w.target)}]}]);
     this.state.watches=this.state.watches.filter(x=>x.id!==w.id);
    }else {w.lastCheck=this.now();w.failures=0;delete w.lastError;w.nextAt=this.now()+30_000}
   }catch(e){w.failures++;w.lastError=(e instanceof Error?e.message:'Read failed').slice(0,250);w.nextAt=this.now()+Math.max(Math.min(900_000,30_000*2**Math.min(w.failures,5)),Number((e as {retryAfterMs?:number}).retryAfterMs)||0);console.error(`DM watch #${w.id} failed; backing off`);if(w.failures===1&&this.state.watches.some(x=>x.id===w.id))await send(`Watch #${w.id}: a provider check failed. I’ll retry with backoff; this does not mean no shows are available. Send list for status.`).catch(()=>{})}
   this.save();
  }}finally{this.busy=false}
 }
 async close(){if(this.bmsReady)await closeBms()}
}

/** Keep registered slash commands and text DMs on the same management path. */
export function dmSlashText(command:string,options:{getString:(name:string,required?:boolean)=>string|null;getInteger:(name:string)=>number|null;getNumber:(name:string)=>number|null}):string {
 if(command==='watch'){
  if(options.getString('days')||options.getInteger('seats')!==null||options.getNumber('budget')!==null)throw Error('DM watches support date, time window, theatre and format. Seat-count, budget and weekday filters are not supported here.');
  let text='watch '+options.getString('link',true);
  for(const k of ['date','after','before','theatre','format']){const v=options.getString(k);if(v)text+=' '+k+':'+JSON.stringify(v)}return text;
 }
 if(command==='stop')return 'stop '+(options.getInteger('id')??'all');
 if(['list','help'].includes(command))return command;
 throw Error('Unsupported watch command.');
}
