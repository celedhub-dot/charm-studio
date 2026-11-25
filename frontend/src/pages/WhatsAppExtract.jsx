import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Sparkle, FileText, UploadSimple, FloppyDisk, ChatText, Stack, CopySimple, Brain } from "@phosphor-icons/react";
import { extractText, extractFile, getExtractOptions, saveAiDefaults, bulkOrders, errorMessage } from "../lib/api";
import { PageHeader, EditableRows } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Textarea, Spinner, Alert, Label } from "../components/ui/primitives";
import { Tabs, TabsList, TabsTrigger, TabsContent, SimpleSelect } from "../components/ui/overlays";import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

function SaveBar({ rows, onSaved, testPrefix }) {
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const save = async () => {
    const clean = rows.filter((r) => Object.values(r).some((v) => String(v || "").trim()));
    if (!clean.length) return toast.error("Nothing to save");
    setSaving(true);
    try {
      const res = await bulkOrders(clean.map((r) => ({ ...r, source: "ai" })));
      toast.success(`Saved ${res.inserted} orders`, { action: { label: "View", onClick: () => navigate("/orders") } });
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-4 flex justify-end">
      <Button onClick={save} disabled={saving} data-testid={`${testPrefix}-save-all-btn`}>
        {saving ? <Spinner /> : <FloppyDisk size={16} />} Save all ({rows.length})
      </Button>
    </div>
  );
}

/* ---------- AI model & effort ---------- */
const AI_PREF_KEY = "charm.extract.ai";
const EFFORT_LABELS = {
  low: "Low: fastest, cheapest",
  medium: "Medium",
  high: "High: thinks harder on messy chats",
  xhigh: "Extra high",
  max: "Max: most thorough, most expensive",
};
// Rough cost of one big exported chat (~500 messages), in rupees, by model and effort. Estimates only.
const COST_HINT = {
  "claude-haiku-5-5": { low: 0.45, medium: 0.55, high: 0.7, xhigh: 0.9, max: 1.2, "": 0.55 },
  "claude-sonnet-5-5": { low: 7, medium: 8.5, high: 10, xhigh: 13, max: 17, "": 10 },
};
const shortName = (id, models) => (models.find((m) => m.id === id)?.label || id || "").replace(/^Claude /, "");

function loadPref() {
  try {
    return JSON.parse(localStorage.getItem(AI_PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function savePref(v) {
  try {
    localStorage.setItem(AI_PREF_KEY, JSON.stringify(v));
  } catch {
    /* private window etc.: the choice just isn't remembered */
  }
}

/** Lets staff pick the Claude model and effort for this extraction. value = { model, effort } ("" = server default). */
function AiPicker({ value, onChange }) {
  const [opts, setOpts] = useState(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const loadOpts = () =>
    getExtractOptions()
      .then(setOpts)
      .catch(() => setOpts({ provider: "unknown", models: [], efforts: [], default: {} }));
  useEffect(() => {
    loadOpts();
  }, []);
  if (!opts) return null;
  if (opts.provider === "ollama") {
    return <p className="text-xs text-muted">AI: Ollama (set on the server).</p>;
  }
  if (!opts.models.length) return null;

  const def = opts.default || {};
  const model = value.model || def.model;
  const effort = value.effort || (value.model ? "" : def.effort || "");
  const cost = COST_HINT[model]?.[effort] ?? COST_HINT[model]?.[""];
  const modelOptions = [
    { value: "default", label: `Default: ${shortName(def.model, opts.models)}${def.effort ? `, ${def.effort} effort` : ""}` },
    ...opts.models.map((m) => ({ value: m.id, label: m.label })),
  ];
  const effortOptions = [{ value: "default", label: "Default for this model" }, ...opts.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e }))];
  const set = (patch) => {
    const next = { ...value, ...patch };
    savePref(next);
    onChange(next);
  };
  // What this device would actually send, compared with the team default
  const differs = !!value.model && (value.model !== def.model || (value.effort || "") !== (def.effort || ""));
  const makeDefault = async () => {
    setSavingDefault(true);
    try {
      await saveAiDefaults(model, effort);
      await loadOpts();
      savePref({});
      onChange({ model: "", effort: "" }); // this device now follows the team default too
      toast.success(`Default for everyone is now ${shortName(model, opts.models)}${effort ? `, ${effort} effort` : ""}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingDefault(false);
    }
  };

  return (
    <div className="mb-5 rounded-2xl border border-line bg-white p-4" data-testid="extract-ai-picker">
      <div className="mb-3 flex items-center gap-2 font-heading text-sm font-bold">
        <Brain size={16} className="text-forest" /> AI model
        {!opts.ready && <span className="text-xs font-normal text-danger">(no API key on the server yet)</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Model</Label>
          <SimpleSelect value={value.model || "default"} onValueChange={(v) => set({ model: v === "default" ? "" : v })} options={modelOptions} testId="extract-model-select" />
          <p className="text-xs text-muted">{opts.models.find((m) => m.id === model)?.hint}</p>
        </div>
        <div className="space-y-1.5">
          <Label>Effort</Label>
          <SimpleSelect value={value.effort || "default"} onValueChange={(v) => set({ effort: v === "default" ? "" : v })} options={effortOptions} testId="extract-effort-select" />
          <p className="text-xs text-muted" data-testid="extract-cost-hint">
            {cost != null ? `About ₹${cost < 1 ? cost.toFixed(2) : Math.round(cost)} for a big chat file (~500 messages); short pastes cost much less.` : ""}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted" data-testid="extract-ai-active">
        <span>
          Next extraction uses <b className="text-ink">{shortName(model, opts.models)}{effort ? `, ${effort} effort` : ""}</b>
          {differs ? " (your choice on this device)" : " (default for everyone)"}.
        </span>
        {differs && opts.can_set_default && (
          <Button size="sm" variant="outline" onClick={makeDefault} disabled={savingDefault} data-testid="extract-make-default">
            {savingDefault ? "Saving…" : "Make this the default for everyone"}
          </Button>
        )}
      </div>
    </div>
  );
}

function PasteTab({ ai }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!text.trim()) return toast.error("Paste some chat text first");
    setLoading(true);
    try {
      const res = await extractText(text, ai);
      setRows(res.orders);
      const by = res.model ? ` (${res.model.replace(/^claude-/, "")}${res.effort ? `, ${res.effort}` : ""})` : "";
      toast[res.orders.length ? "success" : "info"](
        res.orders.length ? `Found ${res.orders.length} orders${by}` : `No orders found in this text${by}`
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Paste chat text</CardTitle>
          <CardDescription>Copy messages from WhatsApp and paste them here. AI picks out each order.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            data-testid="extract-text-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"[12/03, 10:14] Priya: Order 123456789012_1, name Aarav, heart charm\n[12/03, 10:20] Rohan: OD123456789012345678 - 'Mia' with star charm, gift wrap please"}
            className="min-h-[220px] font-mono text-[13px]"
          />
          <div className="mt-4 flex justify-end">
            <Button variant="accent" onClick={run} disabled={loading} data-testid="extract-ai-btn">
              {loading ? <Spinner /> : <Sparkle size={16} weight="fill" />} Extract with AI
            </Button>
          </div>
        </CardContent>
      </Card>
      {rows && (
        <div className="page-enter">
          <h3 className="mb-3 font-heading font-bold">Preview</h3>
          <EditableRows rows={rows} setRows={setRows} testPrefix="paste-preview" />
          <SaveBar rows={rows} testPrefix="paste" onSaved={() => setRows(null)} />
        </div>
      )}
    </div>
  );
}

function FileTab({ ai }) {
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [rows, setRows] = useState(null);
  const inputRef = useRef(null);

  const pick = (f) => {
    if (!f) return;
    if (!/\.txt$/i.test(f.name)) return toast.error("Please choose an exported WhatsApp chat .txt file");
    setFile(f);
    setResult(null);
    setRows(null);
  };

  const run = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const res = await extractFile(file, ai);
      setResult(res);
      setRows(res.orders);
      toast.success(`Found ${res.orders.length} orders${res.model ? ` (${res.model.replace(/^claude-/, "")}${res.effort ? `, ${res.effort}` : ""})` : ""}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload exported chat</CardTitle>
          <CardDescription>
            In WhatsApp: open the chat, tap More, then Export chat, then Without media. Upload the .txt file here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            data-testid="chat-file-dropzone"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              drag ? "border-forest bg-forest-50" : "border-line bg-cream/50 hover:border-forest/40"
            )}
          >
            <FileText size={28} className="text-forest" />
            {file ? (
              <>
                <div className="font-medium text-ink">{file.name}</div>
                <div className="text-xs text-muted">{(file.size / 1024).toFixed(1)} KB · click to change</div>
              </>
            ) : (
              <>
                <div className="font-medium text-ink">Drop your chat .txt here</div>
                <div className="text-xs text-muted">or click to browse</div>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".txt,text/plain"
              hidden
              data-testid="chat-file-input"
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          {loading && (
            <Alert className="mt-4" variant="success" data-testid="bulk-progress">
              <Spinner className="mt-0.5 text-forest" />
              <div>
                <div className="font-medium">Reading your chat…</div>
                <div className="text-xs opacity-80">
                  Large chats are split into parts and read one by one. This can take a minute or two.
                </div>
                <div className="mt-2 h-1.5 w-56 overflow-hidden rounded-full bg-forest/10">
                  <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-forest" />
                </div>
              </div>
            </Alert>
          )}

          <div className="mt-4 flex justify-end">
            <Button variant="accent" onClick={run} disabled={!file || loading} data-testid="bulk-extract-btn">
              {loading ? <Spinner /> : <UploadSimple size={16} />} Extract orders
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <div className="page-enter grid gap-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              ["Chunks processed", result.chunks_processed, Stack, "bulk-chunks"],
              ["Orders found", rows?.length ?? 0, ChatText, "bulk-found"],
              ["Duplicates removed", result.duplicates_removed, CopySimple, "bulk-dupes"],
            ].map(([label, value, Icon, id]) => (
              <div key={id} data-testid={id} className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
                  <Icon size={14} /> {label}
                </div>
                <div className="mt-1 font-heading text-2xl font-extrabold">{value}</div>
              </div>
            ))}
          </div>
          <EditableRows rows={rows} setRows={setRows} testPrefix="file-preview" />
          <SaveBar
            rows={rows}
            testPrefix="file"
            onSaved={() => {
              setRows(null);
              setResult(null);
              setFile(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function WhatsAppExtract() {
  const [ai, setAi] = useState(() => {
    const p = loadPref();
    return { model: p.model || "", effort: p.effort || "" };
  });
  return (
    <div>
      <PageHeader title="WhatsApp Extract" subtitle="Turn customer chats into structured orders with AI, review them, then save." />
      <AiPicker value={ai} onChange={setAi} />
      <Tabs defaultValue="paste">
        <TabsList>
          <TabsTrigger value="paste" data-testid="tab-paste">
            <ChatText size={16} /> Paste text
          </TabsTrigger>
          <TabsTrigger value="file" data-testid="tab-file">
            <FileText size={16} /> Upload chat file
          </TabsTrigger>
        </TabsList>
        <TabsContent value="paste">
          <PasteTab ai={ai} />
        </TabsContent>
        <TabsContent value="file">
          <FileTab ai={ai} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
