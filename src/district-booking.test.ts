import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DistrictBooking, holdArguments, holdExpiry } from "./district-booking.ts";
import { unpack, DistrictStore, DistrictMcp, type Json, type ConnectionState } from "./district-mcp.ts";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/district-mcp/${name}.json`, import.meta.url), "utf8"));
function setup() {
  const state: ConnectionState = { authenticated: true };
  const calls: { name: string; args: Json }[] = [];
  let failure = false;
  const rpc = async (name: string, args: Json = {}): Promise<Json> => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "search") return { results: [] };
    if (name === "execute") return args.operation === "consumer.movie_showtimes" ? fixture("shows") : fixture("seats");
    if (name === "act" && args.operation === "consumer.movie_promo_validate") return { final_price: 240 };
    if (name === "payment_options") return { methods: [{ ref: "method-one", label: "UPI QR" }] };
    if (name === "payment_status") return { status: "paid", order_id: "ORDERTEST123" };
    if (!args.confirmation_id) return { code: "CONFIRMATION_REQUIRED", summary: name === "pay" ? "Pay ₹240 with UPI QR for seats A9, A8?" : "Hold seats A9, A8 for Ramayana?", confirmation_id: "server-confirmation" };
    if (failure) throw new Error("Interrupted");
    return name === "pay" ? { instructions: "Approve in your UPI app" } : { tempTransId: "held-session-new", expires_in_seconds: 480 };
  };
  return { state, calls, engine: new DistrictBooking(state, () => {}, rpc), fail: () => { failure = true; } };
}
async function prepare(s: ReturnType<typeof setup>) { await s.engine.shows("176276", "2026-11-19", 19.1, 72.8); await s.engine.seats(1); }

test("uses exact grid IDs and one category; unavailable, duplicate and grouped seats are rejected", () => {
  const map = fixture("seats");
  const args = holdArguments(map, ["A9", "A8"], "1067732", "187678");
  expect(args.grid_seat_numbers).toEqual(["3", "4"]); expect(args.temp_trans_id).toBe("test-seat-map-session");
  expect(() => holdArguments(map, ["A5"], "c", "s")).toThrow();
  expect(() => holdArguments(map, ["A9", "A9"], "c", "s")).toThrow();
  map.seat_groups = [{ seat_labels: ["A9", "A8"] }];
  expect(() => holdArguments(map, ["A9"], "c", "s")).toThrow();
});

test("hold and payment each require a distinct explicit confirmation; successful booking status comes from District", async () => {
  const s = setup(); await prepare(s);
  const hold = await s.engine.hold(["A9", "A8"]);
  expect(hold.text).toBe("Hold seats A9, A8 for Ramayana?");
  expect(s.calls.filter((c) => c.args.confirmation_id)).toHaveLength(0);
  await expect(s.engine.pay(1)).rejects.toThrow();
  const held = await s.engine.confirm(hold.confirmation!);
  expect(held.text).toContain("Final total including fees: ₹240");
  const price = s.calls.find((c) => c.args.operation === "consumer.movie_promo_validate")!;
  expect(price.args.arguments.temp_trans_id).toBe("held-session-new");
  const pay = await s.engine.pay(1);
  expect(pay.text).toBe("Pay ₹240 with UPI QR for seats A9, A8?");
  const started = await s.engine.confirm(pay.confirmation!);
  expect(started.text).toContain("not a confirmed booking");
  expect(s.calls.filter((c) => c.name === "pay")).toHaveLength(2);
  await expect(s.engine.confirm(pay.confirmation!)).rejects.toThrow();
  expect((await s.engine.status()).text).toContain("ORDERTEST123");
});

test("confirmation replay, wrong nonce, cancellation and expiry never send a confirmed operation", async () => {
  const s = setup(); await prepare(s); const p = await s.engine.hold(["A9"]);
  await expect(s.engine.confirm("wrong-user-or-nonce")).rejects.toThrow();
  s.state.pending!.expires = Date.now() - 1;
  await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow();
  s.engine.cancel(p.confirmation!);
  await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow();
  expect(s.calls.filter((c) => c.args.confirmation_id)).toHaveLength(0);
});

test("an interrupted hold is never automatically retried or re-confirmed", async () => {
  const s = setup(); await prepare(s); const p = await s.engine.hold(["A9"]); s.fail();
  await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow();
  expect(s.state.uncertain).toBe("hold");
  await expect(s.engine.hold(["A9"])).rejects.toThrow();
  await expect(s.engine.confirm(p.confirmation!)).rejects.toThrow();
  expect(s.calls.filter((c) => c.args.confirmation_id)).toHaveLength(1);
});

test("account files are private and separated by Discord owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "district-state-"));
  try {
    const store = new DistrictStore(dir); store.save("123", { access_token: "private-test-token" });
    expect(store.read("456")).toEqual({}); expect(statSync(join(dir, "123.json")).mode & 0o777).toBe(0o600);
    expect(() => store.read("../123")).toThrow(); store.remove("123"); expect(store.read("123")).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transport initializes MCP, decodes SSE and does not retry failed actions", async () => {
  const state: ConnectionState = { access_token: "guest-test-token" };
  const requests: Json[] = [];
  const fake = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {} } : { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-test" } });
  }) as typeof fetch;
  const client = new DistrictMcp(state, () => {}, fake, "client-test");
  expect(await client.call("search", { query: "movie seats" })).toEqual({ results: [] });
  expect(requests.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  let count = 0;
  const failing = new DistrictMcp({ access_token: "test" }, () => {}, (async () => { count++; throw new Error("offline"); }) as unknown as typeof fetch, "client");
  await expect(failing.call("act", {})).rejects.toThrow("no action was retried"); expect(count).toBe(1);
});

test("event ticket quantities and confirmation use exact IDs; incompatible carts are never cleared automatically", async () => {
  const state: ConnectionState = { authenticated: true };
  const calls: { name: string; args: Json }[] = [];
  const call = async (name: string, args: Json = {}) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === "search") return { results: [] };
    if (name === "execute") return { name: "Test event", booking: { bookable: true }, shows: [{ id: "show-1", start_time: "2027-02-05T15:00:00+05:30", tickets: [{ id: "ticket-real-id", name: "General", available: true, price: 500, min_qty: 1, max_qty: 4 }] }] };
    if (args.confirmation_id) return { cart_id: "cart-current", total: 1100, expires_at: "2027-02-05T14:00:00+05:30" };
    if (name === "payment_options") return { methods: [{ label: "UPI", ref: "upi-current" }] };
    return { code: "CONFIRMATION_REQUIRED", summary: "Hold General ×2 for Test event?", confirmation_id: "event-confirmation" };
  };
  const engine = new DistrictBooking(state, () => {}, call);
  await engine.event("test-event"); await expect(engine.eventHold("1:5")).rejects.toThrow();
  const preview = await engine.eventHold("1:2");
  expect(calls.at(-1)!.args.arguments.ticket_ids).toEqual(["ticket-real-id:2"]);
  await engine.confirm(preview.confirmation!);
  expect(state.flow!.total).toBe(1100);
  expect(state.flow!.payArgs.cart_id).toBe("cart-current");
  expect(calls.some((c) => c.args.operation === "consumer.event_cart_clear")).toBe(false);
});

test("phone and OTP are sent to District only and are never persisted in connection state", async () => {
  const state: ConnectionState = {}; const sent: string[] = [];
  const engine = new DistrictBooking(state, () => {}, async (name, args = {}) => { sent.push(name); return name === "execute" ? { has_cart: false } : { success: true }; });
  await engine.loginPhone("9999999999"); await engine.verify("123456");
  expect(sent).toEqual(["generate_otp", "validate_otp", "execute"]);
  expect(state.authenticated).toBe(true); expect(JSON.stringify(state)).not.toContain("9999999999"); expect(JSON.stringify(state)).not.toContain("123456");
});


test("OTP plain-text replies are accepted only for OTP tools; login is verified by an authenticated read", async () => {
  expect(unpack({ content: [{ type: "text", text: "OTP sent successfully" }] }, true).text_response).toBe(true);
  expect(() => unpack({ content: [{ type: "text", text: "Seats held" }] })).toThrow();
  expect(unpack({ content: [{ type: "text", text: "LOGIN_REQUIRED: please log in" }] }).code).toBe("LOGIN_REQUIRED");
  expect(() => unpack({ isError: true, content: [{ type: "text", text: "Invalid OTP" }] }, true)).toThrow();
  const state: ConnectionState = {};
  const engine = new DistrictBooking(state, () => {}, async (name) => name === "validate_otp" ? { message: "Verification processed", text_response: true } : { code: "LOGIN_REQUIRED" });
  await expect(engine.verify("123456")).rejects.toThrow(); expect(state.authenticated).not.toBe(true);
});


test("parses District's actual plain-text confirmation while preserving the exact summary", () => {
  const summary = "Hold chosen movie seats and see the booking charges (seat labels: B1; ticket count: 1; ticket price: 220). Nothing is paid yet.";
  const text = `CONFIRMATION_REQUIRED: nothing has been done yet. Show the user exactly this and ask them to confirm: "${summary}" If and only if they clearly say yes, call act again with the same arguments and confirmation_id "test-confirmation-id" (valid for 5 minutes). If they say no or change anything, do not call act with this id.`;
  expect(unpack({ content: [{ type: "text", text }] })).toEqual({ code: "CONFIRMATION_REQUIRED", summary, confirmation_tool: "act", confirmation_id: "test-confirmation-id" });
  expect(() => unpack({ content: [{ type: "text", text: 'Confirm it with id "test"' }] })).toThrow();
});


test("hold-only confirmation stops before pricing, payment choices or payment initiation", async () => {
  const s = setup(); await prepare(s); const preview = await s.engine.hold(["A9"]);
  const reply = await s.engine.confirm(preview.confirmation!, "hold-only");
  expect(reply.text).toContain("no payment was initiated");
  expect(s.calls.some((c) => c.name === "payment_options" || c.name === "pay" || c.args.operation === "consumer.movie_promo_validate")).toBe(false);
  expect(s.state.flow!.held.tempTransId).toBe("held-session-new");
});


test("live District hold lifetime is tracked and expired holds cannot initiate payment", async () => {
  expect(holdExpiry({ expires_in_seconds: 480 }, 1000)).toBe(481000);
  expect(holdExpiry({ expires_in_seconds: -1 }, 1000)).toBeUndefined();
  const s = setup(); await prepare(s); const preview = await s.engine.hold(["A9"]); await s.engine.confirm(preview.confirmation!);
  expect(s.state.flow!.holdExpiresAt).toBeGreaterThan(Date.now());
  s.state.flow!.holdExpiresAt = Date.now() - 1;
  await expect(s.engine.pay(1)).rejects.toThrow("expired");
  expect(s.calls.some((c) => c.name === "pay")).toBe(false);
});

test("independent hold verification requires exact seats explicitly sold, never missing or spacing-blocked entries", async () => {
  const { verifyHeldSeats } = await import('./district-booking.ts');
  const before = fixture('seats');
  const after = structuredClone(before);
  const target = after.seats.find((s: Json) => s.label === 'A9');
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('still_available');
  target.status='sold';
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('unavailable_to_guest');
  target.status='blocked';
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('unverified');
  after.seats=[]; after.available_seats=0;
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('unverified');
  after.seats=[{...target,status:'sold',grid_seat_number:'different'}];
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('unverified');
  after.show={...before.show,show_date_time:'different'};
  expect(verifyHeldSeats(before,after,['A9']).status).toBe('unverified');
});

test("guest verification failure preserves the accepted hold without retry or payment in hold-only mode", async () => {
  const s = setup(); await prepare(s); let reads=0;
  const rpc=async(name:string,args:Json={})=>{
    s.calls.push({name,args});
    if(!args.confirmation_id)return {code:'CONFIRMATION_REQUIRED',summary:'Hold A9?',confirmation_id:'test'};
    return {tempTransId:'accepted',expires_in_seconds:480};
  };
  const engine=new DistrictBooking(s.state,()=>{},rpc,async()=>{reads++;throw Error('Read failed')});
  const p=await engine.hold(['A9']);const reply=await engine.confirm(p.confirmation!,'hold-only');
  expect(reads).toBe(1);
  expect(s.state.flow!.held.tempTransId).toBe('accepted');
  expect(s.state.flow!.holdVerification.status).toBe('unverified');
  expect(reply.text).toContain('not been independently verified');
  expect(s.calls.filter(c=>c.args.confirmation_id)).toHaveLength(1);
  expect(s.calls.some(c=>['pay','payment_options'].includes(c.name))).toBe(false);
});

 test('a new transport initializes without sending a cached session id, then uses the new session',async()=>{
 const headers:any[]=[];
 const fake=(async(_url:any,options:any)=>{const b=JSON.parse(options.body);headers.push(options.headers);return b.method==='notifications/initialized'?new Response(null,{status:202}):Response.json({id:b.id,result:b.method==='initialize'?{}:{structuredContent:{ok:true}}},{headers:{'mcp-session-id':'new-session'}})}) as typeof fetch;
 const client=new DistrictMcp({access_token:'test-token',session:'expired-session'},()=>{},fake,'client');await client.call('execute',{});
 expect(headers[0]['Mcp-Session-Id']).toBeUndefined();expect(headers[2]['Mcp-Session-Id']).toBe('new-session');
 });
