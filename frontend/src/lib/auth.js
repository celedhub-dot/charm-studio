// Stores the login token. localStorage can throw (private mode, blocked storage),
// so every access is guarded; in that case the token just lives for this tab.
const KEY = "charm_studio_token";
let memoryToken = null;

export function getToken() {
  try {
    return localStorage.getItem(KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token) {
  memoryToken = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* memory only */
  }
}

export function clearToken() {
  memoryToken = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const LOGOUT_EVENT = "charm-studio:logout";

export function signalLogout() {
  clearToken();
  window.dispatchEvent(new Event(LOGOUT_EVENT));
}
