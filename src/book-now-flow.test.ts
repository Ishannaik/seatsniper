import {test,expect} from 'bun:test';
test('Discord Book Now holds the exact suggestion only after confirmation, then separately confirms payment',async()=>{
 const child=Bun.spawn([process.execPath,'src/test-support/book-now-flow.ts'],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('Book Now Discord flow passed');
});

for(const ambiguous of [false,true])test(`one-click hold-only alert: ${ambiguous?'unknown result is never retried':'exact seats held once without payment'}`,async()=>{
 const child=Bun.spawn([process.execPath,'src/test-support/hold-only-flow.ts',...(ambiguous?['--ambiguous']:[])],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('One-click hold-only flow passed');
});

for(const scenario of ['', '--stop-early','--price-changed'])test(`hold expiry warning and human re-hold ${scenario}`,async()=>{
 const child=Bun.spawn([process.execPath,'src/test-support/hold-expiry-flow.ts',...(scenario?[scenario]:[])],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('Hold expiry flow passed');
});

for(const scenario of ['', '--expire-before-continue','--expire-during-pricing','--expire-before-confirm','--lost-payment-response'])test(`Continue to Payment preserves the exact hold ${scenario}`,async()=>{
 const child=Bun.spawn([process.execPath,'src/test-support/continue-payment-flow.ts',...(scenario?[scenario]:[])],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('Continue Payment flow passed');
});
