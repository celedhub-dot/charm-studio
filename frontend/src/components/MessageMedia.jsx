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
export { fmtSize };

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

/** Shows the photo / sticker / voice note / video / file attached to a chat message. */
export default function MessageMedia({ m }) {
  const kind = m.kind;
  const auto = kind === "image" || kind === "sticker" || kind === "audio"; // small enough to load right away
  const { url, error, loading, load } = useMediaUrl(m.id, auto);
  const name = m.media_name || (kind === "document" ? "File" : "");

  if (error && !url) return <Failed error={error} onRetry={error.includes("30 days") || error.includes("isn't in Settings") ? null : load} />;

  if (kind === "image" || kind === "sticker") {
    if (!url)
      return (
        <div className={`grid place-items-center rounded-lg bg-black/5 text-muted ${kind === "sticker" ? "h-28 w-28" : "h-48 w-64 max-w-full"}`}>
          {loading ? <Spinner /> : <ImageBroken size={22} />}
        </div>
      );
    return (
      <a href={url} target="_blank" rel="noreferrer" title="Open full size" data-testid={`media-image-${m.id}`}>
        <img
          src={url}
          alt={m.body || (kind === "sticker" ? "Sticker" : "Photo")}
          className={kind === "sticker" ? "h-28 w-28 object-contain" : "max-h-72 w-auto max-w-full rounded-lg object-cover"}
        />
      </a>
    );
  }

  if (kind === "audio") {
    return url ? (
      <audio controls src={url} className="h-10 w-64 max-w-full" data-testid={`media-audio-${m.id}`} />
    ) : (
      <div className="flex h-10 w-64 max-w-full items-center justify-center rounded-full bg-black/5 text-muted">{loading ? <Spinner /> : "Voice note"}</div>
    );
  }

  if (kind === "video") {
    return url ? (
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
    );
  }

  // document (and anything else with a file)
  const open = async () => {
    const u = url || (await loadUrl(m.id).catch(async (e) => {
      throw new Error(await readError(e));
    }));
    const a = document.createElement("a");
    a.href = u;
    a.download = name || "file";
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
  };
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
        onClick={() => open().catch((e) => load())}
        title="Download"
        aria-label="Download"
      >
        {loading ? <Spinner /> : <DownloadSimple size={18} />}
      </button>
    </div>
  );
}
