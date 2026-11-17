import {holdOnlyComponents,type SeatSuggestion} from './district-alerts.ts';
import type {Json} from './district-mcp.ts';
export type RenewalDelivery={channel:string;message:string};
export type RenewalSend=(text:string,components?:Json[])=>Promise<RenewalDelivery|void>;
export type RenewalEdit=(delivery:RenewalDelivery,text:string,components:Json[])=>Promise<RenewalDelivery|void>;
export type HoldRenewal={nonce:string;suggestion:SeatSuggestion;expiresAt:number;stopped:boolean;warnedAt?:number;delivery?:RenewalDelivery;preview?:{id:string;expires:number};lastStatus?:string};
export function renewalPhase(watch:HoldRenewal,now=Date.now()) {
 if(watch.stopped)return 'stopped';
 if(Date.parse(watch.suggestion.showDateTime)<=now)return 'show-started';
 if(watch.expiresAt-now>60_000)return 'waiting';
 return watch.expiresAt>now?'warning':'expired';
}
export function renewalComponents(nonce:string,preparedId?:string):Json[] {
 if(!/^[a-f0-9]{32}$/.test(nonce))throw Error('Invalid renewal identifier');
 const row=holdOnlyComponents(preparedId??'0'.repeat(32))[0]!;
 if(!preparedId)Object.assign(row.components[0]!,{disabled:true});
 row.components.push({type:2,style:2,label:'Stop renewal alerts',custom_id:`district:stoprenewal:${nonce}`});
 return [row];
}
/** Never infer availability from missing/blocked seats, or silently choose substitutes. */
export function renewalSuggestion(original:SeatSuggestion,before:Json,after:Json):SeatSuggestion|undefined {
 if(original.seats.length!==3||before.show?.show_date_time!==after.show?.show_date_time||before.show?.cinema!==after.show?.cinema||before.show?.movie!==after.show?.movie||before.show?.screen!==after.show?.screen||before.show?.language!==after.show?.language)return;
 const chosen=original.seats.map(label=>{
  const seat=before.seats?.find((s:Json)=>s.label===label);
  return seat&&after.seats?.find((s:Json)=>s.label===label&&['area_code','area_num','grid_row_id','grid_seat_number'].every(k=>s[k]===seat[k]));
 });
 if(chosen.some(s=>!s||s.status!=='available'))return;
 if(!chosen.every((s:Json,i:number)=>s.area_code===chosen[0].area_code&&s.area_num===chosen[0].area_num&&s.grid_row_id===chosen[0].grid_row_id&&(i===0||Number(s.grid_seat_number)===Number(chosen[i-1].grid_seat_number)+1)))return;
 const area=after.areas?.find((a:Json)=>a.area_code===chosen[0].area_code&&a.area_num===chosen[0].area_num);
 if(typeof area?.price!=='number'||!Number.isFinite(area.price)||area.price<=0||area.price>1200)return;
 return {...original,price:area.price};
}
