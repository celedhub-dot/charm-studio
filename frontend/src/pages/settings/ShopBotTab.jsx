import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FloppyDisk, ArrowCounterClockwise, ChatCircleText } from "@phosphor-icons/react";
import { saveSettings, errorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Input, Label, Textarea, Spinner } from "../../components/ui/primitives";
import { Button } from "../../components/ui/button";
import SettingsCard from "./SettingsCard";

const BOT_FIELDS = [
  { key: "ask_order_id", label: "1. Greeting and Order ID question", help: "Sent when a customer first messages you, or types hi / start / restart." },
  { key: "ask_product_name", label: "2. Name to print", help: "" },
  { key: "ask_charm", label: "3. Charm choice", help: "" },
  { key: "ask_notes", label: "4. Notes", help: "Customers can reply none, no, skip or - to leave notes empty." },
  { key: "thank_you", label: "5. Thank-you message", help: "Sent once all four answers are in.", rows: 6 },
];
const PLACEHOLDERS = ["{shop_name}", "{order_id}", "{name}", "{charm}", "{notes}"];

function fill(text, values) {
  return Object.entries(values).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), text || "");
}

function ShopCard() {
  const { settings, setSettings } = useSession();
  const [shopName, setShopName] = useState(settings?.shop?.shop_name || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setShopName(settings?.shop?.shop_name || ""), [settings?.shop?.shop_name]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      setSettings(await saveSettings("shop", { shop_name: shopName }));
      toast.success("Shop name saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        title="Shop profile"
        description="Shown under the logo in the sidebar. Use {shop_name} in bot messages to include it."
        testId="shop-card"
        footer={
          <Button type="submit" disabled={saving || shopName.trim() === (settings?.shop?.shop_name || "")} data-testid="shop-save-btn">
            {saving ? <Spinner /> : <FloppyDisk size={16} />} Save
          </Button>
        }
      >
        <div className="max-w-md space-y-1.5">
          <Label htmlFor="shop-name">Shop name</Label>
          <Input id="shop-name" data-testid="shop-name-input" placeholder="e.g. Priya Charms" maxLength={60} value={shopName} onChange={(e) => setShopName(e.target.value)} />
        </div>
      </SettingsCard>
    </form>
  );
}

function BotCard() {
  const { settings, setSettings } = useSession();
  const defaults = settings?.defaults?.bot || {};
  const [form, setForm] = useState(settings?.bot || {});
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings?.bot || {}), [settings?.bot]);

  const dirty = BOT_FIELDS.some(({ key }) => (form[key] || "") !== (settings?.bot?.[key] || ""));
  const preview = useMemo(
    () =>
      fill(form.thank_you, {
        shop_name: settings?.shop?.shop_name || "Your shop",
        order_id: "123456789012_1",
        name: "Aarav",
        charm: "Heart",
        notes: "Gift wrap",
      }),
    [form.thank_you, settings?.shop?.shop_name]
  );

  const save = async (e) => {
    e.preventDefault();
    const empty = BOT_FIELDS.find(({ key }) => !(form[key] || "").trim());
    if (empty) return toast.error(`"${empty.label}" can't be empty`);
    setSaving(true);
    try {
      setSettings(await saveSettings("bot", Object.fromEntries(BOT_FIELDS.map(({ key }) => [key, form[key]]))));
      toast.success("Bot messages saved. The bot uses them from the next message.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        title="Bot messages"
        description="What the WhatsApp bot says, in order. Write in English, Hindi, Hinglish or anything else; every customer gets the same text."
        testId="bot-card"
        footer={
          <Button type="submit" disabled={saving || !dirty} data-testid="bot-save-btn">
            {saving ? <Spinner /> : <FloppyDisk size={16} />} Save messages
          </Button>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4">
            {BOT_FIELDS.map(({ key, label, help, rows }) => (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`bot-${key}`}>{label}</Label>
                  {defaults[key] && form[key] !== defaults[key] && (
                    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-forest hover:underline" onClick={() => setForm({ ...form, [key]: defaults[key] })} data-testid={`bot-reset-${key}`}>
                      <ArrowCounterClockwise size={12} /> Default
                    </button>
                  )}
                </div>
                <Textarea
                  id={`bot-${key}`}
                  data-testid={`bot-${key}-input`}
                  rows={rows || 2}
                  className="min-h-0"
                  maxLength={key === "thank_you" ? 1500 : 1000}
                  value={form[key] || ""}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
                {help && <p className="text-xs text-muted">{help}</p>}
              </div>
            ))}
            <p className="text-xs text-muted">
              Placeholders for the thank-you message:{" "}
              {PLACEHOLDERS.map((p) => (
                <code key={p} className="mr-1 rounded bg-sand px-1 py-0.5 font-mono text-[11px] text-ink">
                  {p}
                </code>
              ))}
            </p>
          </div>
          <div>
            <div className="sticky top-6 rounded-2xl bg-[#E7DFD3] p-3" data-testid="bot-preview">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
                <ChatCircleText size={14} /> Thank-you preview
              </div>
              <div className="whitespace-pre-wrap rounded-xl rounded-tl-sm bg-white px-3 py-2 text-sm text-ink shadow-card">{preview}</div>
            </div>
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}

export default function ShopBotTab() {
  return (
    <div className="grid gap-6">
      <ShopCard />
      <BotCard />
    </div>
  );
}
