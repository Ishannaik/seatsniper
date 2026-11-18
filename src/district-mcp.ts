/** Official District personal MCP transport. Per-user tokens and sessions, no automatic action retries. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "./json.ts";
export type { Json } from "./json.ts";
import { HttpError } from "./http-error.ts";
/** Preserve server cooldowns without retrying a booking or payment. */
export class DistrictHttpError extends HttpError {
  constructor(status: number, headers: Headers, context = 'District', now = Date.now()) {
    super(status, headers, context, now);
    this.name = 'DistrictHttpError';
  }
}
import {unpack,problem} from './district-response.ts';
export {unpack,problem} from './district-response.ts';
import type {ConnectionState} from './district-state.ts';
export type {ConnectionState} from './district-state.ts';
export class DistrictStore {
  constructor(readonly directory = process.env.DISTRICT_STATE_DIR ?? ".runtime/district-users") { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
  private path(user: string) { if (!/^\d{1,24}$/.test(user)) throw new Error("Invalid Discord identity"); return join(this.directory, `${user}.json`); }
  read(user: string): ConnectionState { const p = this.path(user); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; }
  save(user: string, state: ConnectionState) { const p = this.path(user), tmp = `${p}.tmp`; writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, p); }
  remove(user: string) { const p = this.path(user); if (existsSync(p)) unlinkSync(p); }
}
export class DistrictMcp {
  private id = 0;
  private initialized = false;
  constructor(readonly state: ConnectionState, private persist: () => void, private request: typeof fetch = fetch, private clientId?: string) {}
  private async bearer() {
    if (this.state.access_token && (this.state.expires_at ?? Infinity) > Date.now() + 30_000) return;
    if (this.state.access_token && !this.state.refresh_token) throw new Error("District connection expired. Reconnect in Discord; pending actions will not be retried.");
    const config = this.clientId ?? process.env.DISTRICT_OAUTH_CLIENT_ID ?? JSON.parse(readFileSync(".runtime/district-client.json", "utf8")).client_id;
    const body = new URLSearchParams({ client_id: config, grant_type: this.state.refresh_token ? "refresh_token" : "urn:district:params:oauth:grant-type:guest", scope: "district" });
    if (this.state.refresh_token) body.set("refresh_token", this.state.refresh_token);
    const res = await this.request("https://mcp-server.district.in/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(25_000), redirect: "error" });
    if (!res.ok) throw new DistrictHttpError(res.status, res.headers, 'District authentication');
    const token = await res.json() as Json;
    if (typeof token.access_token !== "string") throw new Error("District returned no access token.");
    this.state.access_token = token.access_token;
    if (token.refresh_token) this.state.refresh_token = token.refresh_token;
    if (Number.isFinite(token.expires_in)) this.state.expires_at = Date.now() + token.expires_in * 1000;
    this.persist();
  }
  private async rpc(method: string, params?: Json, notification = false): Promise<Json> {
    await this.bearer();
    const id = ++this.id;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${this.state.access_token}`, "MCP-Protocol-Version": "2025-03-26" };
    if (this.state.session && method !== "initialize") headers["Mcp-Session-Id"] = this.state.session;
    let res: Response;
    try { res = await this.request("https://mcp-server.district.in/v2/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notification ? {} : { id }) }), signal: AbortSignal.timeout(30_000), redirect: "error" }); }
    catch { throw new Error("District request interrupted. Its outcome may be unknown; no action was retried."); }
    if (!res.ok) throw new DistrictHttpError(res.status, res.headers);
    const session = res.headers.get("mcp-session-id"); if (session) { this.state.session = session; this.persist(); }
    if (notification && res.status === 202) return {};
    const text = await res.text(); if (!text && notification) return {};
    let message: Json;
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      const messages = text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")).filter(Boolean).map((v) => JSON.parse(v));
      message = messages.find((m) => m.id === id);
    } else message = JSON.parse(text);
    if (!message || message.error) throw new Error(`District protocol error${message?.error?.code ? ` (${message.error.code})` : ""}. No action was retried.`);
    return message.result ?? {};
  }
  async call(name: string, args: Json = {}): Promise<Json> {
    if (!this.initialized) {
      await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "seatsniper-personal", version: "0.3.0" } });
      await this.rpc("notifications/initialized", undefined, true); this.initialized = true;
    }
    const result = unpack(await this.rpc("tools/call", { name, arguments: args }), ["generate_otp", "validate_otp", "resend_otp"].includes(name));
    if (result.confirmation_tool && result.confirmation_tool !== name) throw new Error("District confirmation tool did not match the request. No confirmation submitted.");
    return result;
  }
}
