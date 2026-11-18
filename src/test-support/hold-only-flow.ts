// Entire Discord interaction flow against a fake District server. Never live.
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DistrictAlertStore,holdOnlyComponents,type SeatSuggestion} from '../district-alerts.ts';
import {DistrictStore,type Json} from '../district-mcp.ts';
import {handleDistrictBooking,prepareHoldAlert} from '../district-booking-discord.ts';
const dir=mkdtempSync(join(tmpdir(),'book-now-flow-'));
process.env.DISTRICT_STATE_DIR=join(dir,'accounts');process.env.MONITOR_STATE_DIR=join(dir,'monitor');process.env.DISTRICT_BOOKING_OWNER_ID='12345';process.env.DISTRICT_OAUTH_CLIENT_ID='fake-client';
const account=new DistrictStore();account.save('12345',{authenticated:true,access_token:'fake-owner',expires_at:Date.now()+3600000});
const suggestion:SeatSuggestion={movie:'176735',cinema:'1018530',session:'123',date:'2099-12-18',showDateTime:'2099-12-18T13:20:00Z',screen:'SCREEN 2',language:'English',format:'3D',seats:['H4','H5','H6'],price:1000};
const show={id:'123',start_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English',format:'3D',premium_label:'PXL'};
let held=false,price=1000;const calls:Json[]=[];const confirmations=new Map<string,Json>();let next=0;
globalThis.fetch=Object.assign(async(input:any,options:any)=>{
 const url=String(input);if(url.endsWith('/v2/token'))return Response.json({access_token:'fake-guest',expires_in:3600});
 assert(url==='https://mcp-server.district.in/v2/mcp','Unexpected network destination');
 const rpc=JSON.parse(options.body);if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
 let data:Json={};
 if(rpc.method==='tools/call'){
  const {name,arguments:a}=rpc.params;calls.push({name,args:a});
  if(name==='execute'&&a.operation==='consumer.cinema_showtimes')data={date:suggestion.date,cinema:{id:'1018530',name:'PVR ICON Oberoi Mall Goregaon'},movies:[{id:'176735',name:'Avengers: Doomsday',sessions:[show]}]};
  else if(name==='execute'&&a.operation==='consumer.movie_select_seat')data={free_seating:false,max_tickets:10,tempTransId:'fake-map',show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',show_date_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English'},areas:[{area_code:'BR',area_num:'1',ticket_type:'BR',price}],seats:Array.from({length:12},(_,i)=>({label:`H${i+1}`,status:held&&suggestion.seats.includes(`H${i+1}`)?'sold':'available',area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+1)}))};
  else if(name==='act'&&a.operation==='consumer.movie_set_seat'){
   if(a.confirmation_id){
    const preview=confirmations.get(a.confirmation_id);assert(preview,'Unknown provider confirmation');
    const actual=structuredClone(a);delete actual.confirmation_id;assert.deepEqual(actual,preview,'Confirmation arguments changed');
    confirmations.delete(a.confirmation_id);held=true;
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
 const store=new DistrictAlertStore();
 const first=await prepareHoldAlert('12345',suggestion);assert('id' in first);
 const other=await prepareHoldAlert('12345',{...suggestion,seats:['H7','H8','H9']});assert('id' in other);
 assert.notEqual(first.id,other.id);assert(!held);assert(!account.read('12345').pending);assert(!account.read('12345').flow);
 assert.equal(calls.filter(c=>c.args.confirmation_id).length,0);
 const draft=store.readPrepared(first.id,'12345');assert.equal(draft.pending.summary,first.summary);
 assert(!JSON.stringify(draft).includes('fake-owner'));assert(!JSON.stringify(draft).includes('access_token'));
 const button=holdOnlyComponents(first.id)[0]!.components[0]!;assert.equal(button.label,'Confirm Hold — No Payment');
 const before=calls.length;
 assert((await click(button.custom_id,'99999')).content.includes('configured owner'));
 assert((await click(button.custom_id,'12345','guild')).content.includes('private DM'));assert.equal(calls.length,before);
 // A price change rejects the click before any confirmed mutation and releases the local draft.
 price=1100;assert((await click(button.custom_id)).content.includes('price changed'));assert(!held);assert(!account.read('12345').pending);assert(!account.read('12345').uncertain);
 price=1000;
 const expired=await prepareHoldAlert('12345',suggestion);assert('id' in expired);
 const fs=await import('node:fs');const path=join(store.directory,expired.id+'.json');const record=JSON.parse(fs.readFileSync(path,'utf8'));record.expires=0;fs.writeFileSync(path,JSON.stringify(record));
 assert((await click(holdOnlyComponents(expired.id)[0]!.components[0]!.custom_id)).content.includes('expired'));assert(!held);
 const ready=await prepareHoldAlert('12345',suggestion);assert('id' in ready);
 const result=await click(holdOnlyComponents(ready.id)[0]!.components[0]!.custom_id);
 assert(held);assert.equal(calls.filter(c=>c.args.confirmation_id).length,1);
 assert.equal(calls.filter(c=>c.name==='pay'||c.name==='payment_options'||c.args.operation==='consumer.movie_promo_validate').length,0);
 if(process.argv.includes('--ambiguous'))assert.deepEqual(result.components,[]);else{const labels=result.components[0].toJSON().components.map((c:any)=>c.label);assert(labels.includes('Continue to Payment'));assert(labels.includes('Stop renewal alerts'));}
 if(process.argv.includes('--ambiguous')){assert(result.content.includes('outcome may be unknown'));assert.equal(account.read('12345').uncertain,'hold')}
 else{assert(result.content.includes('no payment was initiated'));assert(result.content.includes('sold/held'));assert(!account.read('12345').uncertain)}
 const after=calls.length;await click(holdOnlyComponents(ready.id)[0]!.components[0]!.custom_id);await click(holdOnlyComponents(other.id)[0]!.components[0]!.custom_id);assert.equal(calls.length,after);
 const blocked=await prepareHoldAlert('12345',suggestion);assert('unavailable' in blocked&&blocked.quiet);
 console.log('One-click hold-only flow passed: previews isolated, exact summary, single confirmed hold, owner checks, price/expiry/replay guards, no payment, unknown outcomes blocked');
}finally{rmSync(dir,{recursive:true,force:true})}
