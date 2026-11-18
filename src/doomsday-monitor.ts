import {MonitorPoller,type PollState} from './polling.ts';
/** Guest inventory monitor plus exact hold previews. Only a user click can confirm a hold. */
import {DistrictHttpError} from './district-mcp.ts';
import {problem} from './district-response.ts';
import type {Json} from './json.ts';
import { sendDiscord, editDiscord, type AlertSender, type DiscordDelivery } from './discord-delivery.ts';
export { sendDiscord, editDiscord, type DiscordDelivery, type AlertSender } from './discord-delivery.ts';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import {holdOnlyComponents} from './district-alerts.ts';
import type {SeatSuggestion} from './seat-suggestion.ts';
import { prepareHoldAlert, processHoldExpiry, type HoldAlertPreview } from './district-booking-application.ts';
import { MonitorSession, getMonitorSession } from './monitor-runtime.ts';
export function createMonitorPoller(intervalMs = Number(process.env.MONITOR_INTERVAL_SEC ?? 30) * 1000,send:AlertSender=sendDiscord,update:typeof editDiscord=editDiscord) {
 const directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor';mkdirSync(directory,{recursive:true,mode:0o700});
 const path=`${directory}/polling.json`;
 const state:Partial<PollState>=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 return new MonitorPoller(()=>runOnce(send,getMonitorSession(),update),intervalMs,state,next=>{
  writeFileSync(`${path}.tmp`,JSON.stringify({...next,intervalMs}),{mode:0o600});renameSync(`${path}.tmp`,path);
 });
}
import { legacyMoviePolicy, legacyMovieLink } from './legacy-movie-policy.ts';
export const preference = legacyMoviePolicy;
export const movieLink = legacyMovieLink;
function valid(d: Json): Json { if (problem(d) || d.error || d.status === 'error') throw Error('District read failed'); return d; }
export function datesFromHtml(html: string): string[] {
 const raw=html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
 if(!raw)throw Error('District movie page schema changed');
 const p=JSON.parse(raw).props?.pageProps,d=p?.data;
 if(String(d?.contentId)!==preference.movie)throw Error('District returned a different movie');
 if(d.isGeneric===true&&d.movieData?.meta?.isReleased===false)return [];
 if(!d.serverState?.movieSessions)throw Error('Missing booking-date metadata');
 const dates=Object.values(d.serverState.movieSessions).flatMap((v:any)=>{
  if(!Array.isArray(v?.data?.sessionDates))throw Error('Unsupported booking-date metadata');
  return v.data.sessionDates;
 });
 if(dates.some(v=>typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)))throw Error('Invalid booking dates');
 return [...new Set(dates as string[])].sort();
}
export function centralGroup(map: Json, mode: "third-row" | "recliner" = "third-row"): Json | undefined {
 if(map.free_seating!==false||!Array.isArray(map.seats)||!Array.isArray(map.areas)||map.max_tickets<preference.count)throw Error('Unsupported seat map');
 const seats=map.seats;
 if(!seats.length)return;
 if(seats.some((s:Json)=>!/^\d+$/.test(s.grid_row_id)||!/^\d+$/.test(s.grid_seat_number)))throw Error('Unknown seat geometry');
 const columns=seats.map((s:Json)=>Number(s.grid_seat_number)),rows=seats.map((s:Json)=>Number(s.grid_row_id));
 const centre=(Math.min(...columns)+Math.max(...columns))/2;
 const orderedRows=[...new Set(rows)].sort((a,b)=>a-b);
 const targetRowIndex=Math.min(preference.preferredRowFromTop-1,orderedRows.length-1);
 const centralRadius=(Math.max(...columns)-Math.min(...columns))/4;
 const groups:Json[]=[];
 for(const area of map.areas){
  // Measured Oberoi SCREEN 2 BR category was labelled RECLINER ROWS in District's UI.
  // Keep this mapping venue/screen/row scoped; never infer seat type from price.
  const knownOberoiRecliner=/oberoi mall/i.test(map.show?.cinema??'')&&!/sky city/i.test(map.show?.cinema??'')&&map.show?.screen==='SCREEN 2'&&area.area_code==='BR'&&area.area_num==='1'&&seats.filter((s:Json)=>s.area_code===area.area_code&&s.area_num===area.area_num).every((s:Json)=>['N','M'].includes(s.row));
  const recliner=/reclin/i.test(area.name??'')||knownOberoiRecliner;
  if(mode==='recliner'&&!recliner)continue;
  if(typeof area.price!=='number'||!Number.isFinite(area.price)||area.price<=preference.minimum||area.price>preference.maximum)continue;
  const eligible=seats.filter((s:Json)=>s.area_code===area.area_code&&s.area_num===area.area_num&&s.status==='available');
  for(const start of eligible){
   const group=Array.from({length:preference.count},(_,i)=>eligible.find((s:Json)=>s.grid_row_id===start.grid_row_id&&Number(s.grid_seat_number)===Number(start.grid_seat_number)+i));
   if(group.some(s=>!s))continue;
   const labels=group.map(s=>s.label);
   const horizontalDistance=Math.abs(Number(start.grid_seat_number)+(preference.count-1)/2-centre);
   if(horizontalDistance>centralRadius)continue;
   const rowIndex=orderedRows.indexOf(Number(start.grid_row_id));
   // Do not split couple/group seats, or infer adjacency across a grid gap.
   let compatible=true;
   for(const g of map.seat_groups??[]){const members=g.seat_labels??g.labels;if(!Array.isArray(members))throw Error('Unknown seat groups');if(members.some((l:string)=>labels.includes(l))&&!members.every((l:string)=>labels.includes(l)))compatible=false;}
   if(!compatible)continue;
   groups.push({seats:labels,price:area.price,rowFromTop:rowIndex+1,score:mode==='recliner'?horizontalDistance*100+Math.abs(rowIndex-targetRowIndex):Math.abs(rowIndex-targetRowIndex)*100+horizontalDistance,geometry:typeof map.total_seats==='number'&&map.seats.length<map.total_seats?'partial':'returned_layout'});
  }
 }
 return groups.sort((a,b)=>a.score-b.score||a.price-b.price)[0];
}
export function centralOptions(map: Json): Json[] {
 const candidates=[{choice:'Central recliners',group:centralGroup(map,'recliner')},{choice:'Around third row from top',group:centralGroup(map)}];
 const seen=new Set<string>();const result:Json[]=[];
 for(const {choice,group} of candidates){if(!group)continue;const key=group.seats.join(',');if(seen.has(key))continue;seen.add(key);result.push({...group,choice});}
 return result;
}
export type ReadCall=(operation:string,args:Json)=>Promise<Json>;
export async function findMatch(dates:string[],read:ReadCall,now=Date.now()):Promise<Json|undefined>{
 for(const date of [...new Set(dates)]){
  const d=valid(await read('consumer.cinema_showtimes',{cinema_id:preference.cinema,date}));
  if(String(d.cinema?.id)!==preference.cinema||d.date!==date||!Array.isArray(d.movies))throw Error('Mismatched cinema/date');
  const movie=d.movies.find((m:Json)=>String(m.id)===preference.movie);if(!movie)continue;
  const sessions=[...(movie.sessions??[])].filter((s:Json)=>s.language===preference.language&&/(^|\s)PXL(\s|$)/i.test(`${s.premium_label??''} ${s.format??''}`)).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time));
  // Date takes priority; within a date prefer the earliest 3D show, then earliest normal PXL.
  const firstShows=[sessions.find((s:Json)=>/\b3D\b/i.test(s.format??'')),sessions.find((s:Json)=>!/\b3D\b/i.test(s.format??''))].filter(Boolean);
  for(const show of firstShows){
   if(show.sold_out)continue;
   const epoch=Date.parse(show.start_time);if(!Number.isFinite(epoch))throw Error('Invalid show time');
   const ist=new Date(epoch+330*60*1000).toISOString();if(ist.slice(0,10)!==date)throw Error('Show date mismatch');
   if(epoch<=now)continue;
   if(Number(show.min_price)>preference.maximum)continue;
   const map=valid(await read('consumer.movie_select_seat',{cinema_id:preference.cinema,session_id:String(show.id)}));
   if(Date.parse(map.show?.show_date_time)!==epoch||map.show?.language!==preference.language||!/doomsday/i.test(map.show?.movie??'')||!/oberoi mall/i.test(map.show?.cinema??'')||/sky city/i.test(map.show?.cinema??'')||map.show?.screen!==show.screen)throw Error('Seat-map identity mismatch');
   const options=centralOptions(map);const group=options[0];if(group)return {...group,options,date,time:ist.slice(11,16),showDateTime:map.show.show_date_time,session:String(show.id),screen:show.screen,format:show.format};
  }
 }
}
export async function deliverHoldAlert(match:Json,state:Json,save:()=>void,send:AlertSender=sendDiscord,
 update:(delivery:DiscordDelivery,content:string,components:Json[])=>Promise<DiscordDelivery|void>=editDiscord,
 prepare:(owner:string,suggestion:SeatSuggestion)=>Promise<HoldAlertPreview>=prepareHoldAlert):Promise<void> {
 const key=`${match.session}:${match.seats.join(',')}:${match.price}`;
 const existing=state.preparedAlerts?.[key];
 if(existing&&existing.expires>Date.now()+45_000)return;
 const suggestion:SeatSuggestion={movie:preference.movie,cinema:preference.cinema,session:match.session,date:match.date,showDateTime:match.showDateTime,screen:match.screen,language:preference.language,format:match.format,seats:match.seats,price:match.price};
 const info=`Doomsday PXL — NOT HELD\nOberoi Mall · ${match.date} ${match.time} IST · English ${match.format}\n${match.choice} · ${preference.count} adjacent seats (row ${match.rowFromTop} from top): ${match.seats.join(', ')} · ₹${match.price} each · ₹${match.price*preference.count} before fees.\n${match.geometry==='partial'?'Centrality uses a partial map; check District’s layout.':'Central seats ranked from the returned grid.'}`;
 const delivered=()=>{state.delivered=[...(state.delivered??[]).filter((k:string)=>k!==key),key].slice(-100);save()};
 let preview:HoldAlertPreview;
 try{preview=await prepare(process.env.DISTRICT_BOOKING_OWNER_ID!,suggestion)}catch(error){
  if(!(state.delivered??[]).includes(key)){await send(info+'\nCould not prepare a hold confirmation. Check your District connection; no hold or payment was submitted.');delivered()}
  throw error;
 }
 if('unavailable' in preview){
  if(!preview.quiet&&!(state.delivered??[]).includes(key)){await send(info+'\n'+preview.unavailable);delivered()}
  return;
 }
 const prompt=`${preview.summary}\n\nHold only; no payment. Expires <t:${Math.floor(preview.expires/1000)}:R>.`;
 if(prompt.length>2000)throw Error('District confirmation is too long for Discord; no confirmation submitted');
 const full=info+'\n\n'+prompt;
 if(full.length>2000&&!(state.delivered??[]).includes(key))await send(info);
 const content=full.length<=2000?full:prompt,components=holdOnlyComponents(preview.id);
 const receipt=existing?.delivery?await update(existing.delivery,content,components):await send(content,components);
 state.preparedAlerts={...(state.preparedAlerts??{}),[key]:{id:preview.id,expires:preview.expires,delivery:receipt}};
 state.preparedAlerts=Object.fromEntries(Object.entries(state.preparedAlerts).slice(-100));
 state.lastAlertAt=new Date().toISOString();delivered();
}
export async function runOnce(send:AlertSender=sendDiscord,session=getMonitorSession(),update:typeof editDiscord=editDiscord):Promise<void>{
 const directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor';mkdirSync(directory,{recursive:true,mode:0o700});
 const path=`${directory}/state.json`;const state:Json=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 const save=()=>{writeFileSync(`${path}.tmp`,JSON.stringify(state),{mode:0o600});renameSync(`${path}.tmp`,path)};
 if(await processHoldExpiry(process.env.DISTRICT_BOOKING_OWNER_ID!,send,update)){
  state.lastCheckAt=new Date().toISOString();state.lastResult='hold_expiry_watch';state.connectionStats={...session.stats};save();console.log('Doomsday check succeeded: hold_expiry_watch');return;
 }
 const response=await fetch(movieLink,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw new DistrictHttpError(response.status,response.headers,'District page');
 const dates=datesFromHtml(await response.text());
 // Explicit user date order replaces the historical first-published-day pin.
 // Query both requested dates once bookings exist, even if the public date list lags.
 state.datePriority=preference.datePriority;save();
 const selection=await findMatch(dates.length?preference.datePriority:[],(operation,args)=>session.read(operation,args));
 for(const option of selection?.options??[])await deliverHoldAlert({...selection,...option},state,save,send,update);
 state.lastCheckAt=new Date().toISOString();state.lastResult=selection?'match':'no_match';state.failureCount=0;delete state.lastFailure;state.connectionStats={...session.stats};save();
 console.log(`Doomsday check succeeded: ${state.lastResult}`);
}
if(import.meta.main){
 if(process.argv.includes('--test-discord'))await sendDiscord('SeatSniper cloud monitor delivery test. Watching Doomsday at Oberoi Mall PXL: both central recliners and central seats around the 3rd row from the top, 3 adjacent seats per option, up to ₹1,200 each, English earliest show: 16 December first, 17 December fallback; earliest PXL 3D preferred, otherwise earliest normal PXL. No seats held and no payment initiated.');
 else if(process.argv.includes('--once'))await runOnce();
 else {const poller=createMonitorPoller();while(true)await Bun.sleep(await poller.step())}
}
