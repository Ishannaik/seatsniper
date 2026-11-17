// Entire Discord interaction flow against a fake District server. Never live.
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DistrictAlertStore,holdOnlyComponents,type SeatSuggestion} from '../district-alerts.ts';
import {DistrictStore,type Json} from '../district-mcp.ts';
import {handleDistrictBooking,prepareHoldAlert,processHoldExpiry} from '../district-booking-discord.ts';
const dir=mkdtempSync(join(tmpdir(),'book-now-flow-'));
process.env.DISTRICT_STATE_DIR=join(dir,'accounts');process.env.MONITOR_STATE_DIR=join(dir,'monitor');process.env.DISTRICT_BOOKING_OWNER_ID='12345';process.env.DISTRICT_OAUTH_CLIENT_ID='fake-client';
let clock=Date.now();Date.now=()=>clock;
const account=new DistrictStore();account.save('12345',{authenticated:true,access_token:'fake-owner',expires_at:Date.now()+3600000});
const suggestion:SeatSuggestion={movie:'176735',cinema:'1018530',session:'123',date:'2099-12-18',showDateTime:'2099-12-18T13:20:00Z',screen:'SCREEN 2',language:'English',format:'3D',seats:['H4','H5','H6'],price:1000};
const show={id:'123',start_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English',format:'3D',premium_label:'PXL'};
let held=false,price=1000,heldUntil=0;const calls:Json[]=[];const confirmations=new Map<string,Json>();let next=0;
globalThis.fetch=Object.assign(async(input:any,options:any)=>{
 const url=String(input);if(url.endsWith('/v2/token'))return Response.json({access_token:'fake-guest',expires_in:3600});
 assert(url==='https://mcp-server.district.in/v2/mcp','Unexpected network destination');
 const rpc=JSON.parse(options.body);if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
 let data:Json={};
 if(rpc.method==='tools/call'){
  const {name,arguments:a}=rpc.params;calls.push({name,args:a});
  if(name==='execute'&&a.operation==='consumer.cinema_showtimes')data={date:suggestion.date,cinema:{id:'1018530',name:'PVR ICON Oberoi Mall Goregaon'},movies:[{id:'176735',name:'Avengers: Doomsday',sessions:[show]}]};
  else if(name==='execute'&&a.operation==='consumer.movie_select_seat')data={free_seating:false,max_tickets:10,tempTransId:'fake-map',show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',show_date_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English'},areas:[{area_code:'BR',area_num:'1',ticket_type:'BR',price}],seats:Array.from({length:12},(_,i)=>({label:`H${i+1}`,status:held&&clock<heldUntil&&suggestion.seats.includes(`H${i+1}`)?'sold':'available',area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+1)}))};
  else if(name==='act'&&a.operation==='consumer.movie_set_seat'){
   if(a.confirmation_id){
    const preview=confirmations.get(a.confirmation_id);assert(preview,'Unknown provider confirmation');
    const actual=structuredClone(a);delete actual.confirmation_id;assert.deepEqual(actual,preview,'Confirmation arguments changed');
    confirmations.delete(a.confirmation_id);held=true;heldUntil=clock+480_000;
    if(process.argv.includes('--ambiguous'))throw Error('Simulated response lost after accepting hold');
    data={tempTransId:'fake-hold',expires_in_seconds:480,seats:['BR - H4, H5, H6']};
   }else{const id=`preview-${++next}`;confirmations.set(id,structuredClone(a));data={code:'CONFIRMATION_REQUIRED',summary:`Hold exactly ${a.arguments.seat_labels.join(', ')} at ₹${a.arguments.ticket_price} each; no payment?`,confirmation_id:id}}
  }else if(name==='act'&&a.operation==='consumer.movie_promo_validate'){assert.equal(a.arguments.temp_trans_id,'fake-hold');if(process.argv.includes('--expire-during-pricing'))clock+=480_001;data={final_price:3300};}
  else if(name==='payment_options')data={methods:[{ref:'fake-method',label:'UPI QR'}]};
  else if(name==='pay'){
   assert.equal(a.temp_trans_id,'fake-hold');assert.equal(a.seats,'H4, H5, H6');assert.equal(a.amount,3300);
   if(a.confirmation_id){assert.equal(a.confirmation_id,'fake-pay-confirmation');if(process.argv.includes('--lost-payment-response'))throw Error('Simulated lost payment response');data={instructions:'Fake UPI instructions; no actual payment'}}
   else data={code:'CONFIRMATION_REQUIRED',summary:'Pay exactly ₹3300 with UPI QR for H4, H5, H6?',confirmation_id:'fake-pay-confirmation'};
  }
  else if(name==='payment_status')data={status:'paid',order_id:'FAKE_ORDER'};
  else throw Error('Unexpected fake operation');
 }
 return Response.json({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:data}});
},{preconnect:()=>{}}) as typeof fetch;
async function click(id:string,owner='12345',guildId:string|null=null){
 let reply:any;
 const interaction:any={customId:id,user:{id:owner},guildId,deferred:false,replied:false,isChatInputCommand:()=>false,isModalSubmit:()=>false,isButton:()=>true,
  deferReply:async()=>{interaction.deferred=true},reply:async(v:any)=>{reply=v;interaction.replied=true},editReply:async(v:any)=>{reply=v}};
 assert(await handleDistrictBooking(interaction));return reply;
}

const button=(reply:any,label:string)=>reply.components.flatMap((r:any)=>r.toJSON().components).find((c:any)=>c.label===label).custom_id;
try{
 const preview=await prepareHoldAlert('12345',suggestion);assert('id' in preview);
 const heldReply=await click(holdOnlyComponents(preview.id)[0]!.components[0]!.custom_id);
 const checkout=button(heldReply,'Continue to Payment');assert(heldReply.content.includes('no payment was initiated'));
 assert.equal(calls.filter(c=>c.name==='pay'||c.name==='payment_options'||c.args.operation==='consumer.movie_promo_validate').length,0);
 const before=calls.length;assert((await click('district:checkout:'+'b'.repeat(32))).content.includes('older hold'));assert.equal(calls.length,before);
 assert((await click(checkout,'99999')).content.includes('configured owner'));assert.equal(calls.length,before);
 if(process.argv.includes('--expire-before-continue'))clock+=480_001;
 const methods=await click(checkout);
 if(process.argv.includes('--expire-before-continue')||process.argv.includes('--expire-during-pricing')){
  assert(methods.content.includes('expired'));assert.equal(calls.filter(c=>c.name==='payment_options'||c.name==='pay').length,0);
 }else{
  assert(methods.content.includes('Final total including fees: ₹3300'));assert(methods.content.includes('No payment has been initiated'));
  const f=account.read('12345').flow!;assert.equal(f.payArgs.temp_trans_id,'fake-hold');assert.equal(f.payArgs.seats,'H4, H5, H6');
  const quoteCalls=calls.length;const duplicate=await click(checkout);assert.equal(calls.length,quoteCalls);assert(duplicate.content.includes('₹3300'));
  const paymentPreview=await click(button(methods,'UPI QR'));assert.equal(paymentPreview.content,'Pay exactly ₹3300 with UPI QR for H4, H5, H6?');
  assert.equal(calls.filter(c=>c.name==='pay'&&c.args.confirmation_id).length,0);
  if(process.argv.includes('--expire-before-confirm'))clock+=480_001;
  const yes=button(paymentPreview,'Confirm Payment'),result=await click(yes);
  if(process.argv.includes('--expire-before-confirm')){
   assert(result.content.includes('expired'));assert.equal(calls.filter(c=>c.name==='pay'&&c.args.confirmation_id).length,0);
  }else if(process.argv.includes('--lost-payment-response')){
   assert(result.content.includes('outcome may be unknown'));assert.equal(account.read('12345').uncertain,'pay');
   const count=calls.length;await click(yes);await click(checkout);assert.equal(calls.length,count);
   assert.equal(calls.filter(c=>c.name==='pay'&&c.args.confirmation_id).length,1);
  }else{
   assert(result.content.includes('Payment initiated'));assert(result.content.includes('not a confirmed booking'));
   assert(account.read('12345').flow!.renewal.stopped);assert.equal(calls.filter(c=>c.name==='pay'&&c.args.confirmation_id).length,1);
   const count=calls.length;await click(yes);await click(checkout);assert.equal(calls.length,count);
   const status=await click(button(result,'Check booking status'));assert(status.content.includes('paid'));assert(status.content.includes('FAKE_ORDER'));
  }
 }
 assert.equal(calls.filter(c=>c.args.operation==='consumer.movie_set_seat'&&c.args.confirmation_id).length,1,'Checkout must never replace or renew the hold');
 console.log('Continue Payment flow passed: same hold and seats, priced total, separate payment confirmation, expiry/stale/replay guards, unknown payment never retried; fake provider only');
}finally{rmSync(dir,{recursive:true,force:true})}
