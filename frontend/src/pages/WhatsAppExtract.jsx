import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Sparkle, FileText, UploadSimple, FloppyDisk, ChatText, Stack, CopySimple } from "@phosphor-icons/react";
import { extractText, extractFile, bulkOrders, errorMessage } from "../lib/api";
import { PageHeader, EditableRows } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Textarea, Spinner, Alert } from "../components/ui/primitives";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
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

function PasteTab() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!text.trim()) return toast.error("Paste some chat text first");
    setLoading(true);
    try {
      const res = await extractText(text);
      setRows(res.orders);
      toast[res.orders.length ? "success" : "info"](
        res.orders.length ? `Found ${res.orders.length} orders` : "No orders found in this text"
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

function FileTab() {
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
      const res = await extractFile(file);
      setResult(res);
      setRows(res.orders);
      toast.success(`Found ${res.orders.length} orders`);
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
  return (
    <div>
      <PageHeader title="WhatsApp Extract" subtitle="Turn customer chats into structured orders with AI, review them, then save." />
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
          <PasteTab />
        </TabsContent>
        <TabsContent value="file">
          <FileTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
