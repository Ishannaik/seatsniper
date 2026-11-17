// Entire Discord interaction flow against a fake District server. Never live.
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DistrictAlertStore,bookNowComponents,type SeatSuggestion} from '../district-alerts.ts';
import {DistrictStore,type Json} from '../district-mcp.ts';
import {handleDistrictBooking} from '../district-booking-discord.ts';
const dir=mkdtempSync(join(tmpdir(),'book-now-flow-'));
process.env.DISTRICT_STATE_DIR=join(dir,'accounts');process.env.MONITOR_STATE_DIR=join(dir,'monitor');process.env.DISTRICT_BOOKING_OWNER_ID='12345';process.env.DISTRICT_OAUTH_CLIENT_ID='fake-client';
const account=new DistrictStore();account.save('12345',{authenticated:true,access_token:'fake-owner',expires_at:Date.now()+3600000});
const suggestion:SeatSuggestion={movie:'176735',cinema:'1018530',session:'123',date:'2099-12-18',showDateTime:'2099-12-18T13:20:00Z',screen:'SCREEN 2',language:'English',format:'3D',seats:['H4','H5','H6'],price:1000};
const show={id:'123',start_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English',format:'3D',premium_label:'PXL'};
let held=false;const calls:Json[]=[];
globalThis.fetch=Object.assign(async(input:any,options:any)=>{
 const url=String(input);if(url.endsWith('/v2/token'))return Response.json({access_token:'fake-guest',expires_in:3600});
 assert(url==='https://mcp-server.district.in/v2/mcp','Unexpected network destination');
 const rpc=JSON.parse(options.body);if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
 let data:Json={};
 if(rpc.method==='tools/call'){
  const {name,arguments:a}=rpc.params;calls.push({name,args:a});
  if(name==='execute'&&a.operation==='consumer.cinema_showtimes')data={date:suggestion.date,cinema:{id:'1018530',name:'PVR ICON Oberoi Mall Goregaon'},movies:[{id:'176735',name:'Avengers: Doomsday',sessions:[show]}]};
  else if(name==='execute'&&a.operation==='consumer.movie_select_seat')data={free_seating:false,max_tickets:10,tempTransId:'fake-map',show:{movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall Goregaon',show_date_time:suggestion.showDateTime,screen:'SCREEN 2',language:'English'},areas:[{area_code:'BR',area_num:'1',ticket_type:'BR',price:1000}],seats:suggestion.seats.map((label,i)=>({label,status:held?'sold':'available',area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+4)}))};
  else if(name==='act'&&a.operation==='consumer.movie_set_seat'){
   if(a.confirmation_id){held=true;data={tempTransId:'fake-hold',expires_in_seconds:480,seats:['BR - H4, H5, H6']}}
   else data={code:'CONFIRMATION_REQUIRED',summary:'Hold exactly H4, H5, H6?',confirmation_id:'fake-hold-confirmation'};
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
const firstId=(reply:any)=>reply.components[0].toJSON().components[0].custom_id;
try{
 const store=new DistrictAlertStore(),id=store.create('12345',suggestion),button=bookNowComponents(id)[0]!.components[0]!;
 assert.equal(button.label,'Book Now');
 assert((await click(button.custom_id,'99999')).content.includes('configured owner'));
 assert((await click(button.custom_id,'12345','guild')).content.includes('private DM'));
 assert.equal(calls.length,0);
 const preview=await click(button.custom_id);assert.equal(preview.content,'Hold exactly H4, H5, H6?');assert.equal(held,false);
 assert.equal(calls.filter(c=>c.args.confirmation_id).length,0);
 const hold=await click(firstId(preview));assert(held);assert(hold.content.includes('₹3300'));assert(hold.content.includes('sold/held'));
 assert.equal(hold.components[0].toJSON().components[0].label,'UPI QR');assert.equal(calls.filter(c=>c.name==='pay').length,0);
 const pay=await click(firstId(hold));assert.equal(pay.content,'Pay exactly ₹3300 with UPI QR?');
 assert.equal(calls.filter(c=>c.name==='pay'&&c.args.confirmation_id).length,0);
 const started=await click(firstId(pay));assert(started.content.includes('Payment initiated'));assert.equal(started.components[0].toJSON().components[0].label,'Check booking status');
 const status=await click(firstId(started));assert(status.content.includes('paid'));assert(status.content.includes('FAKE_ORDER'));
 const before=calls.length;assert((await click(button.custom_id)).content.includes('already used'));assert.equal(calls.length,before);
 console.log('Book Now Discord flow passed: owner, fresh seats, hold confirmation, payment buttons, payment confirmation, status, replay protection; fake provider only');
}finally{rmSync(dir,{recursive:true,force:true})}
