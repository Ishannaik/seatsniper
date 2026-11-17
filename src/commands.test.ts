import { expect, test } from 'bun:test';
import { buildCommands, commandSuggestions, resolveBotRuntime } from './commands.ts';
import { dmSlashText } from './dm-command.ts';
import { parseDmWatch } from './dm-watches.ts';
const now = Date.parse('2026-11-17T10:00:00+05:30');
const link = 'https://in.bookmyshow.com/movies/mumbai/test/ET00439706';
const command = (runtime: 'classic' | 'dm', name: string) => buildCommands(runtime).find(c => c.name === name)!;

test('registration makes the chosen runtime explicit and rejects misspelled runtime names', () => {
  expect(resolveBotRuntime({})).toBe('classic');
  expect(resolveBotRuntime({ BOT_RUNTIME: 'dm' })).toBe('dm');
  expect(() => resolveBotRuntime({ BOT_RUNTIME: 'cloud' })).toThrow('BOT_RUNTIME');
});

test('DM slash commands advertise only supported movie-watch options, including exact time', () => {
  const watch = command('dm', 'watch');
  expect(watch.description).not.toContain('event');
  expect(watch.options!.map(o => o.name)).toEqual(['link','date','time','after','before','theatre','format']);
  expect(watch.options!.find(o => o.name === 'date')!.description).not.toContain('any');
  expect(command('dm', 'stop').options![0]!.required).not.toBe(true);
  const values: Record<string,string> = {link,date:'2026-12-17',time:'18:30',format:'PXL 3D',theatre:'Oberoi Mall'};
  const text = dmSlashText('watch', {getString:k=>values[k]??null,getInteger:()=>null,getNumber:()=>null});
  const draft = parseDmWatch(text, now);
  expect(draft.time).toBe(18*60+30);
  expect(draft.format).toBe('PXL 3D');
  expect(draft.theatre).toBe('Oberoi Mall');
});

test('classic commands retain subscription, event, weekday and District category filters', () => {
  const watch = command('classic', 'watch');
  expect(watch.description).toContain('event');
  expect(watch.options!.find(o => o.name === 'date')!.description).toContain('any');
  for (const option of ['days','seats','budget']) expect(watch.options!.some(o => o.name === option)).toBe(true);
  expect(command('classic', 'stop').options![0]!.required).toBe(true);
  expect(command('classic', 'book')).toEqual(command('dm', 'book'));
});

test('both runtimes share format suggestions; only classic advertises weekday completion', () => {
  for (const runtime of ['classic','dm'] as const)
    expect(commandSuggestions(runtime,'watch',{name:'format',value:'PXL,im'}).map(c=>c.value)).toContain('PXL,IMAX');
  expect(commandSuggestions('classic','watch',{name:'days',value:'fr'})).toEqual([{name:'fri',value:'fri'}]);
  expect(commandSuggestions('dm','watch',{name:'days',value:'fr'})).toEqual([]);
  expect(commandSuggestions('dm','book',{name:'format',value:'im'})).toEqual([]);
});
