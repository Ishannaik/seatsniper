/** Existing opt-in personal movie policy, separate from generic watches and adapters. */
export const legacyMoviePolicy = {
  movie: '176735',
  cinema: '1018530',
  count: 3,
  minimum: 0,
  maximum: 1200,
  preferredRowFromTop: 3,
  language: 'English',
  formatPreference: ['3D', '2D'],
  firstDayFirstShow: true,
  datePriority: ['2026-12-16', '2026-12-17'],
};
export const legacyMovieLink = 'https://www.district.in/movies/avengers-doomsday-movie-tickets-in-mumbai-MV176735';
export const legacyPvrPolicy = { cinema: '349', screen: '880', screenName: 'SCREEN 2', city: 'Mumbai' };
export const legacyPvrLink = 'https://www.pvrcinemas.com/cinemasessions/Mumbai/HDFC-Millennia-PVR-ICON-Oberoi-Mall-Goregaon-E/349';
export const legacyPriceLabel = () => legacyMoviePolicy.maximum.toLocaleString('en-IN');
