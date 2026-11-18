process.env.NODE_ENV = 'development';

// Readiness fails without valid user list cursor keys (task 3.1.7); test-only values.
process.env.USER_LIST_CURSOR_ACTIVE_KEY_ID ??= 'e2e';
process.env.USER_LIST_CURSOR_HMAC_KEYS ??=
  'e2e:test-only-user-list-cursor-key-0123456789abcdef';
