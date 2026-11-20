import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ArrowsClockwise, FloppyDisk, WarningCircle, SealCheck, ChatCircleText } from "@phosphor-icons/react";
import { getTemplates, saveSettings, waNumbers, errorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Input, Label, Spinner, Alert } from "../../components/ui/primitives";
import { SimpleSelect } from "../../components/ui/overlays";
import { Button } from "../../components/ui/button";
import SettingsCard from "./SettingsCard";
import { FIELDS, tplKey, guessField, fromSaved, render } from "../../components/TemplateDialog";

const EMPTY_REF = { name: "", language: "" };
const refKey = (r) => (r?.name ? `${r.name}|${r.language}` : "");
const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.value, f.label.replace(/ \(.*\)$/, "")]));
// In Settings there's no customer yet, so "Type it in" means fixed text used every time.
const SETTINGS_FIELDS = FIELDS.map((f) => (f.value === "custom" ? { ...f, label: "Fixed text (same every time)" } : f));

/** Settings → Templates: choose what fills each blank, and which template "Send confirmation" and late replies use. */
export default function TemplatesTab() {
  const { setSettings } = useSession();
  const [numbers, setNumbers] = useState(null);
  const [number, setNumber] = useState("");
  const [data, setData] = useState(null); // { templates, settings }
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [slots, setSlots] = useState({ header: [], body: [] });
  const [forConfirm, setForConfirm] = useState(false);
  const [forLate, setForLate] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    waNumbers()
      .then((list) => {
        const active = list.filter((n) => n.active && n.token_ok);
        setNumbers(active);
        setNumber(active[0]?.label || "");
      })
      .catch((e) => {
        setNumbers([]);
        setLoadError(errorMessage(e));
      });
  }, []);

  const load = async (refresh = false) => {
    if (!number) return;
    setLoading(true);
    setLoadError("");
    try {
      const res = await getTemplates(number, refresh);
      setData(res);
      setSelected((cur) => {
        const sendable = res.templates.filter((t) => t.sendable);
        if (cur && sendable.some((t) => tplKey(t) === cur)) return cur;
        const pref = [refKey(res.settings?.late_reply), refKey(res.settings?.confirmation)].find((k) => k && sendable.some((t) => tplKey(t) === k));
        return pref || (sendable[0] ? tplKey(sendable[0]) : "");
      });
    } catch (e) {
      setData(null);
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (number) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  const tpl = data?.templates.find((t) => tplKey(t) === selected) || null;
  const s = data?.settings || {};

  useEffect(() => {
    if (!tpl) return setSlots({ header: [], body: [] });
    const saved = s.maps?.[tplKey(tpl)] || {};
    const build = (names, list = []) =>
      names.map((n, i) => {
        if (list[i] !== undefined && list[i] !== "") return fromSaved(list[i]);
        const guess = tpl.named ? guessField(n) : "";
        return { field: guess === "custom" ? "" : guess, text: "" }; // "" = not chosen yet
      });
    setSlots({ header: build(tpl.header_params, saved.header), body: build(tpl.body_params, saved.body) });
    setForConfirm(refKey(s.confirmation) === tplKey(tpl));
    setForLate(refKey(s.late_reply) === tplKey(tpl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, data]);

  const all = [...slots.header, ...slots.body];
  const hasMessage = all.some((x) => x.field === "message");
  const emptyFixed = all.some((x) => x.field === "custom" && !x.text.trim());
  const unchosen = all.some((x) => !x.field);
  const show = (x) => (!x.field ? "[choose]" : x.field === "custom" ? x.text || "[fixed text]" : `[${FIELD_LABEL[x.field]}]`);

  const setSlot = (part, i, patch) => setSlots((cur) => ({ ...cur, [part]: cur[part].map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const save = async () => {
    if (!tpl) return;
    if (forLate && !hasMessage) return toast.error('For replies after 24 hours, set one blank to "Your message".');
    if (unchosen) return toast.error("Choose what fills every blank.");
    if (emptyFixed) return toast.error("Fill in the fixed text, or pick a field for that blank.");
    const me = { name: tpl.name, language: tpl.language };
    const key = tplKey(tpl);
    const next = {
      confirmation: forConfirm ? me : refKey(s.confirmation) === key ? EMPTY_REF : s.confirmation || EMPTY_REF,
      late_reply: forLate ? me : refKey(s.late_reply) === key ? EMPTY_REF : s.late_reply || EMPTY_REF,
      maps: {
        ...(s.maps || {}),
        [key]: {
          header: slots.header.map((x) => (x.field === "custom" ? x.text.trim() : `{${x.field}}`)),
          body: slots.body.map((x) => (x.field === "custom" ? x.text.trim() : `{${x.field}}`)),
        },
      },
    };
    setSaving(true);
    try {
      const res = await saveSettings("templates", next);
      setSettings(res);
      setData((d) => ({ ...d, settings: res.templates }));
      toast.success(`Saved "${tpl.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const unsendable = data?.templates.filter((t) => !t.sendable) || [];
  const sendable = data?.templates.filter((t) => t.sendable) || [];

  const blankRow = (part, name, i) => {
    const slot = slots[part][i];
    if (!slot) return null;
    return (
      <div key={`${part}-${name}`} className="grid gap-2 sm:grid-cols-[5rem_1fr_1fr] sm:items-center">
        <span className="text-xs text-muted">
          {part === "header" && <span className="mr-1 text-[10px] uppercase tracking-wide">Title</span>}
          <span className="font-mono">{`{{${name}}}`}</span>
        </span>
        <SimpleSelect
          value={slot.field || undefined}
          placeholder="Choose what fills it"
          onValueChange={(v) => setSlot(part, i, { field: v })}
          options={SETTINGS_FIELDS}
          testId={`tpls-field-${part}-${i}`}
          className="h-9"
        />
        {slot.field === "custom" ? (
          <Input data-testid={`tpls-text-${part}-${i}`} className="h-9 text-sm" placeholder="e.g. Celed Hub" value={slot.text} onChange={(e) => setSlot(part, i, { text: e.target.value })} />
        ) : (
          <span className="text-xs text-muted">
            {!slot.field ? "" : slot.field === "message" ? "What staff type in the reply box" : "Filled in from the customer's chat and latest order"}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Message templates"
        description="Templates are messages Meta has approved, for messaging customers after the 24-hour reply window. Create them in Meta's WhatsApp Manager (or the 360dialog Hub), then choose here what fills each blank."
        testId="templates-card"
        footer={
          tpl && (
            <Button onClick={save} disabled={saving} data-testid="tpls-save-btn">
              {saving ? <Spinner /> : <FloppyDisk size={16} />} Save
            </Button>
          )
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>WhatsApp number</Label>
              {numbers === null ? (
                <div className="flex h-10 items-center text-forest">
                  <Spinner />
                </div>
              ) : numbers.length ? (
                <SimpleSelect
                  value={number}
                  onValueChange={setNumber}
                  options={numbers.map((n) => ({ value: n.label, label: n.display ? `${n.label} (${n.display})` : n.label }))}
                  testId="tpls-number-select"
                />
              ) : (
                <p className="flex h-10 items-center text-sm text-muted">
                  No active WhatsApp number yet.&nbsp;
                  <Link to="/settings?tab=whatsapp" className="font-medium text-forest hover:underline">
                    Add one
                  </Link>
                </p>
              )}
              <p className="text-xs text-muted">Templates belong to the number's WhatsApp account. The choices below apply to every number.</p>
            </div>
            <div className="space-y-1.5">
              <Label>In use</Label>
              <div className="space-y-1 rounded-lg border border-line bg-cream/50 p-2.5 text-xs" data-testid="tpls-in-use">
                <div className="flex items-center gap-1.5">
                  <SealCheck size={14} className="text-forest" /> Send confirmation:{" "}
                  <b>{s.confirmation?.name || "not set (chosen the first time you send one)"}</b>
                </div>
                <div className="flex items-center gap-1.5">
                  <ChatCircleText size={14} className="text-forest" /> Replies after 24 hours: <b>{s.late_reply?.name || "off"}</b>
                </div>
              </div>
            </div>
          </div>

          {loading && !data ? (
            <div className="grid place-items-center py-6 text-forest">
              <Spinner />
            </div>
          ) : loadError ? (
            <Alert variant="warning" data-testid="tpls-error">
              <WarningCircle size={18} weight="fill" className="shrink-0" />
              <div>{loadError}</div>
            </Alert>
          ) : data && !sendable.length ? (
            <Alert variant="warning">
              <WarningCircle size={18} weight="fill" className="shrink-0" />
              <div>No approved template on this number yet. Create one (category Utility), wait for approval, then click Reload.</div>
            </Alert>
          ) : data ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Template</Label>
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-forest hover:underline" onClick={() => load(true)} data-testid="tpls-reload-btn">
                    {loading ? <Spinner className="h-3 w-3" /> : <ArrowsClockwise size={12} />} Reload from WhatsApp
                  </button>
                </div>
                <SimpleSelect
                  value={selected}
                  onValueChange={setSelected}
                  options={sendable.map((t) => {
                    const roles = [refKey(s.confirmation) === tplKey(t) && "confirmation", refKey(s.late_reply) === tplKey(t) && "late replies"].filter(Boolean);
                    return { value: tplKey(t), label: `${t.name} · ${t.language} · ${t.category.toLowerCase()}${roles.length ? ` (${roles.join(", ")})` : ""}` };
                  })}
                  testId="tpls-select"
                />
                {unsendable.length > 0 && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">
                      {unsendable.length} other template{unsendable.length > 1 ? "s" : ""} can't be used
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {unsendable.map((t) => (
                        <li key={tplKey(t)}>
                          <b>{t.name}</b> ({t.language}): {t.problem}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {tpl && (tpl.header_params.length > 0 || tpl.body_params.length > 0) && (
                <div className="space-y-2">
                  <Label>What fills each blank</Label>
                  {tpl.header_params.map((n, i) => blankRow("header", n, i))}
                  {tpl.body_params.map((n, i) => blankRow("body", n, i))}
                </div>
              )}

              {tpl && (
                <div className="space-y-1.5">
                  <Label>Preview</Label>
                  <div className="rounded-xl bg-[#EFEAE1] p-3">
                    <div className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-[#DCF3D0] px-3 py-2 text-sm shadow-sm" data-testid="tpls-preview">
                      {tpl.header && <div className="mb-1 font-semibold">{render(tpl.header, tpl.header_params, slots.header.map(show))}</div>}
                      <div className="whitespace-pre-wrap break-words">{render(tpl.body, tpl.body_params, slots.body.map(show))}</div>
                      {tpl.footer && <div className="mt-1 text-xs text-muted">{tpl.footer}</div>}
                      {tpl.buttons.length > 0 && (
                        <div className="mt-2 grid gap-1 border-t border-black/10 pt-1.5">
                          {tpl.buttons.map((b, i) => (
                            <div key={i} className="text-center text-xs font-medium text-sky-700">
                              {b}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tpl && (
                <div className="grid gap-2">
                  <label className="flex items-start gap-2 rounded-lg border border-line p-2.5 text-xs" data-testid="tpls-confirm-label">
                    <input type="checkbox" className="mt-0.5" checked={forConfirm} onChange={(e) => setForConfirm(e.target.checked)} data-testid="tpls-confirm" />
                    <span>
                      <b>Use for "Send confirmation"</b> on orders (Orders page and order cards in Chats).
                    </span>
                  </label>
                  <label
                    className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${hasMessage ? "border-forest/30 bg-forest-50" : "border-line text-muted"}`}
                    data-testid="tpls-late-label"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={forLate}
                      disabled={!hasMessage && !forLate}
                      onChange={(e) => setForLate(e.target.checked)}
                      data-testid="tpls-late"
                    />
                    <span>
                      <b>Use for replies after 24 hours.</b> When a chat's reply window has closed, staff just type in the reply box and it's sent with this
                      template (a small Meta fee each).
                      {!hasMessage && ' Set one blank to "Your message" to turn this on.'}
                    </span>
                  </label>
                </div>
              )}
            </>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}
