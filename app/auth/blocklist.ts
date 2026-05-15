// A tiny embedded blocklist for v1. Covers the most-common passwords we
// don't want anyone in our flat to pick. Not a substitute for the full
// 10k list, but better than nothing — TECH.md §4.4 acknowledges this.
const BLOCKED = new Set<string>([
  "password",
  "password1",
  "password123",
  "passwort",
  "passwort1",
  "passwort123",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "qwertz",
  "qwertz123",
  "12345678",
  "123456789",
  "1234567890",
  "111111111",
  "letmein",
  "letmein123",
  "iloveyou",
  "welcome1",
  "welcome123",
  "admin1234",
  "admin12345",
  "administrator",
  "monkey1234",
  "abcdefghijkl",
  "cookbook1234",
  "kochbuch1234",
]);

export function isBlockedPassword(password: string): boolean {
  return BLOCKED.has(password.toLowerCase());
}
