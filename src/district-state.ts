import type {Json} from './json.ts';
export type ConnectionState = { access_token?: string; refresh_token?: string; expires_at?: number; session?: string; authenticated?: boolean; flow?: Json; pending?: Json; uncertain?: string };
