// Hosted Rowboat cloud (api.x.rowboatlabs.com) is not used in this slice.
// Leave the constant so leftover billing/analytics modules still compile;
// they are never called because isSignedIn() is always false.
export const API_URL = process.env.API_URL || '';

export const GITHUB_OAUTH_CLIENT_ID =
  process.env.ROWBOAT_GITHUB_CLIENT_ID || 'Ov23liAka106zKEovj4B';
