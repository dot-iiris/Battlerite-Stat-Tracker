// Where to go after logging in: the page someone opened before being sent to /login.

// Discord login comes back to /me; the login page stores the wanted page here for MyProfile.
export const LOGIN_NEXT_KEY = "br_login_next";

// Only same-site paths ("/x", not "//host" or "https://...") are allowed.
export function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    && !next.startsWith("/login") && !next.startsWith("/admin-login") ? next : null;
}
