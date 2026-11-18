import { expect, test } from 'bun:test';
import { bookingSessions, prepareHoldAlert, processHoldExpiry } from './district-booking-application.ts';
import { handleDistrictBooking } from './district-booking-discord.ts';
import type { SeatSuggestion } from './district-alerts.ts';

const owner = '100000000000000001';
const suggestion: SeatSuggestion = {
  movie: '176735', cinema: '1018530', session: '123', date: '2099-12-16',
  showDateTime: '2099-12-16T08:00:00+05:30', screen: 'SCREEN 2',
  language: 'English', format: '3D', seats: ['H4', 'H5', 'H6'], price: 1000,
};
function withOwner() {
  const previous = process.env.DISTRICT_BOOKING_OWNER_ID;
  process.env.DISTRICT_BOOKING_OWNER_ID = owner;
  return () => {
    bookingSessions.release(owner);
    if (previous === undefined) delete process.env.DISTRICT_BOOKING_OWNER_ID;
    else process.env.DISTRICT_BOOKING_OWNER_ID = previous;
  };
}

test('interactive bookings and background previews use the same owner lock', async () => {
  const clean = withOwner();
  const replies: string[] = [];
  try {
    expect(bookingSessions.tryAcquire(owner)).toBe(true);
    expect(await prepareHoldAlert(owner, suggestion)).toEqual({ unavailable: 'Another District request is in progress.', quiet: true });
    let notices = 0;
    expect(await processHoldExpiry(owner, async () => { notices++; }, async () => { notices++; })).toBe(true);
    await handleDistrictBooking({
      isChatInputCommand: () => true, commandName: 'book', isModalSubmit: () => false,
      isButton: () => false, guildId: null, user: { id: owner },
      reply: async ({ content }: { content: string }) => { replies.push(content); },
    } as any);
    expect(replies).toEqual(['Your previous District request is still running. Please wait.']);
    expect(notices).toBe(0);
    expect(bookingSessions.tryAcquire(owner)).toBe(false);
  } finally { clean(); }
});

test('a failed Discord modal releases the shared owner lock without initializing booking state', async () => {
  const clean = withOwner();
  const replies: string[] = [];
  try {
    await handleDistrictBooking({
      isChatInputCommand: () => true, commandName: 'book', isModalSubmit: () => false,
      isButton: () => false, guildId: null, user: { id: owner },
      options: { getString: () => 'connect' },
      showModal: async () => { throw Error('Discord modal unavailable'); },
      reply: async ({ content }: { content: string }) => { replies.push(content); },
    } as any);
    expect(replies).toEqual(['Discord modal unavailable']);
    expect(bookingSessions.tryAcquire(owner)).toBe(true);
  } finally { clean(); }
});
