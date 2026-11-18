import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { SquaresFour, Package, ChatsCircle, Tag, Robot, List, X, Sparkle, SignOut } from "@phosphor-icons/react";
import { cn } from "../lib/utils";

export const NAV = [
  { to: "/", label: "Dashboard", icon: SquaresFour, id: "dashboard" },
  { to: "/orders", label: "Orders", icon: Package, id: "orders" },
  { to: "/extract", label: "WhatsApp Extract", icon: ChatsCircle, id: "extract" },
  { to: "/labels", label: "Label Studio", icon: Tag, id: "labels" },
  { to: "/bot", label: "WhatsApp Bot", icon: Robot, id: "bot" },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-forest text-white">
        <Sparkle size={18} weight="fill" />
      </div>
      <span className="font-heading text-lg font-extrabold tracking-tight text-ink">
        Charm<span className="text-terracotta">.</span>Studio
      </span>
    </div>
  );
}

function NavItems({ onNavigate }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon, id }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          onClick={onNavigate}
          data-testid={`nav-${id}`}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
              isActive ? "bg-forest text-white shadow-card" : "text-muted hover:bg-sand hover:text-ink hover:translate-x-0.5"
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon size={19} weight={isActive ? "fill" : "regular"} />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function LogoutButton({ onLogout, testId }) {
  return (
    <button
      data-testid={testId}
      onClick={onLogout}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition-all duration-200 hover:bg-sand hover:text-danger"
    >
      <SignOut size={19} /> Log out
    </button>
  );
}

export default function Layout({ onLogout }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-cream">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-[#FBFAF6] px-4 py-6 lg:flex">
        <div className="px-2">
          <Logo />
        </div>
        <div className="mt-8 flex-1">
          <NavItems />
        </div>
        <div className="mb-3">
          <LogoutButton onLogout={onLogout} testId="logout-btn" />
        </div>
        <div className="rounded-xl border border-line bg-white p-3 text-xs text-muted">
          Record customisations, then stamp them onto your Meesho &amp; Flipkart labels.
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-cream/90 px-4 py-3 backdrop-blur lg:hidden">
        <Logo />
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
              <Logo />
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
              <LogoutButton onLogout={onLogout} testId="mobile-logout-btn" />
            </div>
          </div>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
