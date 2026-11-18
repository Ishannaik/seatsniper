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
  }else if(name==='act'&&a.operation==='consumer.movie_promo_validate')data={final_price:3300};
  else if(name==='payment_options')data={methods:[{ref:'fake-method',label:'UPI QR'}]};
  else if(name==='pay')data=a.confirmation_id?{instructions:'Fake UPI instructions; no actual payment'}:{code:'CONFIRMATION_REQUIRED',summary:'Pay exactly ₹3300 with UPI QR?',confirmation_id:'fake-pay-confirmation'};
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

try{
 const sent:any[]=[],edited:any[]=[];
 const send=async(text:string,components:any[]=[])=>{sent.push({text,components});return {channel:'123',message:'456'}};
 const edit=async(delivery:any,text:string,components:any[])=>{edited.push({delivery,text,components});return delivery};
 const preview=await prepareHoldAlert('12345',suggestion);assert('id' in preview);
 await click(holdOnlyComponents(preview.id)[0]!.components[0]!.custom_id);
 const firstWatch=account.read('12345').flow!.renewal;
 assert(firstWatch);assert.equal(calls.filter(c=>c.args.confirmation_id).length,1);
 clock+=400_000;assert(await processHoldExpiry('12345',send,edit));assert.equal(sent.length,0);
 clock+=30_000;await processHoldExpiry('12345',send,edit);assert.equal(sent.length,1);
 assert(sent[0].text.includes('expires'));assert(sent[0].components[0].components[0].disabled);assert.equal(sent[0].components[0].components[1].label,'Stop renewal alerts');
 await processHoldExpiry('12345',send,edit);assert.equal(sent.length,1);assert.equal(edited.length,0);
 assert.equal(calls.filter(c=>c.args.confirmation_id).length,1);
 if(process.argv.includes('--stop-early')){
  await click(`district:stoprenewal:${firstWatch.nonce}`);clock+=60_000;
  const before=calls.length;assert.equal(await processHoldExpiry('12345',send,edit),false);assert.equal(calls.length,before);assert.equal(edited.length,0);
 }else{
  clock+=60_000;
  if(process.argv.includes('--price-changed')){
   price=1300;await processHoldExpiry('12345',send,edit);assert(edited.at(-1).text.includes('not currently available'));assert(edited.at(-1).components[0].components[0].disabled);
   const messages=edited.length;await processHoldExpiry('12345',send,edit);assert.equal(edited.length,messages);
   price=1100;
  }
  await processHoldExpiry('12345',send,edit);
  const ready=edited.at(-1);assert(ready);assert(ready.text.includes('Hold exactly H4, H5, H6'));assert(!ready.components[0].components[0].disabled);
  assert.equal(calls.filter(c=>c.args.confirmation_id).length,1,'Expiry processing must never confirm another hold');
  const newButton=ready.components[0].components[0].custom_id;
  const result=await click(newButton);assert(result.content.includes('no payment was initiated'));
  assert.equal(calls.filter(c=>c.args.confirmation_id).length,2,'One human click confirms one new hold');
  const nextWatch=account.read('12345').flow!.renewal;assert.notEqual(nextWatch.nonce,firstWatch.nonce);assert(nextWatch.expiresAt>clock);
  assert.deepEqual(nextWatch.suggestion.seats,suggestion.seats);assert.equal(nextWatch.suggestion.price,price);
  const before=calls.length;await click(newButton);assert.equal(calls.length,before);
  assert((await click(`district:stoprenewal:${firstWatch.nonce}`)).content.includes('older hold'));assert(!account.read('12345').flow!.renewal.stopped);
  await click(`district:stoprenewal:${nextWatch.nonce}`);clock+=480_000;assert.equal(await processHoldExpiry('12345',send,edit),false);
 }
 assert.equal(calls.filter(c=>c.name==='pay'||c.name==='payment_options'||c.args.operation==='consumer.movie_promo_validate').length,0);
 console.log('Hold expiry flow passed: timed warning, exact seats, fresh human confirmation only, budget, message refresh, stop and replay protection, no payment');
}finally{rmSync(dir,{recursive:true,force:true})}
