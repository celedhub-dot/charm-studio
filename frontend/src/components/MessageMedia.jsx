import { useEffect, useState } from "react";
import { FileText, DownloadSimple, Play, WarningCircle, ImageBroken } from "@phosphor-icons/react";
import { getMediaBlob, errorMessage } from "../lib/api";
import { Spinner } from "./ui/primitives";

// Files are fetched with the login token, so they're turned into blob: URLs.
// Keep them for the session so the 4-second chat refresh doesn't download them again.
const urls = new Map(); // message id -> object URL
const pending = new Map(); // message id -> Promise<url>

function loadUrl(id) {
  if (urls.has(id)) return Promise.resolve(urls.get(id));
  if (!pending.has(id)) {
    pending.set(
      id,
      getMediaBlob(id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          urls.set(id, url);
          return url;
        })
        .finally(() => pending.delete(id))
    );
  }
  return pending.get(id);
}

async function readError(e) {
  // axios gives a Blob for errors on blob requests
  if (e?.response?.data instanceof Blob) {
    try {
      return JSON.parse(await e.response.data.text()).detail || errorMessage(e);
    } catch {
      /* fall through */
    }
  }
  return errorMessage(e);
}

function useMediaUrl(id, auto) {
  const [url, setUrl] = useState(() => urls.get(id) || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setUrl(await loadUrl(id));
    } catch (e) {
      setError(await readError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (auto && !urls.has(id)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, auto]);
  return { url, error, loading, load };
}

const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export { fmtSize, useMediaUrl };

function Failed({ error, onRetry }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs text-muted">
      <WarningCircle size={16} className="shrink-0 text-danger" />
      <span className="flex-1">{error}</span>
      {onRetry && (
        <button type="button" className="font-medium text-forest hover:underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "application/pdf": "pdf",
};

// e.g. "123456789012_1 - 2026-11-19 1705.jpg", so saved files are easy to find by order
function downloadName(m, prefix) {
  if (m.media_name) return m.media_name;
  const d = new Date(m.created_at);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const ext = EXT[m.media_mime] || (m.media_mime || "").split("/").pop() || "bin";
  const who = (prefix || m.customer_phone || "whatsapp").replace(/[\\/:*?"<>|]/g, "_");
  return `${who} - ${stamp}.${ext}`;
}

function saveAs(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function DownloadButton({ onClick, busy, className = "", testId }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${className}`}
      title="Download to this computer"
      aria-label="Download"
      data-testid={testId}
    >
      {busy ? <Spinner className="h-3 w-3" /> : <DownloadSimple size={14} />} Download
    </button>
  );
}

/** Shows the photo / sticker / voice note / video / file attached to a chat message. */
export default function MessageMedia({ m, namePrefix = "" }) {
  const kind = m.kind;
  const auto = kind === "image" || kind === "sticker" || kind === "audio"; // small enough to load right away
  const { url, error, loading, load } = useMediaUrl(m.id, auto);
  const name = m.media_name || (kind === "document" ? "File" : "");
  const [saving, setSaving] = useState(false);
  const download = async () => {
    setSaving(true);
    try {
      saveAs(url || (await loadUrl(m.id)), downloadName(m, namePrefix));
    } catch (e) {
      load(); // shows the reason (e.g. expired) in place of the file
    } finally {
      setSaving(false);
    }
  };

  if (error && !url) return <Failed error={error} onRetry={error.includes("30 days") || error.includes("isn't in Settings") ? null : load} />;

  if (kind === "image" || kind === "sticker") {
    if (!url)
      return (
        <div className={`grid place-items-center rounded-lg bg-black/5 text-muted ${kind === "sticker" ? "h-28 w-28" : "h-48 w-64 max-w-full"}`}>
          {loading ? <Spinner /> : <ImageBroken size={22} />}
        </div>
      );
    return (
      <div className="group relative inline-block max-w-full">
        <a href={url} target="_blank" rel="noreferrer" title="Open full size" data-testid={`media-image-${m.id}`}>
          <img
            src={url}
            alt={m.body || (kind === "sticker" ? "Sticker" : "Photo")}
            className={kind === "sticker" ? "h-28 w-28 object-contain" : "max-h-72 w-auto max-w-full rounded-lg object-cover"}
          />
        </a>
        <DownloadButton
          onClick={download}
          busy={saving}
          testId={`media-download-${m.id}`}
          className="absolute right-1.5 top-1.5 bg-black/60 text-white opacity-90 shadow hover:bg-black/75 group-hover:opacity-100"
        />
      </div>
    );
  }

  if (kind === "audio") {
    return url ? (
      <div className="flex flex-wrap items-center gap-1">
        <audio controls src={url} className="h-10 w-64 max-w-full" data-testid={`media-audio-${m.id}`} />
        <DownloadButton onClick={download} busy={saving} testId={`media-download-${m.id}`} className="text-forest hover:bg-black/5" />
      </div>
    ) : (
      <div className="flex h-10 w-64 max-w-full items-center justify-center rounded-full bg-black/5 text-muted">{loading ? <Spinner /> : "Voice note"}</div>
    );
  }

  if (kind === "video") {
    return (
      <div className="space-y-1">
        {url ? (
          <video controls src={url} className="max-h-72 w-auto max-w-full rounded-lg" data-testid={`media-video-${m.id}`} />
        ) : (
          <button
            type="button"
            onClick={load}
            className="grid h-40 w-64 max-w-full place-items-center rounded-lg bg-black/70 text-white"
            data-testid={`media-video-load-${m.id}`}
          >
            {loading ? <Spinner /> : <Play size={28} weight="fill" />}
          </button>
        )}
        <DownloadButton onClick={download} busy={saving} testId={`media-download-${m.id}`} className="text-forest hover:bg-black/5" />
      </div>
    );
  }

  // document (and anything else with a file)
  return (
    <div className="flex items-center gap-3 rounded-lg bg-black/5 px-3 py-2" data-testid={`media-file-${m.id}`}>
      <FileText size={26} className="shrink-0 text-forest" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="text-[11px] uppercase text-muted">{(m.media_mime || "").split("/").pop()}</div>
      </div>
      <button
        type="button"
        className="rounded-md p-1.5 text-forest hover:bg-black/5"
        onClick={download}
        title="Download"
        aria-label="Download"
        data-testid={`media-download-${m.id}`}
      >
        {loading || saving ? <Spinner /> : <DownloadSimple size={18} />}
      </button>
    </div>
  );
}
