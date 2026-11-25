import { useEffect, useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { BASE } from "../lib/api";
import { cn } from "../lib/utils";

// The shop's WhatsApp Business profile picture (from Meta), used as the logo, profile picture and favicon.
// Looked up once per page load; if there's none, the app keeps its own sparkle icon.
let brandPromise = null;

function loadBrand() {
  if (!brandPromise) {
    brandPromise = fetch(`${BASE}/api/brand`)
      .then((r) => (r.ok ? r.json() : { has_logo: false }))
      .then((b) => {
        const url = b.has_logo ? `${BASE}/api/brand/logo?v=${b.version}` : null;
        if (url) setFavicon(url);
        return url;
      })
      .catch(() => null);
  }
  return brandPromise;
}

function setFavicon(url) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.removeAttribute("type");
  link.href = url;
  const touch = document.querySelector("link[rel='apple-touch-icon']");
  if (touch) touch.href = url;
}

export function useBrandLogo() {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    loadBrand().then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

/** The logo tile: the WhatsApp profile picture, or the green sparkle tile when there isn't one. */
export default function BrandMark({ size = 36, round = false, className, iconSize }) {
  const url = useBrandLogo();
  const [broken, setBroken] = useState(false);
  const shape = round ? "rounded-full" : size >= 44 ? "rounded-2xl" : "rounded-xl";
  if (url && !broken) {
    return (
      <img
        src={url}
        alt="Shop logo"
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={cn("shrink-0 border border-line bg-white object-cover", shape, className)}
        style={{ width: size, height: size }}
        data-testid="brand-logo"
      />
    );
  }
  return (
    <div className={cn("grid shrink-0 place-items-center bg-forest text-white", shape, className)} style={{ width: size, height: size }}>
      <Sparkle size={iconSize || Math.round(size / 2)} weight="fill" />
    </div>
  );
}
