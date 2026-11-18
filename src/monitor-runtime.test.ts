import { test, expect } from 'bun:test';
import { MonitorSession, MonitorPoller, type PollState } from './monitor-runtime.ts';
import { DistrictHttpError } from './district-mcp.ts';

function provider() {
 const calls:any[]=[];let failure=0;let sessions=0;
 const request=(async(url:any,init:any)=>{
  if(String(url).endsWith('/token')){calls.push({method:'token'});return Response.json({access_token:'guest-secret',expires_in:3600})}
  const body=JSON.parse(init.body);calls.push({method:body.method,headers:init.headers,params:body.params});
  if(body.method==='initialize')return Response.json({id:body.id,result:{protocolVersion:'2025-03-26',capabilities:{}}},{headers:{'mcp-session-id':`session-${++sessions}`}});
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(failure){const status=failure;failure=0;return new Response(null,{status,headers:{'retry-after':'75'}})}
  return Response.json({id:body.id,result:{structuredContent:{ok:true}}});
 }) as typeof fetch;
 return {calls,request,fail:(status:number)=>{failure=status}};
}
const operation='consumer.cinema_showtimes';

test('successive polling cycles reuse one guest token and MCP session, never exposing credentials in stats',async()=>{
 const p=provider(),session=new MonitorSession(p.request,'test-client');
 await session.read(operation,{date:'2026-12-16'});await session.read(operation,{date:'2026-12-17'});
 expect(p.calls.map(c=>c.method)).toEqual(['token','initialize','notifications/initialized','tools/call','tools/call']);
 expect(p.calls.filter(c=>c.method==='tools/call').map(c=>c.headers['Mcp-Session-Id'])).toEqual(['session-1','session-1']);
 expect(session.stats).toEqual({tokenRequests:1,initializations:1,readCalls:2});expect(JSON.stringify(session.stats)).not.toContain('secret');
 await expect(session.read('consumer.movie_set_seat',{})).rejects.toThrow('Mutation forbidden');expect(p.calls).toHaveLength(5);
});

test('expired MCP sessions reinitialize only on the next scheduled read while retaining the guest token',async()=>{
 const p=provider(),session=new MonitorSession(p.request,'test-client');await session.read(operation,{});
 p.fail(404);await expect(session.read(operation,{})).rejects.toBeInstanceOf(DistrictHttpError);
 expect(session.stats).toEqual({tokenRequests:1,initializations:1,readCalls:2});
 await session.read(operation,{});expect(session.stats).toEqual({tokenRequests:1,initializations:2,readCalls:3});
 expect(p.calls.at(-1).headers['Mcp-Session-Id']).toBe('session-2');
});

test('rate limiting does not rotate sessions or retry immediately; expired authentication renews next cycle',async()=>{
 const p=provider(),session=new MonitorSession(p.request,'test-client');await session.read(operation,{});
 p.fail(429);try{await session.read(operation,{})}catch(e){expect((e as DistrictHttpError).retryAfterMs).toBe(75_000)}
 expect(p.calls.filter(c=>c.method==='tools/call')).toHaveLength(2);
 await session.read(operation,{});expect(session.stats.tokenRequests).toBe(1);expect(session.stats.initializations).toBe(1);
 p.fail(401);await expect(session.read(operation,{})).rejects.toThrow('401');expect(session.stats.tokenRequests).toBe(1);
 await session.read(operation,{});expect(session.stats.tokenRequests).toBe(2);expect(session.stats.initializations).toBe(2);
});

test('HTTP cooldowns support seconds and dates, and ignore malformed or past values',()=>{
 const now=Date.parse('2026-11-16T12:00:00Z');
 const error=(v:string)=>new DistrictHttpError(429,new Headers({'retry-after':v}),'District',now);
 expect(error('90').retryAfterMs).toBe(90_000);
 expect(error('Mon, 16 Nov 2026 12:03:00 GMT').retryAfterMs).toBe(180_000);
 expect(error('bad').retryAfterMs).toBe(0);expect(error('Mon, 16 Nov 2026 11:00:00 GMT').retryAfterMs).toBe(0);
});

test('backoff increases on failures, suppresses early requests and returns to 30 seconds on success',async()=>{
 let now=1000,calls=0,failing=true;const saved:PollState[]=[];
 const poller=new MonitorPoller(async()=>{calls++;if(failing)throw Error('offline')},30_000,{},s=>saved.push(s),()=>now,()=>0);
 expect(await poller.step()).toBe(60_000);expect(calls).toBe(1);
 expect(await poller.step()).toBe(60_000);expect(calls).toBe(1);
 now+=60_000;expect(await poller.step()).toBe(120_000);
 now+=120_000;failing=false;expect(await poller.step()).toBe(30_000);
 expect(poller.state.failureCount).toBe(0);expect(poller.state.lastError).toBeUndefined();expect(saved).toHaveLength(3);
});

test('Retry-After survives a process restart and overrides the exponential-backoff cap',async()=>{
 let now=1000,calls=0,saved:PollState|undefined;
 const first=new MonitorPoller(async()=>{calls++;throw new DistrictHttpError(429,new Headers({'retry-after':'1800'}))},30_000,{},s=>{saved=s},()=>now,()=>0);
 expect(await first.step()).toBe(1_800_000);
 const restarted=new MonitorPoller(async()=>{calls++},30_000,saved,()=>{},()=>now,()=>0);
 now+=30_000;expect(await restarted.step()).toBe(1_770_000);expect(calls).toBe(1);
 now+=1_770_000;expect(await restarted.step()).toBe(30_000);expect(calls).toBe(2);
});

test('ordinary failures have bounded jitter and cap at 15 minutes',async()=>{
 let now=1000;
 const p=new MonitorPoller(async()=>{throw Error('temporary failure')},30_000,{},()=>{},()=>now,()=>1);
 expect(await p.step()).toBe(66_000);
 for(let i=0;i<8;i++){now=p.state.nextCheckAt;await p.step()}
 expect(p.state.nextCheckAt-now).toBe(900_000);
});

test('concurrent tick requests share one in-flight check and cannot overlap',async()=>{
 let finish!:()=>void,calls=0;
 const p=new MonitorPoller(async()=>{calls++;await new Promise<void>(r=>{finish=r})},30_000,{},()=>{},()=>1000,()=>0);
 const a=p.step(),b=p.step();expect(calls).toBe(1);finish();expect(await a).toBe(30_000);expect(await b).toBe(30_000);
 expect(()=>new MonitorPoller(async()=>{},15_000)).toThrow('at least 30');
});

test('cached guest credentials survive restarts and refresh without requesting a new guest session',async()=>{
 const requests:any[]=[];const saved:any[]=[];
 const p=provider();const request=(async(url:any,init:any)=>{
  if(String(url).endsWith('/token'))requests.push(Object.fromEntries(new URLSearchParams(init.body)));
  return p.request(url,init);
 }) as typeof fetch;
 const session=new MonitorSession(request,'client',{access_token:'expired-guest',refresh_token:'existing-refresh',expires_at:0},s=>saved.push({...s}));
 await session.read(operation,{});expect(requests).toHaveLength(1);expect(requests[0].grant_type).toBe('refresh_token');expect(requests[0].refresh_token).toBe('existing-refresh');
 const cached=saved.at(-1);expect(cached.access_token).toBe('guest-secret');
 const restarted=new MonitorSession(request,'client',cached);await restarted.read(operation,{});expect(requests).toHaveLength(1);
 expect(()=>new MonitorSession(request,'client',{authenticated:true,access_token:'owner-token'})).toThrow('separate guest');
});
