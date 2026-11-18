import axios from "axios";

const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");

export const api = axios.create({ baseURL: `${BASE}/api` });

export const apiUrl = (path) => `${BASE}/api${path}`;

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

// Orders
export const getOrders = (q) => api.get("/orders", { params: q ? { q } : {} }).then((r) => r.data);
export const createOrder = (data) => api.post("/orders", data).then((r) => r.data);
export const updateOrder = (id, data) => api.patch(`/orders/${id}`, data).then((r) => r.data);
export const deleteOrder = (id) => api.delete(`/orders/${id}`).then((r) => r.data);
export const deleteAllOrders = () => api.delete("/orders").then((r) => r.data);
export const bulkOrders = (orders) => api.post("/orders/bulk", { orders }).then((r) => r.data);
export const getStats = () => api.get("/stats").then((r) => r.data);

// AI
export const extractText = (text) => api.post("/extract", { text }).then((r) => r.data);
export const extractFile = (file) => {
  const fd = new FormData();
  fd.append("file", file);
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
export const waConversations = () => api.get("/wa/conversations").then((r) => r.data);
export const waTestSend = (data) => api.post("/wa/test-send", data).then((r) => r.data);
