import {WATCH_LIMIT_WORD} from './watch-policy.ts';
/** The DM watch options are shared by registration and slash-to-text dispatch. */
export const DM_WATCH_OPTIONS = [
  { name: 'link', description: 'Paste a BookMyShow or District movie link', required: true },
  { name: 'date', description: 'Show date YYYY-MM-DD; required unless the movie link includes a date' },
  { name: 'time', description: 'Exact show time in IST, e.g. 18:30; use instead of after/before' },
  { name: 'after', description: 'Show starts at or after this IST time, e.g. 18:00' },
  { name: 'before', description: 'Show starts before this IST time, e.g. 23:00' },
  { name: 'theatre', description: 'Cinema names, e.g. Oberoi Mall or PVR,Juhu' },
  { name: 'format', description: 'Formats: PXL, IMAX, 3D, 4DX, ScreenX; commas mean any', autocomplete: true },
] as const;
export const DM_WATCH_COMMANDS = ['watch', 'list', 'stop', 'help'] as const;
export type SlashOptions = {
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string): number | null;
  getNumber(name: string): number | null;
};

export function dmSlashText(command: string, options: SlashOptions): string {
  if (command === 'watch') {
    if (options.getString('days') || options.getInteger('seats') !== null || options.getNumber('budget') !== null)
      throw Error('DM watches support date, exact time, time window, theatre and format. Seat-count, budget and weekday filters are not supported here.');
    let text = 'watch ' + options.getString('link', true);
    for (const option of DM_WATCH_OPTIONS) {
      if (option.name === 'link') continue;
      const value = options.getString(option.name);
      if (value) text += ' ' + option.name + ':' + JSON.stringify(value);
    }
    return text;
  }
  if (command === 'stop') return 'stop ' + (options.getInteger('id') ?? 'all');
  if (command === 'list' || command === 'help') return command;
  throw Error('Unsupported watch command.');
}

export const dmWatchHelp='SeatSniper DM watches (BookMyShow and District):\n`watch <movie link> date:YYYY-MM-DD time:18:30 theatre:"Oberoi Mall" format:PXL`\nDate is required unless it is in the link. All times are IST. Optional `after:18:00 before:23:00` replaces exact time. Quote theatre names with spaces. Formats: `PXL`, `IMAX`, `3D`, `2D`, `4DX`, `ScreenX`, `Dolby Atmos`, and more. Use `format:"PXL 3D"` for PXL 3D only, or `format:PXL,IMAX` for either. `PXL` includes PXL 2D and 3D; `IMAX` includes both too. Omit filters to watch any show.\n`list` — watches and health\n`stop <id>` — stop one watch\n`stop all` — stop all your DM watches\n`help` — these instructions\nYour watches and alerts are private to your Discord account. '+WATCH_LIMIT_WORD[0]!.toUpperCase()+WATCH_LIMIT_WORD.slice(1)+' active watches per person. Checks every 30 seconds after each cycle, with backoff on failures. A matching listed show sends one alert and completes that watch. To monitor again, create a new watch. No seats held or payment initiated.';
