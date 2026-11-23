import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router";
import { Toaster } from "sonner";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import CustomerData from "./pages/CustomerData";
import Orders from "./pages/Orders";
import WhatsAppExtract from "./pages/WhatsAppExtract";
import LabelStudio from "./pages/LabelStudio";
import WhatsAppBot from "./pages/WhatsAppBot";
import Settings from "./pages/Settings";
import Chats from "./pages/Chats";
import Login from "./pages/Login";
import AccountSetup from "./pages/AccountSetup";
import ResetPassword from "./pages/ResetPassword";
import { Spinner } from "./components/ui/primitives";
import { getMe, getSettings } from "./lib/api";
import { getToken, signalLogout, LOGOUT_EVENT } from "./lib/auth";
import { SessionContext } from "./lib/session";

// state: "checking" (verifying a saved token) | "out" | "setup" | "password" | "in"
function useAuth() {
  const [state, setState] = useState(() => (getToken() ? "checking" : "out"));
  const [me, setMe] = useState(null);
  const [notice, setNotice] = useState("");

  const loadMe = useCallback(async () => {
    try {
      const data = await getMe();
      setMe(data);
      setState(data.scope === "full" ? "in" : data.scope);
    } catch (err) {
      // 401 is handled by the axios interceptor (fires LOGOUT_EVENT).
      if (err?.response?.status === 503) setNotice(err.response.data?.detail || "Login is not set up on the server.");
      else if (!err?.response) setNotice("Can't reach the server right now.");
      setState("out");
    }
  }, []);

  useEffect(() => {
    if (state === "checking") loadMe();
  }, [state, loadMe]);

  const manualLogout = useRef(false); // "Log out" clicked: no "session ended" notice

  useEffect(() => {
    const onLogout = () => {
      const manual = manualLogout.current;
      manualLogout.current = false;
      setState((prev) => {
        if (prev === "in" && !manual) setNotice("Your session ended. Please log in again.");
        return "out";
      });
      setMe(null);
    };
    window.addEventListener(LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, []);

  const loggedIn = useCallback(() => {
    setNotice("");
    setState("checking");
  }, []);

  const logout = useCallback(() => {
    setNotice("");
    manualLogout.current = true;
    signalLogout();
  }, []);

  return { state, me, notice, loadMe, loggedIn, logout };
}

function AppRoutes() {
  const location = useLocation();
  const { state, me, notice, loadMe, loggedIn, logout } = useAuth();
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    if (state === "in") getSettings().then(setSettings).catch(() => {});
    else setSettings(null);
  }, [state]);

  const session = useMemo(() => ({ me, settings, refreshMe: loadMe, setSettings, logout }), [me, settings, loadMe, logout]);

  // The reset link from the email works whether or not you're logged in.
  if (location.pathname === "/reset-password") return <ResetPassword />;

  if (state === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-cream text-forest">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (state === "out") return <Login onLoggedIn={loggedIn} notice={notice} />;
  if (state === "setup" || state === "password") return <AccountSetup mode={state} onDone={loggedIn} onLogout={logout} />;

  return (
    <SessionContext.Provider value={session}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="chats" element={<Chats />} />
          <Route path="customer-data" element={<CustomerData />} />
          <Route path="orders" element={<Orders />} />
          <Route path="extract" element={<WhatsAppExtract />} />
          <Route path="labels" element={<LabelStudio />} />
          <Route path="bot" element={<WhatsAppBot />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SessionContext.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <Toaster
        position="top-right"
        toastOptions={{
          style: { fontFamily: "'IBM Plex Sans', sans-serif", borderRadius: 12, border: "1px solid #E3DED3" },
        }}
      />
    </BrowserRouter>
  );
}
