/** PVR INOX's anonymous website showtime feed. Read-only: never holds or pays. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DistrictHttpError,type Json} from './district-mcp.ts';
import {MonitorPoller} from './monitor-runtime.ts';
import {sendDiscord,type AlertSender,type DiscordDelivery} from './doomsday-monitor.ts';
export const pvrCinema='349';
export const pvrDates=['2026-12-16','2026-12-17'];
export const pvrLink='https://www.pvrcinemas.com/cinemasessions/Mumbai/HDFC-Millennia-PVR-ICON-Oberoi-Mall-Goregaon-E/349';
export type PvrShow={date:string;time:string;timestamp:number;session:string;format:string;bookingUrl:string};
/** The opaque show token is published by PVR; never construct one from session IDs. */
export function pvrBookingUrl(encrypted:unknown):string {
 if(typeof encrypted!=='string'||!/^[-A-Za-z0-9()+/_=]{12,512}$/.test(encrypted))throw Error('PVR did not publish a valid booking link');
 return `https://www.pvrcinemas.com/seatlayout/${encodeURIComponent(encrypted)}/Mumbai`;
}
export function validatePvr(payload:Json):Json {
 if(payload.result!=='success'||payload.code!==10001||!payload.output)throw Error(`PVR showtime feed error (${String(payload.code??'invalid response')}); not an empty result`);
 const o=payload.output,c=o.cinemaRe;
 if(String(c?.theatreId)!==pvrCinema||c.cityName!=='Mumbai'||!/oberoi mall/i.test(c.name??'')||/sky city/i.test(c.name??''))throw Error('PVR cinema identity mismatch');
 if(!Array.isArray(o.days)||!Array.isArray(o.cinemaMovieSessions)||o.days.some((d:Json)=>!/^\d{4}-\d{2}-\d{2}$/.test(d.dt??'')||typeof d.enable!=='boolean'))throw Error('PVR showtime schema changed');
 if(c.screens?.['880']?.screenType!=='PXL'||c.screens?.['880']?.screenName!=='SCREEN 2')throw Error('PVR Oberoi PXL screen identity changed');
 return o;
}
export class PvrClient {
 constructor(private request:typeof fetch=fetch){}
 async schedule(date='NA'):Promise<Json>{
  if(date!=='NA'&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Invalid PVR date');
  const r=await this.request('https://api3.pvrcinemas.com/api/v1/booking/content/csessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ',chain:'PVR',city:'Mumbai',country:'INDIA',appVersion:'1.0',platform:'WEBSITE',Origin:'https://www.pvrcinemas.com',Referer:'https://www.pvrcinemas.com/'},body:JSON.stringify({city:'Mumbai',cid:pvrCinema,lat:'19.173905',lng:'72.861012',dated:date,qr:'NO',cineType:'',cineTypeQR:''}),signal:AbortSignal.timeout(20_000),redirect:'error'});
  if(!r.ok)throw new DistrictHttpError(r.status,r.headers,'PVR public showtimes');
  return validatePvr(await r.json() as Json);
 }
}
export function selectPvrShow(o:Json,date:string,now=Date.now()):PvrShow|undefined {
 const candidates:PvrShow[]=[];
 for(const movie of o.cinemaMovieSessions){
  const name=String(movie.movieRe?.n??movie.movieRe?.filmNameWeb??'').replace(/[:’']/g,'').trim();
  if(!/^AVENGERS\s+DOOMSDAY$/i.test(name))continue;
  if(!Array.isArray(movie.experienceSessions))throw Error('PVR movie session schema changed');
  const filmIds=new Set((movie.movieRe.filmIds??[]).map(String));
  for(const experience of movie.experienceSessions){
   if(!Array.isArray(experience.shows))throw Error('PVR show schema changed');
   for(const s of experience.shows){
    if(String(s.theatreId)!==pvrCinema||!filmIds.has(String(s.movieId)))throw Error('PVR show identity mismatch');
    if(s.showDate!==date||s.showDateStr!==date)throw Error('PVR substituted a different date');
    if(String(s.screenId)!=='880')continue;
    if(s.screenName!=='SCREEN 2'||s.screenType!=='PXL')throw Error('PVR PXL show identity mismatch');
    if(s.language!=='English')continue;
    const timestamp=s.showTimeStamp;
    if(typeof timestamp!=='number'||!Number.isFinite(timestamp)||new Date(timestamp+330*60_000).toISOString().slice(0,10)!==date)throw Error('PVR show timestamp mismatch');
    if(timestamp<=now||s.status!==1||s.statusTxt!=='Available')continue;
    if(!/^\d+$/.test(String(s.sessionId)))throw Error('Invalid PVR session');
    candidates.push({date,time:new Date(timestamp+330*60_000).toISOString().slice(11,16),timestamp,session:String(s.sessionId),format:/\b3D\b/i.test(`${s.filmFormat??''} ${s.movieFormat??''}`)?'PXL 3D':'PXL',bookingUrl:pvrBookingUrl(s.encrypted)});
   }
  }
 }
 candidates.sort((a,b)=>a.timestamp-b.timestamp);
 return candidates.find(s=>s.format==='PXL 3D')??candidates[0];
}
export async function findPvrMatch(client:Pick<PvrClient,'schedule'>,now=Date.now()):Promise<PvrShow|undefined>{
 const initial=await client.schedule();
 // Explicitly absent/disabled published dates are not open. Other API errors throw.
 for(const date of pvrDates){
  if(!initial.days.some((d:Json)=>d.dt===date&&d.enable===true))continue;
  const schedule=await client.schedule(date);
  if(!schedule.days.some((d:Json)=>d.dt===date&&d.enable===true))throw Error('PVR requested date is not enabled in response');
  const match=selectPvrShow(schedule,date,now);if(match)return match;
 }
}
export type PvrNotice=(delivery:DiscordDelivery|undefined)=>void;
export function createPvrPoller(send:AlertSender=sendDiscord,notice:PvrNotice=()=>{},client:Pick<PvrClient,'schedule'>=new PvrClient(),directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor'){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const path=join(directory,'pvr-state.json'),pollPath=join(directory,'pvr-polling.json');
 const read=(p:string)=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{};
 const save=(p:string,d:Json)=>{writeFileSync(p+'.tmp',JSON.stringify(d),{mode:0o600});renameSync(p+'.tmp',p)};
 const state=read(path);
 return new MonitorPoller(async()=>{
  const match=await findPvrMatch(client);let delivery:DiscordDelivery|undefined;
  if(match){
   const key=`checkout-v1:${match.date}:${match.session}:${match.timestamp}:${match.format}`;
   delivery=state.delivered?.[key];
   if(!delivery){
    const content=`PVR INOX DIRECT — Doomsday show listed as AVAILABLE\nOberoi Mall, Goregaon · Screen 2 PXL · ${match.date} ${match.time} IST · English · ${match.format}\nThis is a PVR listing alert, not a verified seat recommendation. Three adjacent central seats and the ₹1,200-per-seat cap are NOT verified here.\nClick Book on PVR — Woohoo to open this exact show. Choose 3 adjacent central seats (around the third row from the back, or recliners) at up to ₹1,200 each, then review the final total. In PVR checkout, choose Gift Card and enter your Woohoo PVR INOX card number and PIN privately. Pay any remainder using a method PVR offers. Nothing held or paid by this bot. District confirmations are separate.\nReply here or click Stop alerts to stop reminders. If you book directly on PVR, reply here to acknowledge it.`;
    delivery=await send(content,[{type:1,components:[{type:2,style:5,label:'Book on PVR — Woohoo',url:match.bookingUrl},{type:2,style:5,label:'PVR cinema listings',url:pvrLink},{type:2,style:2,label:'Stop alerts',custom_id:'seatsniper:reminders:stop'}]}])??undefined;
    state.delivered={...(state.delivered??{}),[key]:delivery};state.delivered=Object.fromEntries(Object.entries(state.delivered).slice(-100));save(path,state);
   }
  }
  notice(delivery);state.lastCheckAt=new Date().toISOString();state.lastResult=match?'listing_available':'no_matching_listing';state.datePriority=pvrDates;save(path,state);
  console.log(`PVR direct check succeeded: ${state.lastResult}`);
 },30_000,read(pollPath),s=>save(pollPath,s));
}
