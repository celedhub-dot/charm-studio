import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FloppyDisk } from "@phosphor-icons/react";
import { saveSettings, errorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Input, Label, Switch, Spinner } from "../../components/ui/primitives";
import { SimpleSelect } from "../../components/ui/overlays";
import { Button } from "../../components/ui/button";
import SettingsCard from "./SettingsCard";
import { POSITIONS, StickerPreview } from "../LabelStudio";

export default function LabelsTab() {
  const { settings, setSettings } = useSession();
  const saved = settings?.labels || { position: "bottom-right", font_size: 8, skip_unmatched: false };
  const [form, setForm] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings?.labels || saved), [settings?.labels]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = form.position !== saved.position || Number(form.font_size) !== Number(saved.font_size) || form.skip_unmatched !== saved.skip_unmatched;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      setSettings(await saveSettings("labels", { ...form, font_size: Number(form.font_size) || 8 }));
      toast.success("Label defaults saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        title="Label Studio defaults"
        description="Label Studio starts with these choices every time. You can still change them for a single PDF there."
        testId="labels-card"
        footer={
          <Button type="submit" disabled={saving || !dirty} data-testid="labels-save-btn">
            {saving ? <Spinner /> : <FloppyDisk size={16} />} Save defaults
          </Button>
        }
      >
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Sticker corner</Label>
            <div className="flex items-center gap-3">
              <StickerPreview position={form.position} />
              <SimpleSelect value={form.position} onValueChange={(v) => setForm({ ...form, position: v })} options={POSITIONS} testId="default-position-select" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="default-font-size">Font size (pt)</Label>
            <Input
              id="default-font-size"
              data-testid="default-font-size-input"
              type="number"
              min={5}
              max={14}
              step={0.5}
              value={form.font_size}
              onChange={(e) => setForm({ ...form, font_size: e.target.value })}
            />
            <p className="text-xs text-muted">5 to 14. 8 fits most labels.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="default-skip">Skip unmatched pages</Label>
            <div className="flex h-10 items-center gap-3">
              <Switch id="default-skip" data-testid="default-skip-switch" checked={!!form.skip_unmatched} onCheckedChange={(v) => setForm({ ...form, skip_unmatched: v })} />
              <span className="text-sm text-muted">{form.skip_unmatched ? "No red stickers" : "Mark with red sticker"}</span>
            </div>
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}
