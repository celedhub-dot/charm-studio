import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash, UploadSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { getSavedContacts, addSavedContact, removeSavedContact, importSavedContacts, errorMessage } from "../../lib/api";
import SettingsCard from "./SettingsCard";
import { Input, Label, Spinner } from "../../components/ui/primitives";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/overlays";

const fmt = (p) => (p ? `+${p}` : "");

/** Saved contacts: the bot never replies to these numbers or reads their chats, on any WhatsApp number. */
export default function SavedContactsTab() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const file = useRef(null);

  const load = () => getSavedContacts().then(setList).catch((e) => toast.error(errorMessage(e)));
  useEffect(() => {
    load();
  }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, "");
    return (list || []).filter((c) => !s || c.name.toLowerCase().includes(s) || (digits && c.phone.includes(digits)));
  }, [list, q]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await addSavedContact(form.phone, form.name);
      toast.success(`${form.name || fmt(r.phone)} saved: the bot won't reply to this number`);
      setForm({ name: "", phone: "" });
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (f) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await importSavedContacts(f);
      toast.success(`${r.numbers_in_file} numbers in the file: ${r.added} added, ${r.already_saved} already saved`);
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c) => {
    try {
      await removeSavedContact(c.phone);
      toast.success(`${c.name || fmt(c.phone)} removed: the bot treats this number as a customer again`);
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <SettingsCard
      testId="saved-contacts-card"
      title="Saved contacts"
      description="Your team, family, suppliers and anyone who isn't a customer. The bot never replies to these numbers and never reads their chats, on every WhatsApp number. Their messages still show in Chats."
    >
      <div className="space-y-6">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-testid="saved-add-form">
          <div className="space-y-1.5">
            <Label htmlFor="saved-name">Name</Label>
            <Input id="saved-name" placeholder="e.g. Production team" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="saved-phone">Phone number</Label>
            <Input id="saved-phone" inputMode="tel" placeholder="e.g. 98765 43210" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
          </div>
          <Button type="submit" disabled={busy || !form.phone.trim()} data-testid="saved-add-btn">
            {busy ? <Spinner /> : <Plus size={16} />} Add
          </Button>
        </form>

        <div className="rounded-xl border border-dashed border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium text-ink">Import your phone contacts</div>
              <div className="text-xs text-muted">
                Export them as a <b>.vcf</b> file (Android Contacts app: Settings → Export) or a Google Contacts <b>.csv</b>, then choose it
                here. Only names and numbers are kept.
              </div>
            </div>
            <input
              ref={file}
              type="file"
              accept=".vcf,.csv,text/vcard,text/csv"
              className="hidden"
              onChange={(e) => {
                importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
              data-testid="saved-import-input"
            />
            <Button type="button" variant="outline" disabled={busy} onClick={() => file.current?.click()} data-testid="saved-import-btn">
              <UploadSimple size={16} /> Import file
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-ink">{list ? `${list.length} saved contact${list.length === 1 ? "" : "s"}` : "Loading…"}</div>
            {list && list.length > 8 && (
              <div className="relative w-56">
                <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <Input className="h-8 pl-8 text-sm" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            )}
          </div>
          {list === null ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted">{list.length ? "No matches." : "No saved contacts yet."}</p>
          ) : (
            <div className="divide-y divide-line rounded-xl border border-line" data-testid="saved-list">
              {shown.slice(0, 300).map((c) => (
                <div key={c.phone} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{c.name || "(no name)"}</div>
                    <div className="font-mono text-xs text-muted">{fmt(c.phone)}</div>
                  </div>
                  <ConfirmDialog
                    testId={`saved-remove-${c.phone}`}
                    title="Remove from saved contacts?"
                    description={`The bot will treat ${c.name || fmt(c.phone)} as a customer again: it may reply and read their chats.`}
                    confirmLabel="Remove"
                    onConfirm={() => remove(c)}
                    trigger={
                      <button type="button" className="rounded-md p-1.5 text-muted hover:bg-red-50 hover:text-danger" aria-label={`Remove ${c.name || c.phone}`}>
                        <Trash size={16} />
                      </button>
                    }
                  />
                </div>
              ))}
              {shown.length > 300 && <div className="px-3 py-2 text-xs text-muted">Showing 300 of {shown.length}. Search to find others.</div>}
            </div>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}
