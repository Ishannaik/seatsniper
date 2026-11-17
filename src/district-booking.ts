import { randomBytes } from "node:crypto";
import { type Json, type ConnectionState, problem } from "./district-mcp.ts";
import type { SeatSuggestion } from "./district-alerts.ts";
export type Caller = (name: string, args?: Json) => Promise<Json>;
export type BookingReply = { text: string; confirmation?: string; confirmationKind?: "hold" | "payment"; actions?: {label:string; id:string}[] };
export function verifyHeldSeats(before: Json, after: Json, labels: string[]): Json {
  if (before.show?.show_date_time !== after.show?.show_date_time || before.show?.cinema !== after.show?.cinema || before.show?.movie !== after.show?.movie) return { status: "unverified", reason: "Different show returned" };
  const observations = labels.map(label => {
    const seat = before.seats?.find((s: Json) => s.label === label);
    const current = seat && after.seats?.find((s: Json) => ["area_code", "area_num", "grid_row_id", "grid_seat_number"].every(k => s[k] === seat[k]));
    return { label, status: current?.status ?? "not_returned" };
  });
  // Missing entries, category totals and cinema spacing blocks do not prove a customer hold.
  return { status: observations.some(s => s.status === "available") ? "still_available" : observations.length > 0 && observations.every(s => s.status === "sold") ? "unavailable_to_guest" : "unverified", observations };
}
function assert(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
function checked(data: Json): Json {
  if (data.success === false || data.valid === false || data.authenticated === false || data.logged_in === false || data.status === "error") throw new Error("District rejected the request. Check the District app before retrying.");
  const code = problem(data);
  if (data.error && !code) throw new Error("District returned an error. No action was retried.");
  if (code) throw new Error(code === "LOGIN_REQUIRED" ? "Connect your District account with /book action:connect first." : `District: ${code}. Check the District app before trying another action.`);
  return data;
}
export function holdArguments(map: Json, labels: string[], cinema: string, session: string): Json {
  assert(labels.length > 0 && labels.length <= Math.min(10, map.max_tickets), "Choose between 1 and the show's maximum tickets.");
  assert(new Set(labels).size === labels.length, "Each seat can be selected only once.");
  assert(map.free_seating === false && Array.isArray(map.seats) && Array.isArray(map.areas), "This flow requires a reserved-seating seat map.");
  const seats = labels.map((label) => map.seats.find((s: Json) => s.label === label));
  assert(seats.every((s: Json) => s && s.status === "available"), "A chosen seat is unavailable. Refresh the seat map.");
  assert(seats.every((s: Json) => s.area_code === seats[0].area_code && s.area_num === seats[0].area_num), "Choose seats in one ticket category.");
  // Seat groups must be selected together; fail closed if membership is ambiguous.
  for (const group of map.seat_groups ?? []) {
    const members = group.seat_labels ?? group.labels;
    assert(Array.isArray(members), "Unsupported grouped-seat layout. Choose these seats in District.");
    if (members.some((label: string) => labels.includes(label))) assert(members.every((label: string) => labels.includes(label)), "Grouped seats must be selected together.");
  }
  const area = map.areas.find((a: Json) => a.area_code === seats[0].area_code && a.area_num === seats[0].area_num);
  assert(area && typeof area.price === "number" && Number.isFinite(area.price) && typeof area.ticket_type === "string" && typeof map.tempTransId === "string" && typeof map.show?.show_date_time === "string", "Incomplete District seat data.");
  const args: Json = { cinema_id: cinema, session_id: session, temp_trans_id: map.tempTransId, show_date_time: map.show.show_date_time, ticket_type: area.ticket_type, ticket_price: area.price, ticket_count: labels.length, seat_labels: labels };
  for (const [key, field] of [["area_codes", "area_code"], ["area_nums", "area_num"], ["grid_row_ids", "grid_row_id"], ["grid_seat_numbers", "grid_seat_number"]]) {
    assert(seats.every((s: Json) => typeof s[field!] === "string"), "Incomplete seat identifiers."); args[key!] = seats.map((s: Json) => s[field!]);
  }
  return args;
}

export function holdExpiry(data: Json, now = Date.now()): number | undefined {
  if (typeof data.expires_in_seconds === "number" && Number.isFinite(data.expires_in_seconds) && data.expires_in_seconds > 0) return now + data.expires_in_seconds * 1000;
  const raw = data.expires_at ?? data.hold_expires_at;
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return Date.parse(raw);
  return undefined;
}

export class DistrictBooking {
  constructor(readonly state: ConnectionState, private save: () => void, private call: Caller, private guestCall?: Caller) {}
  private flow(): Json { assert(this.state.flow, "Start with /book action:shows or action:event."); return this.state.flow; }
  private fresh() { assert(!this.state.pending && !this.state.uncertain, "Finish or cancel the pending confirmation first. An uncertain action must be checked in District before reconnecting."); }
  private login() { assert(this.state.authenticated, "Connect your District account with /book action:connect first."); }
  async loginPhone(phone: string): Promise<BookingReply> {
    assert(/^\d{10}$/.test(phone), "Enter your 10-digit District mobile number (India).");
    this.fresh(); checked(await this.call("generate_otp", { phone_number: phone, country_code: "91" }));
    return { text: "District sent an SMS OTP. Use /book action:verify in this private chat. The bot does not save your phone number or OTP." };
  }
  async verify(otp: string): Promise<BookingReply> {
    assert(/^\d{4,8}$/.test(otp), "Enter the OTP exactly as received.");
    checked(await this.call("validate_otp", { otp }));
    const account = checked(await this.call("execute", { operation: "consumer.event_cart", arguments: {} }));
    assert(typeof account.has_cart === "boolean", "District login could not be verified. No booking action was attempted.");
    this.state.authenticated = true; this.save();
    return { text: "District account connected. Start with /book action:shows or action:event." };
  }
  private async discover(query: string) { checked(await this.call("search", { query, limit: 5 })); }
  async shows(movie: string, date: string, lat: number, lng: number): Promise<BookingReply> {
    this.fresh();
    assert(/^\d+$/.test(movie) && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(lat) && Math.abs(lat) <= 90 && lat !== 0 && Number.isFinite(lng) && Math.abs(lng) <= 180 && lng !== 0, "Provide a District movie link, date and search-area latitude/longitude.");
    await this.discover("Find movie showtimes and available seats for the selected District movie.");
    const d = checked(await this.call("execute", { operation: "consumer.movie_showtimes", arguments: { movie_id: movie, date, lat, lng } }));
    assert(d.date === date && String(d.movie?.id) === movie && Array.isArray(d.cinemas), "District returned a different date/movie or unsupported showtimes.");
    const shows = d.cinemas.flatMap((c: Json) => (c.sessions ?? []).filter((s: Json) => !s.sold_out).map((s: Json) => ({ ...s, cinema_id: c.id, cinema: c.name })));
    this.state.flow = { kind: "movies", movie: d.movie, shows, date }; this.save();
    return { text: shows.length ? `${d.movie.name}\n${shows.slice(0, 20).map((s: Json, i: number) => `${i + 1}. ${s.cinema} · ${s.start_time} · ${s.format ?? ""} · ₹${s.min_price ?? "?"}+`).join("\n")}\nUse /book action:seats show:<number>.` : "No matching shows. Try another date." };
  }
  async seats(index: number): Promise<BookingReply> {
    this.fresh(); const f = this.flow(); assert(f.kind === "movies" && Number.isInteger(index) && index >= 1 && index <= Math.min(20, f.shows.length), "Choose a listed show number.");
    const show = f.shows[index - 1];
    const map = checked(await this.call("execute", { operation: "consumer.movie_select_seat", arguments: { cinema_id: String(show.cinema_id), session_id: String(show.id) } }));
    assert(Array.isArray(map.seats) && Array.isArray(map.areas), "District did not expose a reserved seat map. Use the District app.");
    f.selected = show; f.map = map; f.mapAt = Date.now(); this.save();
    return { text: `${map.show?.movie ?? f.movie.name} · ${map.show?.cinema ?? show.cinema}\n${map.areas.map((a: Json) => `${a.name}: ₹${a.price}`).join(" · ")}\nAvailable: ${map.seats.filter((s: Json) => s.status === "available").slice(0, 150).map((s: Json) => s.label).join(", ")}\nNo seats held. Use /book action:hold seats:F7,F8 for your chosen seats.` };
  }
  async hold(labels: string[]): Promise<BookingReply> {
    this.fresh(); this.login(); const f = this.flow(); assert(f.kind === "movies" && f.map && Date.now() - f.mapAt < 120_000, "Refresh the selected show's seat map first.");
    const args = holdArguments(f.map, labels, String(f.selected.cinema_id), String(f.selected.id));
    return this.propose("hold", "act", { operation: "consumer.movie_set_seat", arguments: args });
  }
  async alertHold(alert: SeatSuggestion, claim: () => void): Promise<BookingReply> {
    this.fresh(); this.login();
    const {data,movie,show,map}=await this.alertData(alert);
    claim();
    this.state.flow={kind:"movies",movie,shows:[{...show,cinema_id:alert.cinema,cinema:data.cinema.name}],selected:{...show,cinema_id:alert.cinema,cinema:data.cinema.name},date:alert.date,map,mapAt:Date.now(),sourceAlert:true};this.save();
    return this.hold(alert.seats);
  }
  private async alertData(alert: SeatSuggestion) {
    assert([alert.movie,alert.cinema,alert.session].every(v=>/^\d+$/.test(v)) && /^\d{4}-\d{2}-\d{2}$/.test(alert.date) && Date.parse(alert.showDateTime)>Date.now() && alert.seats.length===3 && new Set(alert.seats).size===3 && Number.isFinite(alert.price) && alert.price>0 && alert.price<=1200, "Invalid or expired seat suggestion.");
    const data=checked(await this.call("execute",{operation:"consumer.cinema_showtimes",arguments:{cinema_id:alert.cinema,date:alert.date}}));
    const movie=data.movies?.find((m:Json)=>String(m.id)===alert.movie);
    const show=movie?.sessions?.find((s:Json)=>String(s.id)===alert.session);
    assert(String(data.cinema?.id)===alert.cinema && data.date===alert.date && show && !show.sold_out && show.language===alert.language && show.format===alert.format && show.screen===alert.screen && /(^|\s)PXL(\s|$)/i.test(`${show.premium_label??''} ${show.format??''}`) && Date.parse(show.start_time)===Date.parse(alert.showDateTime), "The alerted PXL show changed or is unavailable. No seats held.");
    const map=checked(await this.call("execute",{operation:"consumer.movie_select_seat",arguments:{cinema_id:alert.cinema,session_id:alert.session}}));
    assert(map.show?.movie===movie.name && map.show?.cinema===data.cinema.name && map.show?.screen===alert.screen && map.show?.language===alert.language && Date.parse(map.show?.show_date_time)===Date.parse(alert.showDateTime), "District returned a different seat map. No seats held.");
    const args=holdArguments(map,alert.seats,alert.cinema,alert.session);
    assert(args.ticket_price===alert.price,"The suggested seat price changed. Refresh the alert; no seats held.");
    const chosen=alert.seats.map(label=>map.seats.find((s:Json)=>s.label===label));
    assert(chosen.every((s:Json,i:number)=>s.grid_row_id===chosen[0].grid_row_id && (i===0 || Number(s.grid_seat_number)===Number(chosen[i-1].grid_seat_number)+1)),"The suggested seats are no longer adjacent. No seats held.");
    return {data,movie,show,map,args};
  }
  async confirmAlertHold(alert: SeatSuggestion, nonce: string): Promise<BookingReply> {
    this.login();
    const pending=this.state.pending;
    assert(pending&&pending.nonce===nonce&&pending.expires>Date.now()&&pending.stage==='hold'&&pending.tool==='act'&&pending.args?.operation==='consumer.movie_set_seat', 'This hold confirmation expired or was already used. Wait for the refreshed alert.');
    const {args}=await this.alertData(alert);
    // The provider confirmation stays bound to its original arguments. A fresh
    // read may allocate another transaction ID; never swap that into the hold.
    const original=pending.args.arguments;
    for(const key of Object.keys(args).filter(k=>k!=='temp_trans_id'))assert(JSON.stringify(args[key])===JSON.stringify(original[key]), 'The exact seats, price or show changed. No seats held.');
    return this.confirm(nonce,'hold-only');
  }
  async event(slug: string): Promise<BookingReply> {
    this.fresh(); await this.discover("View event ticket types and booking availability for the selected District event.");
    const d = checked(await this.call("execute", { operation: "consumer.event_page", arguments: { event_slug: slug } }));
    assert(Array.isArray(d.shows) && d.booking?.bookable === true, "This event cannot be booked through District's connector. Use the District app.");
    const tickets = d.shows.filter((s: Json) => !s.sold_out).flatMap((s: Json) => (s.tickets ?? []).filter((t: Json) => t.available).map((t: Json) => ({ ...t, show: s })));
    this.state.flow = { kind: "events", event: d, tickets, readAt: Date.now() }; this.save();
    return { text: `${d.name ?? d.event?.name ?? "Event tickets"}\n${tickets.slice(0, 20).map((t: Json, i: number) => `${i + 1}. ${t.name} · ₹${t.price} · ${t.show.start_time ?? t.show.date ?? ""} · quantity ${t.min_qty}–${t.max_qty}`).join("\n")}\nUse /book action:event_hold tickets:1:2 for 2 tickets of choice 1.` };
  }
  async eventHold(spec: string): Promise<BookingReply> {
    this.fresh(); this.login(); const f = this.flow(); assert(f.kind === "events" && Date.now() - f.readAt < 120_000, "Refresh the event ticket list first.");
    const choices = spec.split(",").map((p) => { assert(/^\d+:\d+$/.test(p.trim()), "Use ticket-number:quantity, e.g. 1:2."); const [i, n] = p.trim().split(":").map(Number); return { ticket: f.tickets[i! - 1], n, i }; });
    assert(choices.length > 0 && choices.length <= 10 && new Set(choices.map((c) => c.i)).size === choices.length, "Select 1–10 distinct ticket types.");
    for (const c of choices) assert(c.ticket && c.n! >= Math.max(1, c.ticket.min_qty) && c.n! <= Math.min(10, c.ticket.max_qty), "Ticket quantity is outside its allowed range.");
    assert(choices.every((c) => c.ticket.show === choices[0]!.ticket.show || (typeof c.ticket.show.id === "string" && c.ticket.show.id === choices[0]!.ticket.show.id)), "Choose tickets for one event show.");
    const event = `${f.event.name ?? f.event.event?.name} · ${choices[0]!.ticket.show.start_time ?? choices[0]!.ticket.show.date ?? ""}`;
    f.eventLabel = event; f.ticketLabels = choices.map((c) => `${c.ticket.name} ×${c.n}`); this.save();
    return this.propose("event_hold", "act", { operation: "consumer.event_cart_update", arguments: { event, ticket_ids: choices.map((c) => `${c.ticket.id}:${c.n}`), ticket_labels: f.ticketLabels } });
  }
  private async propose(stage: string, tool: string, args: Json): Promise<BookingReply> {
    // Never supply a fabricated confirmation. Provider supplies the exact summary and ID.
    this.state.uncertain = stage; this.save();
    const d = await this.call(tool, args);
    if (problem(d) !== "CONFIRMATION_REQUIRED") { checked(d); throw new Error("District did not return the required confirmation. Check the District app before any retry."); }
    const c = d.error ?? d;
    assert(typeof c.summary === "string" && c.summary.length <= 1900 && typeof c.confirmation_id === "string", "Unsupported District confirmation. No confirmation was submitted.");
    const nonce = randomBytes(16).toString("hex");
    this.state.uncertain = undefined;
    this.state.pending = { nonce, stage, tool, args, summary: c.summary, confirmation_id: c.confirmation_id, expires: Date.now() + 120_000 }; this.save();
    return { text: c.summary, confirmation: nonce, confirmationKind:stage==='pay'?'payment':'hold' };
  }
  async confirm(nonce: string, mode: "booking" | "hold-only" = "booking"): Promise<BookingReply> {
    const p = this.state.pending;
    assert(p && p.nonce === nonce && p.expires > Date.now(), "This confirmation expired or was already used. Refresh your booking.");
    assert(mode !== "hold-only" || p.stage === "hold" || p.stage === "event_hold", "Hold-only mode cannot confirm a payment.");
    if(p.stage==="pay")assert(!this.flow().holdExpiresAt||this.flow().holdExpiresAt>Date.now(),"The hold expired. No payment was initiated.");
    this.state.pending = undefined; this.state.uncertain = p.stage; this.save();
    const d = checked(await this.call(p.tool, { ...p.args, confirmation_id: p.confirmation_id }));
    this.state.uncertain = undefined; const f = this.flow();
    if (p.stage === "pay") { f.paymentStarted = true; if(f.renewal)f.renewal.stopped=true; f.statusNonce=randomBytes(16).toString("hex"); this.save(); return { text: "Payment initiated. Complete the payment in your UPI app or District.\n" + paymentInstructions(d) + "\nA payment request is not a confirmed booking.", actions:[{label:"Check booking status",id:`district:status:${f.statusNonce}`}] }; }
    f.held = d; f.holdConfirmedAt = Date.now(); f.holdExpiresAt = holdExpiry(d, f.holdConfirmedAt); this.save();
    if (p.stage === "hold") {
      f.heldSeatLabels=[...p.args.arguments.seat_labels];
      f.holdVerification = { status: "unverified", reason: "No independent guest check available" };
      if (this.guestCall) {
        try {
          const map = checked(await this.guestCall("execute", { operation: "consumer.movie_select_seat", arguments: { cinema_id: p.args.arguments.cinema_id, session_id: p.args.arguments.session_id } }));
          f.holdVerification = { ...verifyHeldSeats(f.map, map, p.args.arguments.seat_labels), checkedAt: Date.now() };
          if (!f.holdExpiresAt || f.holdExpiresAt <= Date.now()) f.holdVerification.status = "unverified";
        } catch { f.holdVerification = { status: "unverified", reason: "Independent guest check failed; hold was not retried" }; }
      }
      this.save();
    }
    if (mode === "hold-only") {
      assert(p.stage === "hold" ? typeof d.tempTransId === "string" : typeof d.cart_id === "string", "District did not return a recognised hold identifier. Check the app before retrying.");
      if(p.stage==='hold'){f.continueNonce=randomBytes(16).toString("hex");this.save();}
      return { text: `District accepted the hold request. ${holdVerificationText(f.holdVerification)} Expiry: ${f.holdExpiresAt ? new Date(f.holdExpiresAt).toISOString() : "see District's hold details"}. Hold only: no payment was initiated.`, actions:p.stage==='hold'?[{label:"Continue to Payment",id:`district:checkout:${f.continueNonce}`}]:undefined };
    }
    if(p.stage==='hold')return this.priceMovieHold(f);
    assert(typeof d.total === "number" && typeof d.cart_id === "string", "District did not return a priced event cart. Check the app."); f.total = d.total;
    f.payArgs = { vertical: "events", cart_id: d.cart_id, event: f.eventLabel, tickets: f.ticketLabels.join(", ") };
    return this.paymentChoices(f);
  }
  async continuePayment(nonce:string):Promise<BookingReply> {
    this.fresh();this.login();const f=this.flow();
    assert(f.kind==='movies'&&f.continueNonce===nonce&&typeof f.held?.tempTransId==='string'&&!f.paymentStarted,'This payment button belongs to an older hold or payment has already started.');
    assert(typeof f.holdExpiresAt==='number'&&f.holdExpiresAt>Date.now(),'The hold expired or its expiry is unknown. No payment was initiated.');
    if(f.pricedAt&&Date.now()-f.pricedAt<60_000&&f.methodNonce&&Array.isArray(f.methods))return this.paymentChoiceReply(f);
    return this.priceMovieHold(f);
  }
  private async priceMovieHold(f:Json):Promise<BookingReply> {
    assert(typeof f.held?.tempTransId==='string'&&Array.isArray(f.heldSeatLabels)&&f.heldSeatLabels.length>0,'The original held-seat details are unavailable. No replacement hold was submitted.');
    assert(!f.holdExpiresAt||f.holdExpiresAt>Date.now(),'The hold expired. No payment was initiated.');
    const price=checked(await this.call('act',{operation:'consumer.movie_promo_validate',arguments:{content_id:String(f.movie.id),temp_trans_id:f.held.tempTransId}}));
    assert(typeof price.final_price==='number','District did not return a final booking total. No payment was initiated.');
    f.total=price.final_price;
    f.payArgs={vertical:'movies',content_id:String(f.movie.id),temp_trans_id:f.held.tempTransId,movie:f.movie.name,show:`${f.selected.cinema} · ${f.selected.start_time}`,seats:f.heldSeatLabels.join(', ')};
    return this.paymentChoices(f);
  }
  private async paymentChoices(f:Json):Promise<BookingReply> {
    assert(!f.holdExpiresAt||f.holdExpiresAt>Date.now(),'The hold expired. No payment was initiated.');
    assert(Number.isFinite(f.total) && f.total > 0, "Invalid final booking total. Check the app.");
    this.save();
    const methods = checked(await this.call("payment_options", { vertical: f.payArgs.vertical, amount: f.total }));
    assert(Array.isArray(methods.methods)&&methods.methods.length>0&&methods.methods.every((m:Json)=>typeof m.ref==='string'&&m.ref.length>0), "Tickets may be held; payment choices were not understood. Complete payment in the District app before expiry.");
    assert(!f.holdExpiresAt||f.holdExpiresAt>Date.now(),"The hold expired. No payment was initiated.");
    f.pricedAt=Date.now();f.methods = methods.methods; f.methodNonce=randomBytes(16).toString("hex"); this.save();
    return this.paymentChoiceReply(f);
  }
  private paymentChoiceReply(f:Json):BookingReply {
    return { text: `District returned a hold. ${holdVerificationText(f.holdVerification)} Final total including fees: ₹${f.total}. Hold expiry: ${f.holdExpiresAt ? new Date(f.holdExpiresAt).toISOString() : "check District; do not assume it remains held"}.\n${f.methods.map((m: Json, i: number) => `${i + 1}. ${m.label}`).join("\n")}\nChoose a payment method below, then approve District's exact payment confirmation. No payment has been initiated.`, actions:f.methods.slice(0,20).map((m:Json,i:number)=>({label:String(m.label).slice(0,70),id:`district:method:${f.methodNonce}:${i+1}`})) };
  }
  async paymentButton(nonce:string,index:number):Promise<BookingReply>{assert(this.flow().methodNonce===nonce,"These payment buttons belong to an older hold.");return this.pay(index)}
  async statusButton(nonce:string):Promise<BookingReply>{assert(this.flow().statusNonce===nonce,"This status button belongs to an older payment.");return this.status()}
  async pay(index: number): Promise<BookingReply> {
    this.fresh(); this.login(); const f = this.flow();
    assert(!f.holdExpiresAt || f.holdExpiresAt > Date.now(), "The hold expired. Refresh the show and choose seats again.");
    assert(!f.paymentStarted && Number.isInteger(index) && f.methods?.[index - 1] && typeof f.methods[index - 1].ref === "string" && f.payArgs && Number.isFinite(f.total), "Choose a current payment method from your held booking.");
    return this.propose("pay", "pay", { ...f.payArgs, method_ref: f.methods[index - 1].ref, amount: f.total });
  }
  async status(): Promise<BookingReply> {
    this.login(); const f = this.flow(); assert(f.paymentStarted || this.state.uncertain === "pay", "No payment has been initiated by this connection.");
    const d = checked(await this.call("payment_status", {}));
    if (["paid", "failed"].includes(d.status)) { this.state.uncertain = undefined; this.save(); }
    return { text: `District payment status: ${d.status ?? "unconfirmed"}.\n${d.order_id ? `Order: ${d.order_id}` : "Check District for the booking confirmation."}` };
  }
  cancel(nonce: string): BookingReply { assert(this.state.pending?.nonce === nonce, "Confirmation is no longer active."); this.state.pending = undefined; this.save(); return { text: "Confirmation cancelled. No confirmation was sent. Existing holds expire according to District's timer." }; }
}
function holdVerificationText(result?: Json): string {
  if (result?.status === "unavailable_to_guest") return "A separate guest seat map shows the selected seats as sold/held.";
  if (result?.status === "still_available") return "WARNING: a separate guest seat map still shows a selected seat available. Exclusivity is not verified.";
  return "Unavailability to other users has not been independently verified.";
}
function paymentInstructions(data: Json): string {
  // Show only payment instructions and public payment links, never credentials or account tokens.
  const lines: string[] = [];
  for (const k of ["instructions", "message", "payment_url", "qr_url", "upi_url"]) if (typeof data[k] === "string") lines.push(data[k]);
  return lines.join("\n").slice(0, 1500) || "Follow the payment instructions in your District app.";
}
