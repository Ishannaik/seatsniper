import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DistrictAlertStore,bookNowComponents,type SeatSuggestion} from './district-alerts.ts';
import {DistrictBooking} from './district-booking.ts';import type {ConnectionState,Json} from './district-mcp.ts';
const suggestion=():SeatSuggestion=>({movie:'176735',cinema:'1018530',session:'123',date:'2099-12-18',showDateTime:'2099-12-18T13:20:00Z',screen:'SCREEN 2',language:'English',format:'3D',seats:['H4','H5','H6'],price:1000});
function setup(){
 const alert=suggestion(),state:ConnectionState={authenticated:true},calls:{name:string;args:Json}[]=[];let claims=0;
 const show={id:'123',start_time:alert.showDateTime,screen:alert.screen,language:'English',format:'3D',premium_label:'PXL'};
 const map:any={free_seating:false,max_tickets:10,tempTransId:'map',show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',show_date_time:alert.showDateTime,screen:alert.screen,language:'English'},areas:[{area_code:'BR',area_num:'1',ticket_type:'BR',price:1000}],seats:alert.seats.map((label,i)=>({label,status:'available',area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+4)}))};
 const engine=new DistrictBooking(state,()=>{},async(name,args={})=>{
  calls.push({name,args:structuredClone(args)});
  if(name==='execute')return args.operation==='consumer.cinema_showtimes'?{date:alert.date,cinema:{id:alert.cinema,name:map.show.cinema},movies:[{id:alert.movie,name:map.show.movie,sessions:[show]}]}:map;
  if(name==='act'&&args.operation==='consumer.movie_promo_validate')return {final_price:3300};
  if(name==='payment_options')return {methods:[{ref:'test-method',label:'UPI QR'}]};
  if(name==='payment_status')return {status:'paid',order_id:'TEST_ONLY'};
  if(!args.confirmation_id)return {code:'CONFIRMATION_REQUIRED',summary:name==='pay'?'Pay ₹3300 for H4, H5, H6?':'Hold H4, H5, H6?',confirmation_id:'test-confirmation'};
  if(name==='pay')return {instructions:'Approve the test UPI request'};
  return {tempTransId:'held',expires_in_seconds:480,seats:['BR - H4, H5, H6']};
 });
 return {alert,state,calls,engine,map,show,claim:()=>{claims++},claims:()=>claims};
}
test('alert buttons are owner-bound, persistent and single-use; expiry prevents claims',()=>{
 const dir=mkdtempSync(join(tmpdir(),'alert-test-'));try{
  const store=new DistrictAlertStore(dir),id=store.create('12345',suggestion());
  expect(bookNowComponents(id)[0]!.components[0]!.custom_id).toBe(`district:booknow:${id}`);
  expect(statSync(join(dir,`${id}.json`)).mode&0o777).toBe(0o600);
  expect(()=>store.read(id,'67890')).toThrow('different user');
  expect(new DistrictAlertStore(dir).claim(id,'12345').seats).toEqual(['H4','H5','H6']);
  expect(()=>store.claim(id,'12345')).toThrow('already used');
  const expired=store.create('12345',suggestion(),Date.now()-25*60*60*1000);expect(()=>store.claim(expired,'12345')).toThrow('expired');
  expect(()=>store.read('../secret','12345')).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('Book Now revalidates the exact three seats, then hold and payment need separate confirmations',async()=>{
 const s=setup(),preview=await s.engine.alertHold(s.alert,s.claim);
 expect(s.claims()).toBe(1);expect(preview.text).toBe('Hold H4, H5, H6?');
 expect(s.calls.filter(c=>c.args.confirmation_id)).toHaveLength(0);
 expect(s.calls.some(c=>c.name==='pay'||c.name==='payment_options')).toBe(false);
 const reply=await s.engine.confirm(preview.confirmation!);
 expect(reply.actions?.[0]?.label).toBe('UPI QR');expect(reply.text).toContain('No payment has been initiated');
 expect(s.calls.filter(c=>c.args.confirmation_id)).toHaveLength(1);
 await expect(s.engine.paymentButton('older-hold',1)).rejects.toThrow('older hold');
 const p=await s.engine.paymentButton(s.state.flow!.methodNonce,1);
 expect(p.text).toBe('Pay ₹3300 for H4, H5, H6?');
 expect(s.calls.filter(c=>c.name==='pay'&&c.args.confirmation_id)).toHaveLength(0);
 const started=await s.engine.confirm(p.confirmation!);expect(started.actions?.[0]?.label).toBe('Check booking status');
 expect((await s.engine.statusButton(s.state.flow!.statusNonce)).text).toContain('paid');
 await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow('already used');
});
test('stale availability, price, adjacency and PXL identity changes never propose a hold',async()=>{
 for(const change of [(s:any)=>s.map.seats[0].status='sold',(s:any)=>s.map.areas[0].price=1100,(s:any)=>s.map.seats[1].grid_seat_number='99',(s:any)=>s.show.premium_label='IMAX']){
  const s=setup();change(s);await expect(s.engine.alertHold(s.alert,s.claim)).rejects.toThrow();
  expect(s.claims()).toBe(0);expect(s.calls.some(c=>c.name==='act'||c.name==='pay')).toBe(false);
 }
});
test('login and existing uncertain actions block alert use; expiry between payment preview and confirmation sends no payment',async()=>{
 const s=setup();s.state.authenticated=false;await expect(s.engine.alertHold(s.alert,s.claim)).rejects.toThrow('Connect');expect(s.calls).toHaveLength(0);
 s.state.authenticated=true;s.state.uncertain='hold';await expect(s.engine.alertHold(s.alert,s.claim)).rejects.toThrow('uncertain');expect(s.calls).toHaveLength(0);
 s.state.uncertain=undefined;const h=await s.engine.alertHold(s.alert,s.claim);await s.engine.confirm(h.confirmation!);
 const p=await s.engine.paymentButton(s.state.flow!.methodNonce,1);s.state.flow!.holdExpiresAt=Date.now()-1;
 await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow('expired');expect(s.calls.some(c=>c.name==='pay'&&c.args.confirmation_id)).toBe(false);
});

test('Book Now accepts the new below-₹800 budget while retaining exact price confirmation',async()=>{
 const s=setup();s.alert.price=720;s.map.areas[0].price=720;
 const preview=await s.engine.alertHold(s.alert,s.claim);expect(preview.confirmation).toBeDefined();
 const proposal=s.calls.find(c=>c.args.operation==='consumer.movie_set_seat');expect(proposal?.args.arguments.ticket_price).toBe(720);
 expect(s.calls.some(c=>c.args.confirmation_id)).toBe(false);
});

test('old alerts above the new ₹1,200 cap cannot start a hold',async()=>{
 const alert=suggestion();alert.price=1201;let called=false;
 const booking=new DistrictBooking({authenticated:true} as any,()=>{},async()=>{called=true;throw Error('Unexpected provider call')});
 await expect(booking.alertHold(alert,()=>{throw Error('Unexpected claim')})).rejects.toThrow('Invalid or expired');expect(called).toBe(false);
});

test('prepared hold clicks recheck geometry and availability without changing the approved arguments',async()=>{
 for(const change of [(s:any)=>s.map.seats[0].status='sold',(s:any)=>s.map.seats.forEach((seat:any)=>seat.grid_row_id='7')]){
  const s=setup();const preview=await s.engine.alertHold(s.alert,s.claim);change(s);
  await expect(s.engine.confirmAlertHold(s.alert,preview.confirmation!)).rejects.toThrow();
  expect(s.calls.some(c=>c.args.confirmation_id)).toBe(false);expect(s.calls.some(c=>c.name==='pay')).toBe(false);
 }
});
