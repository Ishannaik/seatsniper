import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DmWatches } from './dm-watches.ts';
import { UserDmWatches } from './user-dm-watches.ts';
const alice='100000000000000001', bob='100000000000000002';
const now=Date.parse('2026-11-17T10:00:00+05:30');
const watch='watch https://in.bookmyshow.com/movies/mumbai/test/ET00439706 date:2026-12-17';
const show={sessionId:'1',availStatus:'3',showDateCode:'20261217',showTime:'06:50 AM',attributes:'PXL',epoch:Date.parse('2026-12-17T06:50:00+05:30')/1000,venueCode:'ONE',venueName:'Cinema One'};
test('users have private lists, IDs, limits, filters and cancellation across restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'private-watches-'));
 const factory=(p:string)=>new DmWatches(p,async()=>({title:'Movie',shows:[]}),()=>now);
 try {
  let manager=new UserDmWatches(dir,alice,factory);
  await manager.command(alice,watch+' theatre:"Cinema One"');
  await manager.command(bob,watch+' theatre:"Cinema Two"');
  expect(await manager.command(alice,'list')).not.toContain('Cinema Two');
  expect(await manager.command(bob,'list')).not.toContain('Cinema One');
  for(let d=18;d<=21;d++)await manager.command(alice,watch.replace('12-17',`12-${d}`));
  await expect(manager.command(alice,watch.replace('12-17','12-22'))).rejects.toThrow('five');
  expect(await manager.command(bob,watch.replace('12-17','12-22'))).toContain('#2');
  expect(await manager.command(bob,'stop 5')).toContain('No active');
  manager=new UserDmWatches(dir,alice,factory);
  expect(await manager.command(bob,'stop all')).toContain('Stopped 2');
  expect(await manager.command(alice,'list')).toContain('#5');
  expect(await manager.command(bob,'list')).toContain('No active');
  expect(()=>manager.command('../escape','list')).toThrow('Invalid');
 } finally {rmSync(dir,{recursive:true,force:true})}
});
test('alerts go only to each watch owner with their matching filters; blocked DMs do not stop other users',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'private-alerts-'));
 let available=false;
 const factory=(p:string)=>new DmWatches(p,async()=>({title:'Movie',shows:available?[show]:[]}),()=>now);
 try {
  const manager=new UserDmWatches(dir,alice,factory);
  await manager.command(alice,watch+' theatre:"Cinema One"');
  await manager.command(bob,watch+' theatre:"Cinema One"');
  available=true;
  const received:string[]=[];
  await manager.step(async(id)=>{received.push(id);if(id===alice)throw Error('DMs disabled')});
  expect(received).toContain(bob);
  expect(await manager.command(bob,'list')).toContain('No active');
  expect(await manager.command(alice,'list')).toContain('#1');
 } finally {rmSync(dir,{recursive:true,force:true})}
});
test('legacy owner watches never migrate to another user and each user may watch the same target',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-watches-'));
 const factory=(p:string)=>new DmWatches(p,async()=>({title:'Movie',shows:[]}),()=>now);
 try {
  await factory(dir).command(watch);
  const manager=new UserDmWatches(dir,alice,factory);
  expect(await manager.command(alice,'list')).toContain('#1');
  expect(await manager.command(bob,'list')).toContain('No active');
  expect(await manager.command(bob,watch)).toContain('#1');
  await manager.command(bob,'stop all');
  expect(await manager.command(alice,'list')).toContain('#1');
 } finally {rmSync(dir,{recursive:true,force:true})}
});

test('users share public reads within a cycle and close the shared native session once',async()=>{
 const {PublicMovieReader}=await import('./movie-reader.ts');
 const dir=mkdtempSync(join(tmpdir(),'shared-private-reads-'));
 let reads=0,starts=0,stops=0;
 const reader=new PublicMovieReader(async()=>{reads++;return {title:'Movie',shows:[]}},async()=>({title:'Movie',dates:[],venues:[],chips:[]}),async()=>{starts++},async()=>{stops++});
 const manager=new UserDmWatches(dir,alice,p=>new DmWatches(p,reader,()=>now));
 try {
  await manager.command(alice,watch);await manager.command(bob,watch);
  const before=reads;await manager.step(async()=>{});
  expect(reads-before).toBe(1);expect(starts).toBe(1);
  await manager.close();expect(stops).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
