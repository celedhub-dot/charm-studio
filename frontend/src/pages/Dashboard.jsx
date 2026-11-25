import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  Package,
  CalendarCheck,
  WhatsappLogo,
  ChartPieSlice,
  ArrowRight,
  ChatsCircle,
  Tag,
  Robot,
  PencilSimple,
} from "@phosphor-icons/react";
import { getOrders, getStats, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { PageHeader, StatCard, SourceBadge, EmptyState } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { timeAgo } from "../lib/utils";

const ACTIONS = [
  { to: "/orders", label: "Add an order", text: "Record a customisation by hand", icon: PencilSimple, id: "orders" },
  { to: "/extract", label: "Extract from chat", text: "Let AI read your WhatsApp chats", icon: ChatsCircle, id: "extract" },
  { to: "/labels", label: "Stamp labels", text: "Add details to your label PDF", icon: Tag, id: "labels" },
  { to: "/bot", label: "WhatsApp bot", text: "Collect details automatically", icon: Robot, id: "bot" },
];

export default function Dashboard() {
  const { me } = useSession();
  const viewOrders = me?.role !== "employee" || me.permissions.includes("orders");
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getStats(), viewOrders ? getOrders() : []])
      .then(([s, o]) => {
        setStats(s);
        setRecent(o.slice(0, 8));
      })
      .catch((e) => toast.error(errorMessage(e, "Could not load dashboard")))
      .finally(() => setLoading(false));
  }, [viewOrders]);

  const bySource = stats?.by_source || {};
  const sourceSummary = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k === "ai" ? "AI" : k} ${n}`)
    .join(" · ");

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="A quick look at your customised-charm orders." />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard testId="stat-total" label="Total orders" value={stats?.total_orders} icon={Package} />
        <StatCard testId="stat-today" label="Today" value={stats?.today_orders} icon={CalendarCheck} tone="terracotta" />
        <StatCard testId="stat-whatsapp" label="From WhatsApp" value={stats?.whatsapp_orders} icon={WhatsappLogo} />
        <StatCard
          testId="stat-by-source"
          label="By source"
          value={Object.values(bySource).filter((n) => n > 0).length || 0}
          hint={sourceSummary || "No orders yet"}
          icon={ChartPieSlice}
          tone="neutral"
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent orders</CardTitle>
            <Button asChild variant="link" size="sm" data-testid="dashboard-view-all-btn">
              <Link to="/orders">
                View all <ArrowRight size={14} />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-xl bg-sand" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState icon={Package} title="No orders yet" text="Add one manually or extract them from a WhatsApp chat." />
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-3" data-testid={`recent-order-${o.id}`}>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm text-ink">{o.order_id || "—"}</div>
                      <div className="truncate text-xs text-muted">
                        {[o.product_name, o.charm].filter(Boolean).join(" · ") || "No details"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <SourceBadge source={o.source} />
                      <span className="hidden text-xs text-muted sm:inline">{timeAgo(o.created_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="grid content-start gap-3 lg:col-span-2">
          {ACTIONS.map(({ to, label, text, icon: Icon, id }) => (
            <Link
              key={to}
              to={to}
              data-testid={`quick-action-${id}`}
              className="hover-lift group flex items-center gap-4 rounded-2xl border border-line bg-white p-4 shadow-card"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-forest-50 text-forest transition-colors group-hover:bg-forest group-hover:text-white">
                <Icon size={20} />
              </span>
              <span className="flex-1">
                <span className="block font-heading text-sm font-bold text-ink">{label}</span>
                <span className="block text-xs text-muted">{text}</span>
              </span>
              <ArrowRight size={16} className="text-muted transition-transform group-hover:translate-x-1 group-hover:text-terracotta" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
