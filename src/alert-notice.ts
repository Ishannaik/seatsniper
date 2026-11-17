import type {Json} from './json.ts';

export const reminderStopId = 'seatsniper:reminders:stop';
/** Interpret the existing Discord alert protocol at a single boundary. */
export function classifySeatNotice(components: Json[], content = '') {
  const buttons = components.flatMap(row => row.components ?? []);
  const confirm = buttons.find(button => String(button.custom_id).startsWith('district:holdonly:'));
  const renewal = buttons.some(button => String(button.custom_id).startsWith('district:stoprenewal:'));
  const expiryTimes = [...content.matchAll(/<t:(\d+):R>/g)].map(match => Number(match[1]) * 1000);
  return {
    holdReady: Boolean(confirm && !confirm.disabled),
    reminderKind: renewal ? 'renewal' : 'seats',
    voiceKind: !confirm || confirm.disabled && !renewal ? undefined
      : renewal ? confirm.disabled ? 'expiry' : 'renewal-ready' : 'seats',
    expires: expiryTimes.at(-1) ?? 0,
  };
}
export function acknowledgesSeatNotice(customId: string): boolean {
  return [reminderStopId, 'district:holdonly', 'district:yes', 'district:no', 'district:stoprenewal']
    .some(prefix => customId === prefix || customId.startsWith(prefix + ':'));
}
