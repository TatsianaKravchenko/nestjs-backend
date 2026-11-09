export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const ACCESS_COOKIE_PATH = '/';
export const REFRESH_COOKIE_PATH = '/auth/refresh';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CLOCK_TOLERANCE_SECONDS = 30;

export const CHALLENGE_TTL_SECONDS = 600;
export const RESEND_AFTER_SECONDS = 60;
export const MAX_OTP_ATTEMPTS = 5;

export const CSRF_HEADER = 'x-csrf-protection';
