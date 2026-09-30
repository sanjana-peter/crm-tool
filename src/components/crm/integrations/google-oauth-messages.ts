/** What each Google OAuth callback error code means, for the shared and the personal connection pages. */
export const GOOGLE_OAUTH_ERRORS: Record<string, string> = {
  not_configured: "This deployment is missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.",
  denied: "The Google authorization was cancelled.",
  missing_code: "Google did not return an authorization code. Try connecting again.",
  invalid_state: "That authorization link expired. Start the connection again.",
  state_mismatch: "The authorization was started by a different account. Try again.",
  no_refresh_token: "Google did not grant offline access. Remove the app from your Google account's connected apps and connect again.",
  missing_scope: "Calendar access was not granted. Connect again and tick the calendar permission.",
  exchange_failed: "Google rejected the connection. Try again.",
};
