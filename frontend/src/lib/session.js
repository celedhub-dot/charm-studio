import { createContext, useContext } from "react";

// Logged-in account (from /auth/me) and app settings (from /settings), shared app-wide.
export const SessionContext = createContext({
  me: null,
  settings: null,
  refreshMe: async () => {},
  setSettings: () => {},
  logout: () => {},
});

export const useSession = () => useContext(SessionContext);

// Mirrors the server's rules so people get instant feedback; the server has the final say.
const COMMON = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "password", "password1",
  "password123", "qwerty123", "qwertyuiop", "iloveyou", "admin123", "letmein1", "welcome1", "abc12345",
  "charmstudio", "charm.studio", "asdfghjk", "1q2w3e4r", "zaq12wsx", "india123", "11223344",
]);

export function passwordProblem(password, email = "") {
  if (!password) return "";
  if (password.length < 8) return "Use at least 8 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  if (COMMON.has(password.toLowerCase()) || new Set(password).size < 3) return "Too easy to guess. Try a few random words with a number.";
  if (email && password.toLowerCase() === email.trim().toLowerCase()) return "Don't use your email address as your password.";
  return "";
}
