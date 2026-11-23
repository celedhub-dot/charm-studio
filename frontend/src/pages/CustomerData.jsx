import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../lib/api";
import { PageHeader } from "../components/common";

const fields = { order_id: "Order ID", product_name: "Engraving name", charm: "Charm", colour: "Colour", quantity: "Quantity", notes: "Notes" };
const initial = { phone: "", order_id: "", missing: "", having: [], since: "", until: "" };

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
  return <main>
    <PageHeader title="Customer Data" subtitle="Review order details and follow up with customers in Chats." />
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
        <table className="w-full text-left text-sm"><thead><tr>
          {["Customer","Date and time",...Object.values(fields),"Missing required details","Follow-up"].map(h => <th className="p-3" key={h}>{h}</th>)}
        </tr></thead><tbody>{result.rows.map(r => <tr className="border-t border-line" key={JSON.stringify([r.label,r.phone,r.key])}>
          <td className="p-3">{r.name}<div>{r.phone}</div><small>{r.label}</small></td>
          <td className="p-3">{new Date(r.at).toLocaleString()}</td>
          {Object.keys(fields).map(k => <td key={k} className="p-3">{r.details[k] || "—"}</td>)}
          <td className="p-3">{r.missing_fields.map(k => fields[k]).join(", ") || "Complete"}</td>
          <td className="p-3">{r.has_chat ? <Link className="text-forest underline" to={"/chats?" + new URLSearchParams({phone:r.phone,number:r.label})}>Message customer</Link> : "No linked chat"}</td>
        </tr>)}</tbody></table>
        {!result.rows.length && <p className="p-4">No matching customers.</p>}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button disabled={!offset} onClick={() => setOffset(offset-50)}>Previous</button>
        <span>Page {offset / 50 + 1}</span>
        <button disabled={!result.more} onClick={() => setOffset(offset+50)}>Next</button>
      </div>
    </>}
  </main>;
}
