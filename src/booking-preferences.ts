import type { Show } from "./bms.ts";
export type BookingPreferences = { seat_count?: number | null; seat_budget?: number | null };
/** Counts are within one ticket category; they never imply seats are adjacent. */
export function matchesBookingPreferences(show: Show, p: BookingPreferences): boolean {
  if (p.seat_count == null && p.seat_budget == null) return true;
  return show.ticketCategories?.some((c) => c.available >= (p.seat_count ?? 1) && (p.seat_budget == null || c.price <= p.seat_budget)) ?? false;
}
export function validateBookingPreferences(p: BookingPreferences): void {
  if (p.seat_count != null && (!Number.isInteger(p.seat_count) || p.seat_count < 1 || p.seat_count > 10)) throw new Error("seats must be a whole number from 1 to 10.");
  if (p.seat_budget != null && (!Number.isFinite(p.seat_budget) || p.seat_budget <= 0)) throw new Error("budget must be a positive price per seat in INR.");
}
