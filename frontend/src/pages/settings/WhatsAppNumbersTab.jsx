import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  Plus,
  PencilSimple,
  Trash,
  Pause,
  Play,
  PlugsConnected,
  WhatsappLogo,
  WarningCircle,
  Info,
  FloppyDisk,
} from "@phosphor-icons/react";
import { waNumbers, addWaNumber, updateWaNumber, deleteWaNumber, checkWaNumber, errorMessage } from "../../lib/api";
import { Badge, Input, Label, Spinner, Alert } from "../../components/ui/primitives";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, ConfirmDialog } from "../../components/ui/overlays";
import { EmptyState } from "../../components/common";
import PasswordInput from "../../components/PasswordInput";
import { formatDate } from "../../lib/utils";

const EMPTY = { label: "", phone_id: "", token: "", display: "", verify_token: "" };

function NumberDialog({ open, number, onClose, onSaved }) {
  const editing = !!number;
  const [form, setForm] = useState(EMPTY);
  const [clearVerify, setClearVerify] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [metaFailed, setMetaFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(number ? { label: number.label, phone_id: number.phone_id, token: "", display: number.display, verify_token: "" } : EMPTY);
    setClearVerify(false);
    setError("");
    setMetaFailed(false);
  }, [open, number]);

  const set = (k) => (e) => {
    setForm({ ...form, [k]: typeof e === "string" ? e : e.target.value });
    setMetaFailed(false);
  };

  const save = async (skipCheck = false) => {
    if (!form.label.trim() || !form.phone_id.trim() || (!editing && !form.token.trim())) {
      return setError(editing ? "Name and Phone Number ID are required." : "Name, Phone Number ID and access token are required.");
    }
    setSaving(true);
    setError("");
    try {
      let saved;
      if (editing) {
        const patch = { label: form.label, phone_id: form.phone_id, display: form.display, skip_check: skipCheck };
        if (form.token.trim()) patch.token = form.token.trim();
        if (clearVerify) patch.verify_token = "";
        else if (form.verify_token.trim()) patch.verify_token = form.verify_token.trim();
        saved = await updateWaNumber(number.id, patch);
      } else {
        saved = await addWaNumber({ ...form, skip_check: skipCheck });
      }
      toast.success(editing ? "Number updated" : `${saved.label} added${saved.display ? ` (${saved.display})` : ""}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setMetaFailed(err?.response?.status === 424);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${number.label}` : "Add a WhatsApp number"}</DialogTitle>
          <DialogDescription>
            Find these in the Meta Developer Console under WhatsApp, then API Setup. The token is encrypted before it's saved and is never shown again.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}
          data-testid="wa-number-form"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wa-label">Name</Label>
              <Input id="wa-label" data-testid="wa-label-input" placeholder="e.g. Main shop" value={form.label} onChange={set("label")} maxLength={40} />
              <p className="text-xs text-muted">Shown on orders that came from this number.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-display">Display number (optional)</Label>
              <Input id="wa-display" data-testid="wa-display-input" placeholder="Filled in from Meta" value={form.display} onChange={set("display")} maxLength={40} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-phone-id">Phone Number ID</Label>
            <Input id="wa-phone-id" data-testid="wa-phone-id-input" inputMode="numeric" placeholder="e.g. 106540352242922" value={form.phone_id} onChange={set("phone_id")} className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-token">{editing ? "Access token (leave blank to keep the saved one)" : "Access token"}</Label>
            <PasswordInput
              id="wa-token"
              testId="wa-token-input"
              autoComplete="off"
              placeholder={editing ? `Saved token ${number.token_hint}` : "Starts with EAA..."}
              value={form.token}
              onChange={set("token")}
            />
            <p className="text-xs text-muted">Use a permanent token from a System User (Business Settings), not the 24-hour test token.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-verify">Webhook verify token (optional)</Label>
            <PasswordInput
              id="wa-verify"
              testId="wa-verify-input"
              autoComplete="off"
              placeholder={editing && number.has_verify_token && !clearVerify ? "Saved (leave blank to keep)" : "Only if this number uses its own verify token"}
              value={form.verify_token}
              onChange={set("verify_token")}
            />
            {editing && number.has_verify_token && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={clearVerify} onChange={(e) => setClearVerify(e.target.checked)} data-testid="wa-clear-verify" /> Remove the saved verify token
              </label>
            )}
          </div>

          {error && (
            <Alert variant="warning" data-testid="wa-form-error">
              <WarningCircle size={18} weight="fill" className="shrink-0" />
              <div>
                <div>{error}</div>
                {metaFailed && <div className="mt-1 text-xs opacity-80">Double-check the Phone Number ID and token. If you're sure they're right, you can save anyway and check the connection later.</div>}
              </div>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} data-testid="wa-cancel-btn">
              Cancel
            </Button>
            {metaFailed && (
              <Button type="button" variant="outline" disabled={saving} onClick={() => save(true)} data-testid="wa-save-anyway-btn">
                Save anyway
              </Button>
            )}
            <Button type="submit" disabled={saving} data-testid="wa-save-btn">
              {saving ? <Spinner /> : <FloppyDisk size={16} />} {editing ? "Save changes" : "Check & add number"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NumberCard({ n, onEdit, onChanged }) {
  const [busy, setBusy] = useState("");

  const run = async (kind, fn, okMsg) => {
    setBusy(kind);
    try {
      const res = await fn();
      if (okMsg) toast.success(typeof okMsg === "function" ? okMsg(res) : okMsg);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy("");
    }
  };

  const status = !n.token_ok
    ? { label: "Re-enter token", variant: "danger" }
    : n.active
    ? { label: "Active", variant: "default" }
    : { label: "Paused", variant: "neutral" };

  return (
    <div data-testid={`wa-number-card-${n.id}`} className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-card sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${n.active && n.token_ok ? "bg-forest-50 text-forest" : "bg-sand text-muted"}`}>
          <WhatsappLogo size={22} weight="fill" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading font-bold text-ink">{n.label}</span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="mt-0.5 text-sm text-ink">{n.display || <span className="text-muted">No display number yet</span>}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
            <span>
              ID <span className="font-mono">{n.phone_id}</span>
            </span>
            <span>Token {n.token_hint || "—"}</span>
            {n.has_verify_token && <span>Own verify token</span>}
            <span>Added {formatDate(n.created_at)}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy || !n.token_ok}
          onClick={() => run("check", () => checkWaNumber(n.id), (r) => `Connected: ${r.verified_name || r.display_phone_number || "OK"}`)}
          data-testid={`wa-check-${n.id}`}
        >
          {busy === "check" ? <Spinner /> : <PlugsConnected size={14} />} Check
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onEdit(n)} data-testid={`wa-edit-${n.id}`}>
          <PencilSimple size={14} /> Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => run("pause", () => updateWaNumber(n.id, { active: !n.active }), n.active ? `${n.label} paused` : `${n.label} resumed`)}
          data-testid={`wa-toggle-${n.id}`}
        >
          {busy === "pause" ? <Spinner /> : n.active ? <Pause size={14} /> : <Play size={14} />} {n.active ? "Pause" : "Resume"}
        </Button>
        <ConfirmDialog
          testId={`wa-delete-${n.id}`}
          title={`Delete ${n.label}?`}
          description="The bot stops answering this number, any half-finished chats on it are discarded, and the saved token is deleted. Orders already saved keep showing this name. To stop it only for now, use Pause instead."
          confirmLabel="Delete number"
          onConfirm={() => run("delete", () => deleteWaNumber(n.id), `${n.label} deleted`)}
          trigger={
            <Button size="sm" variant="outline" disabled={!!busy} className="text-danger hover:border-danger/40 hover:bg-danger/5" data-testid={`wa-delete-${n.id}-btn`}>
              <Trash size={14} /> Delete
            </Button>
          }
        />
      </div>
    </div>
  );
}

export default function WhatsAppNumbersTab() {
  const [numbers, setNumbers] = useState(null);
  const [dialog, setDialog] = useState({ open: false, number: null });

  const load = useCallback(() => {
    waNumbers()
      .then(setNumbers)
      .catch((e) => {
        toast.error(errorMessage(e, "Could not load numbers"));
        setNumbers([]);
      });
  }, []);
  useEffect(load, [load]);

  const unreadable = (numbers || []).filter((n) => !n.token_ok).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted">
          The bot answers customers on every <b>active</b> number here. Webhook setup in Meta is explained on the{" "}
          <Link to="/bot" className="font-medium text-forest hover:underline">
            WhatsApp Bot
          </Link>{" "}
          page.
        </p>
        <Button onClick={() => setDialog({ open: true, number: null })} data-testid="wa-add-btn">
          <Plus size={16} /> Add number
        </Button>
      </div>

      {unreadable > 0 && (
        <Alert variant="warning" data-testid="wa-unreadable-alert">
          <WarningCircle size={18} weight="fill" className="shrink-0" />
          <span>
            {unreadable} saved token{unreadable > 1 ? "s" : ""} can't be read, usually because <span className="font-mono">AUTH_SECRET</span> was changed on the server. Edit the number and paste its token again.
          </span>
        </Alert>
      )}

      {numbers === null ? (
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      ) : numbers.length === 0 ? (
        <EmptyState
          icon={WhatsappLogo}
          title="No WhatsApp numbers yet"
          text="Add your WhatsApp Business number so the bot can collect order details from customers."
          action={
            <Button onClick={() => setDialog({ open: true, number: null })} data-testid="wa-add-empty-btn">
              <Plus size={16} /> Add number
            </Button>
          }
        />
      ) : (
        numbers.map((n) => <NumberCard key={n.id} n={n} onEdit={(num) => setDialog({ open: true, number: num })} onChanged={load} />)
      )}

      <div className="flex items-start gap-2 rounded-xl border border-line bg-white/60 p-3 text-xs text-muted">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          <b>Pause</b> keeps everything saved but the bot ignores messages to that number. <b>Delete</b> removes it for good.
        </span>
      </div>

      <NumberDialog open={dialog.open} number={dialog.number} onClose={() => setDialog({ open: false, number: null })} onSaved={load} />
    </div>
  );
}
