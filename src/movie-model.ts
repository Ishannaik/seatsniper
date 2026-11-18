/** Public listing contracts shared by providers and watch runtimes. */
export type Show = {
  bookingUrl?: string;
  ticketCategories?: { name: string; available: number; price: number }[];
  sessionId: string;
  availStatus: string;
  showDateCode: string; // YYYYMMDD
  showTime: string; // "06:40 AM"
  attributes: string; // "IMAX", "" if none
  /** Unix seconds. Lets Discord render the time in each reader's own locale. */
  epoch: number;
  venueCode: string;
  venueName: string;
};


export type Target = {
  provider?: "bms" | "district";
  city: string; // "mumbai"
  slug: string; // "the-odyssey"
  eventCode: string; // "ET00480917"
  date: string; // YYYYMMDD
};


export type FormatChip = {
  title: string;
  eventCode: string;
  slug: string; // the child event's URL slug, e.g. "spider-man-brand-new-day-3d-screen-x"
};


/**
 * The availability test. A date is bookable iff BookMyShow actually rendered shows
 * FOR THAT DATE — not merely that the page loaded and had shows on it.
 */
export function showsOnDate(shows: Show[], date: string): Show[] {
  return shows.filter((s) => s.showDateCode === date);
}
