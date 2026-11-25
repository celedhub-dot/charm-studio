import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { SquaresFour, Package, ChatsCircle, ChatCenteredText, Tag, Robot, List, X, SignOut, GearSix } from "@phosphor-icons/react";
import BrandMark, { useBrandLogo } from "./BrandMark";
import { cn } from "../lib/utils";
import { useSession } from "../lib/session";
import { getUnread } from "../lib/api";

export const NAV = [
  { to: "/", label: "Dashboard", icon: SquaresFour, id: "dashboard" },
  { to: "/chats", label: "Chats", icon: ChatCenteredText, id: "chats", badge: "unread" },
  { to: "/customer-data", label: "Customer Data", icon: ChatsCircle, id: "customer-data" },
  { to: "/orders", label: "Orders", icon: Package, id: "orders" },
  { to: "/extract", label: "WhatsApp Extract", icon: ChatsCircle, id: "extract" },
  { to: "/labels", label: "Label Studio", icon: Tag, id: "labels" },
  { to: "/bot", label: "WhatsApp Bot", icon: Robot, id: "bot" },
];
const SETTINGS_NAV = { to: "/settings", label: "Settings", icon: GearSix, id: "settings" };
const pagePermissions = { "/": "dashboard", "/chats": "chats", "/customer-data": "customers",
  "/orders": "orders", "/extract": "extract", "/labels": "labels" };
function allowed(me, path) {
  return me?.role !== "employee" || me.permissions.includes(pagePermissions[path]);
}

function Logo({ shopName }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark size={36} iconSize={18} />
      <div className="min-w-0 leading-tight">
        <div className="font-heading text-lg font-extrabold tracking-tight text-ink">
          Custom <span className="text-terracotta">Label</span>
        </div>
        {shopName && (
          <div className="truncate text-xs text-muted" data-testid="sidebar-shop-name">
            {shopName}
          </div>
        )}
      </div>
    </div>
  );
}

function NavItem({ to, label, icon: Icon, id, onNavigate, count = 0 }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={onNavigate}
      data-testid={`nav-${id}`}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
          isActive ? "bg-forest text-white shadow-card" : "text-muted hover:translate-x-0.5 hover:bg-sand hover:text-ink"
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={19} weight={isActive ? "fill" : "regular"} />
          <span className="flex-1">{label}</span>
          {count > 0 && (
            <span
              className="grid h-5 min-w-5 place-items-center rounded-full bg-terracotta px-1.5 text-[10px] font-bold text-white"
              data-testid={`nav-${id}-badge`}
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// Unread customer messages, for the Chats badge.
function useUnread(enabled) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      getUnread()
        .then((d) => alive && setUnread(d.unread || 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return unread;
}

function NavItems({ onNavigate }) {
  const { me } = useSession();
  const unread = useUnread(allowed(me, "/chats"));
  return (
    <nav className="flex flex-col gap-1">
      {NAV.filter(item => allowed(me, item.to)).map(({ badge, ...item }) => (
        <NavItem key={item.to} {...item} count={badge === "unread" ? unread : 0} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

function AccountBox({ onNavigate, testPrefix = "" }) {
  const { me, logout } = useSession();
  const logo = useBrandLogo();
  const [logoBroken, setLogoBroken] = useState(false);
  const name = me?.name || "Account";
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
  return (
    <div className="space-y-1">
      {allowed(me, "/settings") && <NavItem {...SETTINGS_NAV} id={`${testPrefix}settings`} onNavigate={onNavigate} />}
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-line bg-white p-2.5">
        {logo && !logoBroken ? (
          <img
            src={logo}
            alt=""
            onError={() => setLogoBroken(true)}
            className="h-9 w-9 shrink-0 rounded-full border border-line bg-white object-cover"
            data-testid={`${testPrefix}account-avatar`}
          />
        ) : (
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-terracotta-50 font-heading text-sm font-bold text-terracotta-700">
            {initials || "?"}
          </div>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold text-ink" data-testid={`${testPrefix}account-name`}>
            {name}
          </div>
          <div className="truncate text-xs text-muted">{me?.email}</div>
        </div>
        <button
          data-testid={`${testPrefix}logout-btn`}
          onClick={logout}
          className="rounded-lg p-2 text-muted transition-colors hover:bg-sand hover:text-danger"
          aria-label="Log out"
          title="Log out"
        >
          <SignOut size={18} />
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { settings, me } = useSession();
  const firstAllowed = NAV.find(item => allowed(me, item.to));
  const shopName = settings?.shop?.shop_name || "";
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-cream">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-[#FBFAF6] px-4 py-6 lg:flex">
        <div className="px-2">
          <Logo shopName={shopName} />
        </div>
        <div className="mt-8 flex-1">
          <NavItems />
        </div>
        <AccountBox />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-cream/90 px-4 py-3 backdrop-blur lg:hidden">
        <Logo shopName={shopName} />
        <button
          data-testid="mobile-menu-btn"
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 text-ink transition-colors hover:bg-sand"
          aria-label="Open menu"
        >
          <List size={22} />
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} data-testid="mobile-menu-overlay" />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-[#FBFAF6] px-4 py-5 shadow-lift animate-in slide-in-from-left">
            <div className="mb-6 flex items-center justify-between px-2">
              <Logo shopName={shopName} />
              <button
                data-testid="mobile-menu-close-btn"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 hover:bg-sand"
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>
            <NavItems onNavigate={() => setOpen(false)} />
            <div className="mt-auto border-t border-line pt-3">
              <AccountBox onNavigate={() => setOpen(false)} testPrefix="mobile-" />
            </div>
          </div>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          {allowed(me, location.pathname) ? <Outlet /> : firstAllowed ? <Navigate to={firstAllowed.to} replace /> :
            <p>Your owner has disabled access to all sections.</p>}
        </div>
      </main>
    </div>
  );
}
