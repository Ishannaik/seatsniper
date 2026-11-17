/** Per-user persistent Discord DM watches. Public availability reads; no bookings. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {parseWatchUrl,fetchShowtimes,showtimesUrl,showsOnDate,type Target,type Show} from './providers.ts';
import {publicMovieReader,listingReader,type MovieReader} from './movie-reader.ts';
import {ReadCycle} from './read-cycle.ts';
import {MAX_WATCHES_PER_USER,WATCH_LIMIT_WORD} from './watch-policy.ts';
import {parseTimeFilter,matchesTimeFilter,todayIST,isRealDateCode,istMinutes} from './time-filter.ts';
import {matchesFormat,matchesTheatre} from './filters.ts';
import type {Json} from './json.ts';
export type DmWatch={id:number;target:Target;time?:number;after?:number;before?:number;theatre?:string;format?:string;title?:string;created:number;nextAt:number;failures:number;lastCheck?:number;lastError?:string};
export type WatchDraft=Omit<DmWatch,'id'|'created'|'nextAt'|'failures'>;
import {dmWatchHelp,DM_WATCH_OPTIONS} from './dm-command.ts';
export {dmWatchHelp} from './dm-command.ts';
function dateCode(raw:string,now=Date.now()){
 const d=raw.replaceAll('-','');if(!/^\d{8}$/.test(d))throw Error('Use date:YYYY-MM-DD.');
 if(!isRealDateCode(d))throw Error('That date does not exist.');
 if(d<todayIST(now))throw Error('That date has already passed in IST.');return d;
}
export function parseDmWatch(text:string,now=Date.now()):WatchDraft {
 let rest=text.trim().replace(/^watch\s+/i,'');const link=rest.match(/^<?https?:\/\/[^\s>]+>?/i)?.[0];
 if(!link)throw Error('Start with watch and a full BookMyShow or District movie link.');
 // Enforce exact domains before handing the URL to provider-specific parsers.
 const url=new URL(link.replace(/^<|>$/g,''));
 if(!['in.bookmyshow.com','bookmyshow.com','www.bookmyshow.com','district.in','www.district.in'].includes(url.hostname)||url.username||url.password||url.port)throw Error('Use an official BookMyShow or District link.');
 const parsed=parseWatchUrl(link);if(parsed.eventCode.startsWith('EV:'))throw Error('DM watches accept movie links only. Event monitoring is available in the classic runtime.');
 rest=rest.slice(link.length).trim();const values:Record<string,string>={};
 // Also accept a bare ISO date and optional bare 24h time after the link.
 rest=rest.replace(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?=\s|$)/,(_,d,t)=>{values.date=d;if(t)values.time=t;return ''}).trim();
 const token=new RegExp(`^(${DM_WATCH_OPTIONS.filter(o=>o.name!=='link').map(o=>o.name).join('|')}):(?:\"([^\"\\n]+)\"|'([^'\\n]+)'|(\\S+))(?:\\s+|$)`,'i');
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
 if(w.time!==undefined){if(istMinutes(s.epoch)!==w.time)return false}
 return matchesTimeFilter(s.epoch,w.after,w.before);
})}
export class DmWatches {
 private path:string;private state:{nextId:number;watches:DmWatch[]};private busy=false;private reader:MovieReader;private commands:Promise<unknown>=Promise.resolve();
 constructor(directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor',read:typeof fetchShowtimes|MovieReader=publicMovieReader,private now=Date.now){
  this.reader=typeof read==='function'?listingReader(read):read;
  mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'dm-watches.json');this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{nextId:1,watches:[]};
 }
 private save(){writeFileSync(this.path+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
 private snapshot(w:WatchDraft,cycle?:ReadCycle){return this.reader.snapshot(w,cycle)}

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
  if(this.state.watches.length>=MAX_WATCHES_PER_USER)throw Error(`You have ${WATCH_LIMIT_WORD} active DM watches. Stop one first.`);
  const draft=parseDmWatch(text,this.now());
  const identity=(w:WatchDraft)=>JSON.stringify([w.target.provider??'bms',w.target.city,w.target.eventCode,w.target.date,w.time,w.after,w.before,w.theatre,w.format]);
  if(this.state.watches.some(w=>identity(w)===identity(draft)))return 'That exact watch already exists. Send list.';
  const snapshot=await this.snapshot(draft); // A blocked or unreadable link is not saved silently.
  if(this.state.watches.length>=MAX_WATCHES_PER_USER)throw Error(`${WATCH_LIMIT_WORD[0]!.toUpperCase()+WATCH_LIMIT_WORD.slice(1)} active watches; stop one first.`);
  const id=this.state.nextId++;const w:DmWatch={...draft,id,title:snapshot.title,created:this.now(),nextAt:this.now(),failures:0};this.state.watches.push(w);this.save();
  const open=filterDmShows(draft,snapshot.shows,this.now()).length;
  return `Watching #${id}: ${snapshot.title}\nDate ${draft.target.date} · ${draft.target.city} · ${draft.target.provider==='district'?'District':'BookMyShow'} · all times IST.\n${open?'A matching show is listed now; an alert will follow on the next check.':'I’ll DM when a matching listed show appears.'}\nFilters: ${draft.time!==undefined?'exact time '+String(Math.floor(draft.time/60)).padStart(2,'0')+':'+String(draft.time%60).padStart(2,'0'):draft.after!==undefined||draft.before!==undefined?'time window':'any time'}; ${draft.theatre??'any theatre'}; ${draft.format??'any format'}.\nSend list, stop ${id}, or stop all. No seats held or payment initiated.`;
 }
 async step(send:(content:string,components?:Json[])=>Promise<unknown>,cycle=new ReadCycle()){
  if(this.busy)return;this.busy=true;
  const cache=new Map<string,Promise<{title:string;shows:Show[]}>>();
  try{for(const w of [...this.state.watches]){
   if(w.nextAt>this.now()||!this.state.watches.some(x=>x.id===w.id))continue;
   if(w.target.date<todayIST(this.now())){this.state.watches=this.state.watches.filter(x=>x.id!==w.id);this.save();continue}
   try{
    const key=JSON.stringify([w.target,w.format]);let res=cache.get(key);if(!res){res=this.snapshot(w,cycle);cache.set(key,res)}const data=await res;
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
 async close(){await this.reader.close()}
}

export {dmSlashText} from './dm-command.ts';
