import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { FileXls, SlidersHorizontal } from "@phosphor-icons/react";
import CustomExportDialog from "../components/CustomExportDialog";
import { api, errorMessage, downloadBlob, filenameFromDisposition } from "../lib/api";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/primitives";
import { useSession } from "../lib/session";
import { PageHeader } from "../components/common";

const fields = { order_id: "Order ID", product_name: "Engraving name", charm: "Charm", colour: "Colour", quantity: "Quantity", notes: "Notes" };
const SHORT = { Quantity: "Qty", "Engraving name": "Name" };
const CELL = {  // compact columns so the table fits without scrolling sideways
  order_id: "whitespace-nowrap px-2.5 py-2 font-mono text-xs",
  product_name: "max-w-[180px] px-2.5 py-2",
  charm: "max-w-[130px] px-2.5 py-2",
  colour: "max-w-[90px] px-2.5 py-2",
  quantity: "px-2.5 py-2 tabular-nums",
  notes: "max-w-[240px] px-2.5 py-2 text-xs",
};
const initial ={ phone: "", order_id: "", missing: "", having: [], since: "", until: "" };

export default function CustomerData() {
  const [filters, setFilters] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  function change(key, value) {
    setOffset(0);
    setFilters(old => ({ ...old, [key]: value }));
  }
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError("");
    let active = false;
    const load = async () => {
      if (active) return;
      active = true;
      const params = { offset, ...filters, having: filters.having.join(",") };
      for (const key of ["since", "until"]) {
        if (params[key]) params[key] = new Date(new Date(params[key]).getTime() + (key === "until" ? 59999 : 0)).toISOString();
        else delete params[key];
      }
      try {
        const response = await api.get("/customer-data", { params, signal: controller.signal });
        if (!controller.signal.aborted) { setResult(response.data); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      } finally {
        active = false;
      }
    };
    const timer = setTimeout(load, 200);
    const refresh = setInterval(load, 30000);
    return () => { clearTimeout(timer); clearInterval(refresh); controller.abort(); };
  }, [filters, offset]);
  const inputClass = "block mt-1 w-full rounded-lg border border-line bg-white p-2";
  const { me } = useSession();
  const canExport = me?.role !== "employee" || me.permissions?.includes("exports");
  const [exporting, setExporting] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const exportExcel = async (chosen = filters) => {
    setExporting(true);
    try {
      const params = { ...chosen, having: (chosen.having || []).join(","), tz: -new Date().getTimezoneOffset() };
      for (const key of ["since", "until"]) {
        if (params[key]) params[key] = new Date(new Date(params[key]).getTime() + (key === "until" ? 59999 : 0)).toISOString();
        else delete params[key];
      }
      const res = await api.get("/customer-data/export.xlsx", { params, responseType: "blob" });
      downloadBlob(res.data, filenameFromDisposition(res.headers["content-disposition"], "customer-data.xlsx"));
      toast.success(`Excel file ready: ${Number(res.headers["x-rows"] || 0).toLocaleString()} records`);
      setCustomOpen(false);
    } catch (e) {
      let msg = errorMessage(e);
      if (e?.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).detail || msg; } catch { /* keep default */ }
      }
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  };
  return <main>
    <PageHeader
      title="Customer Data"
      subtitle="Review order details and follow up with customers in Chats."
      actions={canExport && (
        <>
          <Button variant="outline" onClick={() => setCustomOpen(true)} disabled={exporting} data-testid="customer-data-custom-export-btn"
            title="Choose the columns, dates, numbers, status, product type and missing details for the Excel file">
            <SlidersHorizontal size={18} /> Custom export
          </Button>
          <Button variant="outline" onClick={() => exportExcel()} disabled={exporting} data-testid="customer-data-export-btn"
            title="Download every record matching the filters below as an Excel file">
            {exporting && !customOpen ? <Spinner /> : <FileXls size={18} />} Export to Excel
          </Button>
        </>
      )}
    />
    <CustomExportDialog open={customOpen} onClose={() => setCustomOpen(false)} pageFilters={filters} onExport={exportExcel} busy={exporting} />
    <div className="mb-5 grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
      {[["phone","Phone","tel"],["order_id","Order ID","text"],["since","From (local time)","datetime-local"],["until","Through (local time)","datetime-local"]].map(([key,label,type]) =>
        <label key={key}>{label}<input className={inputClass} type={type} value={filters[key]} onChange={e => change(key,e.target.value)} /></label>)}
      <label>Missing detail<select className={inputClass} value={filters.missing} onChange={e => change("missing",e.target.value)}>
        <option value="">All records</option><option value="any">Any required detail</option>
        {Object.entries(fields).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <fieldset className="sm:col-span-2 lg:col-span-5">
        <legend className="mb-2 font-medium">Having details (all selected)</legend>
        <div className="flex flex-wrap gap-4">{Object.entries(fields).map(([key, label]) =>
          <label key={key} className="flex items-center gap-2"><input type="checkbox"
            checked={filters.having.includes(key)}
            onChange={e => change("having", e.target.checked ? [...filters.having, key] : filters.having.filter(k => k !== key))} />
            {label}</label>)}</div>
      </fieldset>
    </div>
    {error ? <p role="alert">{error}</p> : !result ? <p>Loading customer data…</p> : <>
      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        <table className="w-full table-auto text-left text-[13px]"><thead className="bg-cream/60"><tr>
          {["Customer","Date",...Object.values(fields).map(h => SHORT[h] || h),"Missing","Follow-up"].map(h =>
            <th className="px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted" key={h}>{h}</th>)}
        </tr></thead><tbody>{result.rows.map(r => <tr className="border-t border-line align-top" key={JSON.stringify([r.label,r.phone,r.key])}>
          <td className="max-w-[170px] px-2.5 py-2">
            <div className="truncate font-medium" title={r.name}>{r.name || "—"}</div>
            <div className="font-mono text-xs text-muted">{r.phone}</div>
            <div className="truncate text-[11px] text-muted" title={r.label}>{r.label}</div>
          </td>
          <td className="whitespace-nowrap px-2.5 py-2 text-xs">
            {new Date(r.at).toLocaleDateString()}<div className="text-muted">{new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
          </td>
          {Object.keys(fields).map(k => <td key={k} className={CELL[k] || "px-2.5 py-2"} title={r.details[k] || ""}>
            <span className={k === "notes" || k === "product_name" ? "line-clamp-3" : ""}>{r.details[k] || "—"}</span>
          </td>)}
          <td className="max-w-[130px] px-2.5 py-2 text-xs">
            {r.missing_fields.length ? <span className="text-terracotta-700">{r.missing_fields.map(k => fields[k]).join(", ")}</span> : <span className="text-forest">Complete</span>}
          </td>
          <td className="whitespace-nowrap px-2.5 py-2">{r.has_chat ? <Link className="text-forest underline" to={"/chats?" + new URLSearchParams({phone:r.phone,number:r.label})}>Open chat</Link> : <span className="text-xs text-muted">No chat</span>}</td>
        </tr>)}</tbody></table>
        {!result.rows.length && <p className="p-4">No matching customers.</p>}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button disabled={!offset} onClick={() => setOffset(offset-50)}>Previous</button>
        <span>Page {offset / 50 + 1}{result.total != null && ` of ${Math.max(1, Math.ceil(result.total / 50))}`}{result.total != null && ` · ${result.total.toLocaleString()} records`}</span>
        <button disabled={!result.more} onClick={() => setOffset(offset+50)}>Next</button>
      </div>
    </>}
  </main>;
}
