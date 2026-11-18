import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { Toaster } from "sonner";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import WhatsAppExtract from "./pages/WhatsAppExtract";
import LabelStudio from "./pages/LabelStudio";
import WhatsAppBot from "./pages/WhatsAppBot";
import Login from "./pages/Login";
import { Spinner } from "./components/ui/primitives";
import { getMe } from "./lib/api";
import { getToken, signalLogout, LOGOUT_EVENT } from "./lib/auth";

// "checking" -> verifying a saved token, "in" -> logged in, "out" -> show login
function useAuthState() {
  const [state, setState] = useState(() => (getToken() ? "checking" : "out"));
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (state !== "checking") return;
    getMe()
      .then(() => setState("in"))
      .catch((err) => {
        // 401 is handled by the axios interceptor (fires LOGOUT_EVENT).
        if (err?.response?.status === 503) setNotice(err.response.data?.detail || "Login is not set up on the server.");
        else if (!err?.response) setNotice("Can't reach the server right now.");
        setState("out");
      });
  }, [state]);

  useEffect(() => {
    const onLogout = () => {
      setState((prev) => {
        if (prev === "in") setNotice("Your session ended. Please log in again.");
        return "out";
      });
    };
    window.addEventListener(LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, []);

  const loggedIn = useCallback(() => {
    setNotice("");
    setState("in");
  }, []);

  const logout = useCallback(() => {
    setNotice("");
    signalLogout();
  }, []);

  return { state, notice, loggedIn, logout };
}

export default function App() {
  const { state, notice, loggedIn, logout } = useAuthState();

  return (
    <BrowserRouter>
      {state === "checking" ? (
        <div className="grid min-h-screen place-items-center bg-cream text-forest">
          <Spinner className="h-6 w-6" />
        </div>
      ) : state === "out" ? (
        <Login onLoggedIn={loggedIn} notice={notice} />
      ) : (
        <Routes>
          <Route element={<Layout onLogout={logout} />}>
            <Route index element={<Dashboard />} />
            <Route path="orders" element={<Orders />} />
            <Route path="extract" element={<WhatsAppExtract />} />
            <Route path="labels" element={<LabelStudio />} />
            <Route path="bot" element={<WhatsAppBot />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
      <Toaster
        position="top-right"
        toastOptions={{
          style: { fontFamily: "'IBM Plex Sans', sans-serif", borderRadius: 12, border: "1px solid #E3DED3" },
        }}
      />
    </BrowserRouter>
  );
}
