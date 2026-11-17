import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import {DistrictMcp,DistrictHttpError} from './district-mcp.ts';
import type {ConnectionState} from './district-state.ts';
import type {Json} from './json.ts';

/** Guest only. Never shares the owner's booking session or retries actions. */
export class MonitorSession {
  private state: ConnectionState = {};
  private client: DistrictMcp;
  readonly stats = { tokenRequests: 0, initializations: 0, readCalls: 0 };
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch, private clientId?: string, initial: ConnectionState = {},
    private persist: (state: ConnectionState) => void = () => {}) {
    if (initial.authenticated || initial.flow || initial.pending || initial.uncertain) throw Error('Monitor requires a separate guest connection');
    this.state = { access_token: initial.access_token, refresh_token: initial.refresh_token, expires_at: initial.expires_at };
    this.request = (async (url, init) => {
      if (String(url).endsWith('/token')) this.stats.tokenRequests++;
      else if (typeof init?.body === 'string' && JSON.parse(init.body).method === 'initialize') this.stats.initializations++;
      return request(url, init);
    }) as typeof fetch;
    this.client = this.connect();
  }
  private connect() { return new DistrictMcp(this.state, () => this.persist(this.state), this.request, this.clientId); }
  async read(operation: string, args: Json): Promise<Json> {
    if (!['consumer.cinema_showtimes', 'consumer.movie_select_seat'].includes(operation)) throw Error('Mutation forbidden');
    this.stats.readCalls++;
    try { return await this.client.call('execute', { operation, arguments: args }); }
    catch (error) {
      // Recover on the NEXT scheduled cycle, never immediately and never on 429.
      if (error instanceof DistrictHttpError && [401, 404].includes(error.status)) {
        if (error.status === 401) { delete this.state.access_token; this.state.expires_at = 0; }
        delete this.state.session;
        this.persist(this.state);
        this.client = this.connect();
      }
      throw error;
    }
  }
}

export {MonitorPoller,type PollState} from './polling.ts';

let monitorSession: MonitorSession | undefined;
export function getMonitorSession() {
 if(monitorSession)return monitorSession;
 const directory=process.env.MONITOR_STATE_DIR??'.runtime/doomsday-monitor';mkdirSync(directory,{recursive:true,mode:0o700});
 const path=`${directory}/guest-connection.json`;
 const stored=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
 if(stored&&stored.kind!=='monitor-guest')throw Error('Invalid monitor guest credential file');
 monitorSession=new MonitorSession(fetch,undefined,stored?.connection??{},state=>{
  const connection={access_token:state.access_token,refresh_token:state.refresh_token,expires_at:state.expires_at};
  writeFileSync(`${path}.tmp`,JSON.stringify({kind:'monitor-guest',connection}),{mode:0o600});renameSync(`${path}.tmp`,path);
 });
 return monitorSession;
}
