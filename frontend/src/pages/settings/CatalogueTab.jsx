import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { UploadSimple, Camera } from "@phosphor-icons/react";
import { Link } from "react-router";
import { cn } from "../../lib/utils";
import { getCatalogue, importCatalogue, testScreenshots, errorMessage } from "../../lib/api";
import SettingsCard from "./SettingsCard";
import { Label, Spinner, Switch } from "../../components/ui/primitives";
import { SimpleSelect } from "../../components/ui/overlays";
import { Button } from "../../components/ui/button";

const SHOPS = ["Meestuffs", "CELED HUB"];
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");

/** The products the bot knows, from the Meesho/Flipkart export files: names and types only (no prices or stock). */
export default function CatalogueTab() {
  const [data, setData] = useState(null);
  const [shop, setShop] = useState(SHOPS[0]);
  const [busy, setBusy] = useState(false);
  const file = useRef(null);

  const load = () => getCatalogue().then(setData).catch((e) => toast.error(errorMessage(e)));
  useEffect(() => {
    load();
  }, []);

  const upload = async (f) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await importCatalogue(shop, f);
      toast.success(`${r.shop} ${r.marketplace === "meesho" ? "Meesho" : "Flipkart"}: ${r.products} products (${r.active} active)`);
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsCard
        testId="catalogue-card"
        title="Catalogue"
        description="Upload the Meesho inventory file (.xlsx) or the Flipkart listing file (.xls) as downloaded. The bot uses it to know what each product needs: a name, a charm number, a name for each item in a combo, or nothing. Only product names, IDs and type are kept. Prices, stock, tax and shipping are dropped, and the AI never sees them."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48 space-y-1.5">
            <Label>Shop</Label>
            <SimpleSelect value={shop} onValueChange={setShop} options={SHOPS.map((s) => ({ value: s, label: s }))} testId="catalogue-shop" />
          </div>
          <input
            ref={file}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
            data-testid="catalogue-file"
          />
          <Button onClick={() => file.current?.click()} disabled={busy} data-testid="catalogue-upload">
            {busy ? <Spinner /> : <UploadSimple size={16} />} Upload file
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">Uploading again updates the list; products already there keep their place.</p>

        {data && data.files.length > 0 && (
          <table className="mt-5 w-full text-sm" data-testid="catalogue-files">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1.5">Shop</th>
                <th>Marketplace</th>
                <th>Products</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.shop + f.marketplace} className="border-t border-line">
                  <td className="py-2">{f.shop}</td>
                  <td>{f.marketplace === "meesho" ? "Meesho" : "Flipkart"}</td>
                  <td>
                    {f.active}
                    {f.products !== f.active ? ` (+${f.products - f.active} inactive)` : ""}
                  </td>
                  <td className="text-muted">{fmtDate(f.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.files.length === 0 && <p className="mt-4 text-sm text-muted">No catalogue uploaded yet. Until then the bot asks for a name and charm on every order.</p>}
      </SettingsCard>

      <ScreenshotTest />

      {data && data.types.length > 0 && (
        <SettingsCard testId="catalogue-types" title="What the bot asks for" description="Worked out from each product's title. Colour is never asked; it's saved only when the customer asks to change it (wallets, purses, clutches, passport covers).">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1.5">Product type</th>
                <th>Products</th>
                <th>Bot asks for</th>
              </tr>
            </thead>
            <tbody>
              {data.types.map((t) => (
                <tr key={t.items} className="border-t border-line">
                  <td className="py-2">{t.items}</td>
                  <td>{t.count}</td>
                  <td className="text-muted">{t.asks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsCard>
      )}
    </div>
  );
}

const same = (a, b) => (a || "").replace(/[^0-9A-Z]/gi, "").toUpperCase() === (b || "").replace(/[^0-9A-Z]/gi, "").toUpperCase();

/** Runs the free OCR on recent customer photos (optionally compared with Haiku). Saves nothing and replies to nobody. */
function ScreenshotTest() {
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await testScreenshots(12, compare));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const found = res ? res.results.filter((r) => r.ocr?.order_id).length : 0;
  const agree = res ? res.results.filter((r) => r.ocr?.order_id && r.haiku?.order_id && same(r.ocr.order_id, r.haiku.order_id)).length : 0;
  return (
    <SettingsCard
      testId="screenshot-test-card"
      title="Screenshot reader"
      description="Tries the free OCR on the 12 latest photos customers sent (WhatsApp keeps photos about 30 days). No one gets a reply. With the Haiku check on (about ₹0.02 per photo), an order ID both readers agree on is saved to that customer's data; nothing is overwritten."
    >
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={run} disabled={busy} data-testid="screenshot-test-btn">
          {busy ? <Spinner /> : <Camera size={16} />} {busy ? "Reading photos… (up to a minute if the OCR is waking up)" : "Test on recent photos"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={compare} onCheckedChange={setCompare} data-testid="screenshot-compare" /> Also compare with Haiku
        </label>
      </div>
      {res && (
        <div className="mt-4">
          <p className="text-sm" data-testid="screenshot-test-summary">
            OCR service: <b>{res.ocr_status}</b> · {res.photos} photos · order ID found by OCR in <b>{found}</b>
            {compare && <> · same ID as Haiku in <b>{agree}</b> · saved to customer data: <b>{res.results.filter((r) => r.saved === "saved to customer data").length}</b></>}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5">Photo</th>
                  <th>Free OCR</th>
                  {compare && <th>Haiku</th>}
                </tr>
              </thead>
              <tbody>
                {res.results.map((r) => (
                  <tr key={r.message_id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <Link className="text-forest underline" to={"/chats?" + new URLSearchParams({ number: r.number, phone: r.phone })}>
                        +{r.phone}
                      </Link>
                      <div className="text-xs text-muted">{new Date(r.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                    </td>
                    <td className="pr-3">
                      {r.ocr?.order_id ? (
                        <>
                          <span className="font-mono">{r.ocr.order_id}</span>
                          {r.ocr.product && <div className="text-xs text-muted">{r.ocr.product}</div>}
                        </>
                      ) : (
                        <span className="text-muted">{r.ocr_note}</span>
                      )}
                      {r.seconds > 0 && <div className="text-[11px] text-muted">{r.seconds}s</div>}
                    </td>
                    {compare && (
                      <td>
                        {r.haiku?.order_id ? (
                          <>
                            <span className="font-mono">{r.haiku.order_id}</span>{" "}
                            {r.ocr?.order_id && (same(r.ocr.order_id, r.haiku.order_id) ? <span className="text-forest">✓ same</span> : <span className="text-danger">✗ different</span>)}
                            {r.haiku.product && <div className="text-xs text-muted">{r.haiku.product}</div>}
                            {r.saved && <div className={cn("text-xs font-medium", r.saved.startsWith("saved") ? "text-forest" : "text-muted")}>{r.saved}</div>}
                          </>
                        ) : (
                          <span className="text-muted">{r.haiku ? (r.haiku.order_page ? "order page, no ID" : "not an order screenshot") : "-"}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
