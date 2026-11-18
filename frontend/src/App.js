import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { Toaster } from "sonner";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import WhatsAppExtract from "./pages/WhatsAppExtract";
import LabelStudio from "./pages/LabelStudio";
import WhatsAppBot from "./pages/WhatsAppBot";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="orders" element={<Orders />} />
          <Route path="extract" element={<WhatsAppExtract />} />
          <Route path="labels" element={<LabelStudio />} />
          <Route path="bot" element={<WhatsAppBot />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster
        position="top-right"
        toastOptions={{
          style: { fontFamily: "'IBM Plex Sans', sans-serif", borderRadius: 12, border: "1px solid #E3DED3" },
        }}
      />
    </BrowserRouter>
  );
}
