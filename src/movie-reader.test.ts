import { test, expect } from 'bun:test';
import { PublicMovieReader } from './movie-reader.ts';
import { ReadCycle } from './read-cycle.ts';
import type { Target } from './movie-model.ts';
const target:Target={city:'mumbai',slug:'movie',eventCode:'ET000001',date:'20261217'};
test('one native session spans users, format requests coalesce per cycle without mutating cached results',async()=>{
 let starts=0,stops=0,reads=0,dates=0;
 const reader=new PublicMovieReader(async(t)=>{reads++;return {title:'Movie',shows:[{sessionId:t.eventCode,availStatus:'3',showDateCode:t.date,showTime:'18:00',attributes:t.eventCode==='ET000002'?'IMAX 3D':'PXL',epoch:1,venueCode:'C',venueName:'Cinema'}]}},async()=>{dates++;return {title:'Movie',dates:['20261217'],venues:[],chips:[{title:'IMAX 3D',eventCode:'ET000002',slug:'child'}]}},async()=>{starts++},async()=>{stops++});
 const cycle=new ReadCycle();
 const [pxl,imax]=await Promise.all([reader.snapshot({target,format:'PXL'},cycle),reader.snapshot({target,format:'IMAX'},cycle)]);
 expect(starts).toBe(1);expect(reads).toBe(2);expect(dates).toBe(1);
 expect(pxl.shows).toHaveLength(1);expect(imax.shows).toHaveLength(2);
 expect((await reader.snapshot({target},cycle)).shows).toHaveLength(1);
 await reader.snapshot({target},new ReadCycle());expect(reads).toBe(3);
 await Promise.all([reader.close(),reader.close()]);expect(stops).toBe(1);
});
test('District reads never initialize native TLS; initialization failure recovers on a later request',async()=>{
 let starts=0;
 const reader=new PublicMovieReader(async()=>({title:'Movie',shows:[]}),async()=>({title:'Movie',dates:[],venues:[],chips:[]}),async()=>{if(++starts===1)throw Error('init failure')},async()=>{});
 await reader.snapshot({target:{...target,provider:'district'}});expect(starts).toBe(0);
 await expect(reader.snapshot({target})).rejects.toThrow('init failure');
 await reader.snapshot({target});expect(starts).toBe(2);await reader.close();
});
test('a read-cycle shares failure outcomes but a later cycle tries again',async()=>{
 let calls=0;const cycle=new ReadCycle();const read=async()=>{calls++;throw Error('blocked')};
 const a=cycle.once('same',read),b=cycle.once('same',read);expect(a).toBe(b);
 await expect(a).rejects.toThrow('blocked');await expect(b).rejects.toThrow('blocked');expect(calls).toBe(1);
 await expect(new ReadCycle().once('same',read)).rejects.toThrow('blocked');expect(calls).toBe(2);
});
