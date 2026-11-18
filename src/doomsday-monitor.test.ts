import {test,expect} from 'bun:test';
import {centralGroup,datesFromHtml,findMatch,preference} from './doomsday-monitor.ts';
const makeMap=()=>({free_seating:false,max_tickets:10,areas:[{area_code:'BR',area_num:'1',price:1000}],seats:Array.from({length:9},(_,i)=>({label:`H${i+1}`,row:'H',area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+1),status:'available'}))});
test('ranks three central adjacent seats and rejects aisle gaps, sold seats and out-of-range prices',()=>{
 const m=makeMap();expect(centralGroup(m)?.seats).toEqual(['H4','H5','H6']);
 m.seats[4]!.status='sold';expect(centralGroup(m)?.seats??[]).not.toContain('H5');
 m.seats=m.seats.filter(s=>[1,3,5,7,9].includes(Number(s.grid_seat_number)));expect(centralGroup(m)).toBeUndefined();
 for(const p of [0,-1,NaN,Infinity,1201,1800]){const n=makeMap();n.areas[0]!.price=p;expect(centralGroup(n)).toBeUndefined()}
 for(const p of [1,500,799,800,1200]){const n=makeMap();n.areas[0]!.price=p;expect(centralGroup(n)?.price).toBe(p)}
});
test('does not split coupled seats, or mix categories',()=>{
 const m:any=makeMap();m.seat_groups=[{labels:['H3','H4','H5','H6']}];expect(centralGroup(m)).toBeUndefined();
 for(const s of m.seats)s.area_num=s.label==='H5'?'2':'1';expect(centralGroup(m)?.seats??[]).not.toContain('H5');
});
test('coming soon is empty only with verified movie identity; changed schema throws',()=>{
 const html=(data:any)=>`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{data}}})}</script>`;
 expect(datesFromHtml(html({contentId:preference.movie,isGeneric:true,movieData:{meta:{isReleased:false}}}))).toEqual([]);
 expect(()=>datesFromHtml(html({contentId:'different',isGeneric:true,movieData:{meta:{isReleased:false}}}))).toThrow();
 expect(()=>datesFromHtml(html({contentId:preference.movie}))).toThrow();
 expect(datesFromHtml(html({contentId:preference.movie,serverState:{movieSessions:{x:{data:{sessionDates:['2026-12-18','2026-12-17','2026-12-18']}}}}}))).toEqual(['2026-12-17','2026-12-18']);
});
test('matches exact cinema, movie, PXL and English first show; all calls are read-only',async()=>{
 const calls:string[]=[];
 const show={id:'test',language:'English',premium_label:'PXL',format:'3D',screen:'SCREEN 2',start_time:'2026-12-18T18:50:00+05:30',min_price:800,max_price:1800};
 const read=async(op:string)=>{calls.push(op);return op==='consumer.cinema_showtimes'?{cinema:{id:preference.cinema},date:'2026-12-18',movies:[{id:preference.movie,sessions:[show]}]}:{...makeMap(),show:{show_date_time:show.start_time,movie:'Avengers: Doomsday',language:'English',cinema:'PVR ICON Oberoi Mall Goregaon',screen:'SCREEN 2'}}};
 const match=await findMatch(['2026-12-18'],read,Date.parse('2026-11-15T00:00:00Z'));expect(match?.seats).toEqual(['H4','H5','H6']);
 expect(calls).toEqual(['consumer.cinema_showtimes','consumer.movie_select_seat']);
 show.premium_label='IMAX';expect(await findMatch(['2026-12-18'],read,0)).toBeUndefined();
 show.premium_label='PXL';show.language='Hindi';expect(await findMatch(['2026-12-18'],read,0)).toBeUndefined();
 show.language='English';show.start_time='2026-12-18T06:00:00+05:30';expect((await findMatch(['2026-12-18'],read,0))?.time).toBe('06:00');
 await expect(findMatch(['2026-12-18'],async()=>({cinema:{id:'1089402'},date:'2026-12-18',movies:[]}))).rejects.toThrow('Mismatched');
});

test('Discord alert carries a Book Now component and credentials stay in the authorization header',async()=>{
 const {sendDiscord}=await import('./doomsday-monitor.ts');const {bookNowComponents}=await import('./district-alerts.ts');
 const oldToken=process.env.DISCORD_TOKEN,oldOwner=process.env.DISTRICT_BOOKING_OWNER_ID;
 process.env.DISCORD_TOKEN='fake-only-token';process.env.DISTRICT_BOOKING_OWNER_ID='12345';
 const bodies:any[]=[];
 const request=Object.assign(async(url:any,options:any)=>{expect(options.headers.Authorization).toBe('Bot fake-only-token');bodies.push(JSON.parse(options.body));return Response.json(String(url).endsWith('/users/@me/channels')?{id:'45678'}:{id:'99999'})},{preconnect:()=>{}}) as typeof fetch;
 try{await sendDiscord('Seats found — NOT HELD',bookNowComponents('a'.repeat(32)),request);expect(bodies[0]).toEqual({recipient_id:'12345'});expect(bodies[1].components[0].components[0].label).toBe('Book Now');expect(bodies[1].allowed_mentions).toEqual({parse:[]});expect(JSON.stringify(bodies)).not.toContain('fake-only-token')}
 finally{if(oldToken===undefined)delete process.env.DISCORD_TOKEN;else process.env.DISCORD_TOKEN=oldToken;if(oldOwner===undefined)delete process.env.DISTRICT_BOOKING_OWNER_ID;else process.env.DISTRICT_BOOKING_OWNER_ID=oldOwner}
});

test('date fallback checks the next requested date without substituting a later show on either date',async()=>{
 const first={id:'first',start_time:'2099-12-18T06:00:00+05:30',premium_label:'PXL',format:'3D',screen:'SCREEN 2',language:'English',sold_out:true,min_price:1000,max_price:1000};
 const later={...first,id:'later',start_time:'2099-12-18T10:00:00+05:30',sold_out:false};
 const calls:any[]=[];
 const read=async(op:string,args:any)=>{calls.push({op,args});return {cinema:{id:preference.cinema},date:args.date,movies:args.date==='2099-12-18'?[{id:preference.movie,sessions:[later,first]}]:[]}};
 expect(await findMatch(['2099-12-18','2099-12-19'],read,0)).toBeUndefined();
 expect(calls).toHaveLength(2);expect(calls[0].args.date).toBe('2099-12-18');
 first.sold_out=false;first.min_price=2000;first.max_price=2000;calls.length=0;
 expect(await findMatch(['2099-12-18','2099-12-19'],read,0)).toBeUndefined();expect(calls).toHaveLength(2);
});

test('prefers central third physical row across categories and accepts non-recliners below ₹800',()=>{
 const map:any={free_seating:false,max_tickets:10,areas:[{area_code:'BR',area_num:'1',price:1550},{area_code:'MR',area_num:'2',price:720}],seats:[]};
 for(const [row,index,area,num] of [['N','1','BR','1'],['M','2','BR','1'],['L','4','MR','2'],['K','5','MR','2']] as const){
  for(let c=1;c<=11;c++)map.seats.push({label:`${row}${c}`,row,area_code:area,area_num:num,grid_row_id:index,grid_seat_number:String(c),status:'available'});
 }
 const best=centralGroup(map);expect(best?.seats).toEqual(['L5','L6','L7']);expect(best?.price).toBe(720);expect(best?.rowFromTop).toBe(3);
 // Third physical row remains row three even when there is an aisle in grid ids.
 map.seats.filter((s:any)=>s.row==='L').forEach((s:any)=>s.status='sold');
 expect(centralGroup(map)?.rowFromTop).toBe(4);
});

test('returns separate recliner and third-row options without inferring type from price or duplicating seats',async()=>{
 const {centralOptions}=await import('./doomsday-monitor.ts');
 const map:any={free_seating:false,max_tickets:10,show:{cinema:'PVR ICON Oberoi Mall Goregaon',screen:'SCREEN 2'},areas:[{area_code:'BR',area_num:'1',name:'BR',price:1200},{area_code:'MR',area_num:'2',name:'MR',price:720}],seats:[]};
 for(const [row,id,area,num] of [['N','1','BR','1'],['M','2','BR','1'],['L','3','MR','2']] as const)for(let col=1;col<=11;col++)map.seats.push({label:`${row}${col}`,row,grid_row_id:id,grid_seat_number:String(col),area_code:area,area_num:num,status:'available'});
 const options=centralOptions(map);expect(options).toHaveLength(2);expect(options[0]?.choice).toBe('Central recliners');expect(options[0]?.price).toBe(1200);expect(options[1]?.seats).toEqual(['L5','L6','L7']);
 map.show.screen='SCREEN 9';expect(centralOptions(map)).toHaveLength(1);
 map.areas[1].name='Recliner';expect(centralOptions(map)).toHaveLength(1);
});

test('prefers earliest PXL 3D over normal PXL, with normal PXL as the availability fallback',async()=>{
 const first={id:'2d',start_time:'2099-12-18T06:00:00+05:30',premium_label:'PXL',screen:'SCREEN 2',language:'English',format:'2D',min_price:700,max_price:1700};
 const three={...first,id:'3d',format:'3D'};const later={...three,id:'later',start_time:'2099-12-18T10:00:00+05:30'};let sessions=[first,later,three];
 const read=async(op:string,args:any)=>op==='consumer.cinema_showtimes'?{cinema:{id:preference.cinema},date:'2099-12-18',movies:[{id:preference.movie,sessions}]}:{...makeMap(),show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',language:'English',screen:'SCREEN 2',show_date_time:sessions.find(s=>s.id===args.session_id)!.start_time}};
 expect((await findMatch(['2099-12-18'],read,0))?.session).toBe('3d');
 sessions=[later,first];expect((await findMatch(['2099-12-18'],read,0))?.session).toBe('later');
 (later as any).sold_out=true;expect((await findMatch(['2099-12-18'],read,0))?.session).toBe('2d');
 sessions=[first];expect((await findMatch(['2099-12-18'],read,0))?.session).toBe('2d');
});

 test('16 December takes priority and 17 December is used only when no qualifying first-date seats exist',async()=>{
 expect(preference.datePriority).toEqual(['2026-12-16','2026-12-17']);
 let firstAvailable=true;const queried:string[]=[];
 const read=async(op:string,args:any)=>{
  if(op==='consumer.cinema_showtimes'){queried.push(args.date);return {cinema:{id:preference.cinema},date:args.date,movies:args.date==='2026-12-16'&&!firstAvailable?[]:[{id:preference.movie,sessions:[{id:args.date,start_time:args.date+'T08:00:00+05:30',premium_label:'PXL',format:'3D',screen:'SCREEN 2',language:'English',min_price:700}]}]}};
  return {...makeMap(),show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',language:'English',screen:'SCREEN 2',show_date_time:args.session_id+'T08:00:00+05:30'}};
 };
 expect((await findMatch(preference.datePriority,read,0))?.date).toBe('2026-12-16');expect(queried).toEqual(['2026-12-16']);
 firstAvailable=false;queried.length=0;expect((await findMatch(preference.datePriority,read,0))?.date).toBe('2026-12-17');expect(queried).toEqual(preference.datePriority);
 });

test('one-click alerts preserve the exact summary and refresh the same message before expiry',async()=>{
 const {deliverHoldAlert}=await import('./doomsday-monitor.ts');
 const state:any={},sent:any[]=[],updated:any[]=[];let prepared=0;
 const match:any={session:'123',seats:['H4','H5','H6'],price:1000,date:'2099-12-16',time:'08:00',showDateTime:'2099-12-16T08:00:00+05:30',screen:'SCREEN 2',format:'3D',choice:'Central recliners',rowFromTop:2};
 const send=async(content:string,components:any=[])=>{sent.push({content,components});return {channel:'123',message:'456'}};
 const edit=async(delivery:any,content:string,components:any[])=>{updated.push({delivery,content,components});return delivery};
 const prepare=async()=>({id:String(++prepared).padStart(32,'0'),summary:`Exact provider summary ${prepared}: hold H4, H5, H6, no payment.`,expires:Date.now()+120_000});
 await deliverHoldAlert(match,state,()=>{},send,edit,prepare);
 expect(sent).toHaveLength(1);expect(sent[0].content).toContain('Exact provider summary 1: hold H4, H5, H6, no payment.');
 expect(sent[0].components[0].components[0].label).toBe('Confirm Hold — No Payment');
 await deliverHoldAlert(match,state,()=>{},send,edit,prepare);expect(prepared).toBe(1);
 Object.values<any>(state.preparedAlerts)[0].expires=Date.now()+30_000;
 await deliverHoldAlert(match,state,()=>{},send,edit,prepare);expect(sent).toHaveLength(1);expect(updated).toHaveLength(1);
 expect(updated[0].content).toContain('Exact provider summary 2');expect(updated[0].components[0].components[0].custom_id).not.toBe(sent[0].components[0].components[0].custom_id);
});

test('long provider confirmations are delivered intact and owner-busy states never emit approval buttons',async()=>{
 const {deliverHoldAlert}=await import('./doomsday-monitor.ts');const sent:any[]=[];
 const match:any={session:'123',seats:['H4','H5','H6'],price:1000,date:'2099-12-16',time:'08:00',showDateTime:'2099-12-16T08:00:00+05:30',screen:'SCREEN 2',format:'3D',choice:'Central recliners',rowFromTop:2};
 const send=async(content:string,components:any=[])=>{sent.push({content,components});return {channel:'123',message:'456'}};
 const summary='Exact summary '+'.'.repeat(1870);
 await deliverHoldAlert(match,{},()=>{},send,async()=>{},async()=>({id:'a'.repeat(32),summary,expires:Date.now()+120_000}));
 expect(sent).toHaveLength(2);expect(sent[1].content).toContain(summary);expect(sent.every(s=>s.content.length<=2000)).toBe(true);
 sent.length=0;
 await deliverHoldAlert(match,{},()=>{},send,async()=>{},async()=>({unavailable:'Existing pending confirmation',quiet:true}));expect(sent).toHaveLength(0);
});
