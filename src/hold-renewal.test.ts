import {test,expect} from 'bun:test';
import {renewalPhase,renewalSuggestion,renewalComponents,type HoldRenewal} from './hold-renewal.ts';
import type {SeatSuggestion} from './district-alerts.ts';
const suggestion:SeatSuggestion={movie:'176735',cinema:'1018530',session:'123',date:'2099-12-16',showDateTime:'2099-12-16T08:00:00+05:30',screen:'SCREEN 2',language:'English',format:'3D',seats:['H4','H5','H6'],price:1000};
const makeMap=()=>({show:{show_date_time:suggestion.showDateTime,movie:'Avengers: Doomsday',cinema:'PVR ICON Oberoi Mall',screen:'SCREEN 2',language:'English'},areas:[{area_code:'BR',area_num:'1',price:1000}],seats:suggestion.seats.map((label,i)=>({label,area_code:'BR',area_num:'1',grid_row_id:'5',grid_seat_number:String(i+4),status:'available'}))});
test('warning window starts one minute before provider expiry and never implies auto renewal',()=>{
 const now=Date.now(),watch:HoldRenewal={nonce:'a'.repeat(32),suggestion,expiresAt:now+480_000,stopped:false};
 expect(renewalPhase(watch,now)).toBe('waiting');expect(renewalPhase(watch,now+420_000)).toBe('warning');expect(renewalPhase(watch,now+480_000)).toBe('expired');
 watch.stopped=true;expect(renewalPhase(watch,now+480_000)).toBe('stopped');watch.stopped=false;
 expect(renewalPhase(watch,Date.parse(suggestion.showDateTime))).toBe('show-started');
 expect(renewalComponents(watch.nonce)[0]!.components[0].disabled).toBe(true);
 expect(renewalComponents(watch.nonce,'b'.repeat(32))[0]!.components[0].disabled).toBeUndefined();
 expect(renewalComponents(watch.nonce)[0]!.components[1].label).toBe('Stop renewal alerts');
});
test('a renewal requires the same three seats explicitly available with stable geometry and prices within cap',()=>{
 const before=makeMap();expect(renewalSuggestion(suggestion,before,makeMap())?.seats).toEqual(suggestion.seats);
 for(const mutate of [(m:any)=>m.seats.pop(),(m:any)=>m.seats[0].status='sold',(m:any)=>m.seats[0].status='blocked',(m:any)=>m.seats[0].grid_row_id='9',(m:any)=>m.show.cinema='Different cinema',(m:any)=>m.areas[0].price=1201]){
  const after=makeMap();mutate(after);expect(renewalSuggestion(suggestion,before,after)).toBeUndefined();
 }
 const after=makeMap();after.areas[0]!.price=1200;expect(renewalSuggestion(suggestion,before,after)?.price).toBe(1200);
});
