import axios from "axios";
import { getToken, setToken, signalLogout } from "./auth";

const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");

export const api = axios.create({ baseURL: `${BASE}/api` });

// Attach the login token to every request.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// An expired or invalid token sends the user back to the login screen.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url = err?.config?.url || "";
    const isPublicAuth = ["/auth/login", "/auth/forgot", "/auth/reset", "/auth/config"].some((p) => url.includes(p));
    if (err?.response?.status === 401 && !isPublicAuth) signalLogout();
    return Promise.reject(err);
  }
);

export function errorMessage(err, fallback = "Something went wrong") {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join(", ");
  return err?.message || fallback;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filenameFromDisposition(header, fallback) {
  const m = /filename="?([^"]+)"?/i.exec(header || "");
  return m ? m[1] : fallback;
}

// Auth (every call that returns a new token stores it)
const keepToken = (r) => {
  if (r.data?.token) setToken(r.data.token);
  return r.data;
};
export const getAuthConfig = () => api.get("/auth/config").then((r) => r.data);
export const login = (email, password) => api.post("/auth/login", { email, password }).then(keepToken);
export const getMe = () => api.get("/auth/me").then((r) => r.data);
export const forgotPassword = (email) => api.post("/auth/forgot", { email }).then((r) => r.data);
export const resetPassword = (token, password) => api.post("/auth/reset", { token, password }).then((r) => r.data);

// Account
export const setupAccount = (data) => api.post("/account/setup", data).then(keepToken);
export const changePassword = (currentPassword, newPassword) =>
  api.post("/account/password", { current_password: currentPassword, new_password: newPassword }).then(keepToken);
export const getAccount = () => api.get("/account").then((r) => r.data);
export const updateProfile = (data) => api.put("/account/profile", data).then((r) => r.data);
export const updateSessionLength = (days) => api.put("/account/session", { session_days: days }).then((r) => r.data);
export const logoutOtherDevices = () => api.post("/account/logout-others").then(keepToken);
export const getLoginHistory = () => api.get("/account/logins").then((r) => r.data);

// Settings
export const getSettings = () => api.get("/settings").then((r) => r.data);
export const saveSettings = (section, data) => api.put(`/settings/${section}`, data).then((r) => r.data);
export const getSystemStatus = () => api.get("/system/status").then((r) => r.data);

// Orders
// filters: a search string, or { q, phone, order_id, start, end } (start/end are Date objects); empty values are skipped
const orderParams = (f = {}) => {
  const p = typeof f === "string" ? { q: f } : { ...f };
  if (p.start instanceof Date) p.start = p.start.toISOString();
  if (p.end instanceof Date) p.end = p.end.toISOString();
  if ((p.start || p.end) && p.tz === undefined) p.tz = -new Date().getTimezoneOffset(); // so order dates line up with this day
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ""));
};
export const exportOrdersCsv = async (filters) => {
  const res = await api.get("/orders/export.csv", { params: orderParams(filters), responseType: "blob" });
  downloadBlob(res.data, filenameFromDisposition(res.headers["content-disposition"], "charm_orders.csv"));
};
export const getOrders = (filters) => api.get("/orders", { params: orderParams(filters) }).then((r) => r.data);
export const createOrder = (data) => api.post("/orders", data).then((r) => r.data);
export const updateOrder = (id, data) => api.patch(`/orders/${id}`, data).then((r) => r.data);
export const deleteOrder = (id) => api.delete(`/orders/${id}`).then((r) => r.data);
export const deleteAllOrders = () => api.delete("/orders").then((r) => r.data);
export const bulkOrders = (orders) => api.post("/orders/bulk", { orders }).then((r) => r.data);
export const getStats = () => api.get("/stats").then((r) => r.data);

// AI
export const getExtractOptions = () => api.get("/extract/options").then((r) => r.data);
// ai = { model, effort }; empty strings mean "use the server's default"
export const extractText = (text, ai = {}) =>
  api.post("/extract", { text, model: ai.model || null, effort: ai.effort || null }).then((r) => r.data);
export const extractFile = (file, ai = {}) => {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("model", ai.model || "");
  fd.append("effort", ai.effort || "");
  return api.post("/extract/bulk-file", fd, { timeout: 15 * 60 * 1000 }).then((r) => r.data);
};

// PDF
export const analyzePdf = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return api.post("/pdf/analyze", fd).then((r) => r.data);
};
export const annotatePdf = (file, { position, skipUnmatched, fontSize, overrides }) => {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("position", position);
  fd.append("skip_unmatched", skipUnmatched ? "true" : "false");
  fd.append("font_size", String(fontSize));
  fd.append("overrides", JSON.stringify(overrides || {}));
  return api.post("/pdf/annotate", fd, { responseType: "blob" });
};

// WhatsApp
export const waStatus = () => api.get("/wa/status").then((r) => r.data);
export const waNumbers = () => api.get("/wa/numbers").then((r) => r.data);
export const addWaNumber = (data) => api.post("/wa/numbers", data).then((r) => r.data);
export const updateWaNumber = (id, data) => api.patch(`/wa/numbers/${id}`, data).then((r) => r.data);
export const deleteWaNumber = (id) => api.delete(`/wa/numbers/${id}`).then((r) => r.data);
export const checkWaNumber = (id) => api.post(`/wa/numbers/${id}/check`).then((r) => r.data);
export const waConversations = () => api.get("/wa/conversations").then((r) => r.data);

// Chats (team inbox)
const threadPath = (label, phone) => `/inbox/conversations/${encodeURIComponent(label)}/${encodeURIComponent(phone)}`;
export const getConversations = (q, number) =>
  api.get("/inbox/conversations", { params: { q: q || undefined, number: number || undefined } }).then((r) => r.data);
export const getThread = (label, phone) => api.get(threadPath(label, phone)).then((r) => r.data);
export const deleteChat = (label, phone) => api.delete(threadPath(label, phone)).then((r) => r.data);
export const readOrdersAgain = (label, phone) => api.post(`${threadPath(label, phone)}/read-orders`).then((r) => r.data);
export const sendInboxMessage = (numberLabel, to, text) =>
  api.post("/inbox/send", { number_label: numberLabel, to, text }).then((r) => r.data);
export const getUnread = () => api.get("/inbox/unread").then((r) => r.data);
export const getTemplates = (number, refresh = false) =>
  api.get("/inbox/templates", { params: { number, refresh: refresh || undefined } }).then((r) => r.data);
export const sendTemplate = (data) => api.post("/inbox/send-template", data).then((r) => r.data);
export const getMediaBlob = (messageId) =>
  api.get(`/inbox/media/${encodeURIComponent(messageId)}`, { responseType: "blob" }).then((r) => r.data);
export const sendInboxMedia = (numberLabel, to, file, caption) => {
  const form = new FormData();
  form.append("number_label", numberLabel);
  form.append("to", to);
  form.append("caption", caption || "");
  form.append("file", file);
  return api.post("/inbox/send-media", form).then((r) => r.data);
};

// Order sheet PDF for a period (start/end are Date objects in the user's local time)
// start/end: Date objects or null (no date filter); extra: { phone, order_id }
export const downloadOrderSheet = async (start, end, title, extra = {}) => {
  const res = await api.get("/orders/sheet.pdf", {
    params: orderParams({ start, end, phone: extra.phone, order_id: extra.order_id, tz: -new Date().getTimezoneOffset(), title }),
    responseType: "blob",
  });
  downloadBlob(res.data, filenameFromDisposition(res.headers["content-disposition"], "order_sheet.pdf"));
};
export const waTestSend = (data) => api.post("/wa/test-send", data).then((r) => r.data);
