import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SignOut, CheckCircle, WarningCircle, XCircle, FloppyDisk } from "@phosphor-icons/react";
import { getLoginHistory, logoutOtherDevices, updateSessionLength, getSystemStatus, errorMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Badge, Spinner, Table, THead, TBody, TR, TH, TD } from "../../components/ui/primitives";
import { SimpleSelect, ConfirmDialog } from "../../components/ui/overlays";
import { Button } from "../../components/ui/button";
import SettingsCard from "./SettingsCard";
import { formatDate } from "../../lib/utils";

const SESSION_OPTIONS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

const METHOD_LABELS = {
  password: "Log in",
  first_login: "First login (admin password)",
  account_setup: "Account set up",
  reset_override: "Emergency reset password",
  password_changed: "Password changed",
  email_changed: "Email changed",
  logout_all: "Logged out other devices",
  reset_requested: "Reset email requested",
  email_reset: "Password reset by email",
};

function device(ua) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function SessionCard() {
  const { me, refreshMe } = useSession();
  const [days, setDays] = useState(String(me?.session_days || 30));
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => setDays(String(me?.session_days || 30)), [me?.session_days]);

  const save = async () => {
    setSaving(true);
    try {
      await updateSessionLength(Number(days));
      await refreshMe();
      toast.success("Saved. New logins will last " + SESSION_OPTIONS.find((o) => o.value === days).label + ".");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const logoutOthers = async () => {
    setLoggingOut(true);
    try {
      await logoutOtherDevices();
      toast.success("Every other device was logged out. You're still logged in here.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <SettingsCard title="Sessions" description="How long you stay logged in, and a way to sign out everywhere else (for example, after using a shared computer)." testId="session-card">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Stay logged in for</div>
          <div className="flex gap-2">
            <SimpleSelect value={days} onValueChange={setDays} options={SESSION_OPTIONS} testId="session-length-select" className="max-w-[160px]" />
            <Button variant="outline" disabled={saving || Number(days) === me?.session_days} onClick={save} data-testid="session-save-btn">
              {saving ? <Spinner /> : <FloppyDisk size={16} />} Save
            </Button>
          </div>
          <p className="text-xs text-muted">Applies from your next login. This login ends {me?.expires_at ? formatDate(me.expires_at) : "—"}.</p>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Other devices</div>
          <ConfirmDialog
            testId="logout-others"
            title="Log out every other device?"
            description="Phones, laptops or browsers where you're logged in will have to log in again. This device stays logged in."
            confirmLabel="Log them out"
            onConfirm={logoutOthers}
            trigger={
              <Button variant="outline" disabled={loggingOut} className="text-danger hover:border-danger/40 hover:bg-danger/5" data-testid="logout-others-btn">
                {loggingOut ? <Spinner /> : <SignOut size={16} />} Log out all other devices
              </Button>
            }
          />
        </div>
      </div>
    </SettingsCard>
  );
}

function HistoryCard() {
  const [rows, setRows] = useState(null);
  const load = useCallback(() => {
    getLoginHistory()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  return (
    <SettingsCard title="Recent activity" description="The last 25 logins and account changes. If you see something you don't recognise, change your password." testId="history-card">
      {rows === null ? (
        <div className="flex justify-center py-6 text-muted">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No activity yet.</p>
      ) : (
        <div className="-mx-5">
          <Table>
            <THead>
              <tr>
                <TH className="pl-5">When</TH>
                <TH>What</TH>
                <TH>Device</TH>
                <TH>IP address</TH>
                <TH className="pr-5">Result</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((r, i) => (
                <TR key={i} data-testid={`history-row-${i}`}>
                  <TD className="whitespace-nowrap pl-5 text-xs text-muted">{formatDate(r.at)}</TD>
                  <TD className="text-sm">{METHOD_LABELS[r.method] || r.method}</TD>
                  <TD className="text-sm">{device(r.user_agent)}</TD>
                  <TD className="font-mono text-xs">{r.ip}</TD>
                  <TD className="pr-5">{r.success ? <Badge>OK</Badge> : <Badge variant="danger">Failed</Badge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </SettingsCard>
  );
}

function StatusRow({ ok, warn, title, children, testId }) {
  const Icon = ok ? CheckCircle : warn ? WarningCircle : XCircle;
  const color = ok ? "text-forest" : warn ? "text-terracotta" : "text-danger";
  return (
    <div className="flex gap-3 py-3" data-testid={testId}>
      <Icon size={20} weight="fill" className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 text-sm">
        <div className="font-medium text-ink">{title}</div>
        <div className="text-muted">{children}</div>
      </div>
    </div>
  );
}

function SystemCard() {
  const [s, setS] = useState(null);
  useEffect(() => {
    getSystemStatus()
      .then(setS)
      .catch(() => setS(false));
  }, []);

  return (
    <SettingsCard title="System status" description="What's set up on the server. These are changed in Render's Environment settings, not here." testId="system-card">
      {s === null ? (
        <div className="flex justify-center py-6 text-muted">
          <Spinner />
        </div>
      ) : s === false ? (
        <p className="text-sm text-muted">Couldn't load the status.</p>
      ) : (
        <div className="divide-y divide-line">
          <StatusRow ok={s.email_reset.configured && s.email_reset.frontend_url_set} warn={s.email_reset.configured && !s.email_reset.frontend_url_set} title="Password reset by email" testId="status-email">
            {s.email_reset.configured ? (
              <>
                Sending from <span className="font-mono">{s.email_reset.sender}</span> to <span className="font-mono">{s.email_reset.account_email}</span>.
                {!s.email_reset.frontend_url_set && (
                  <> Set <span className="font-mono">FRONTEND_URL</span> to your site's address so reset links always point to it.</>
                )}{" "}
                With Resend's test sender, emails only reach the address you signed up to Resend with.
              </>
            ) : (
              <>
                Not set up. Add <span className="font-mono">RESEND_API_KEY</span> (and <span className="font-mono">FRONTEND_URL</span>) in Render to turn on "Forgot password?".
              </>
            )}
          </StatusRow>
          <StatusRow ok={!s.reset_override_active} title="Emergency reset password" testId="status-reset-override">
            {s.reset_override_active ? (
              <span className="text-danger">
                <span className="font-mono">RESET_PASSWORD</span> is set in Render. Anyone who knows it can take over your account. Remove it now.
              </span>
            ) : (
              <>
                Off (good). If you're ever locked out and email reset fails, set <span className="font-mono">RESET_PASSWORD</span> in Render, log in with it, then remove it.
              </>
            )}
          </StatusRow>
          <StatusRow ok={s.ai.ready} warn={!s.ai.ready} title="AI extraction" testId="status-ai">
            {s.ai.provider === "ollama" ? "Ollama" : "Claude (Anthropic)"}
            {s.ai.model && (
              <>
                , bot <span className="font-mono">{s.ai.model}</span>
              </>
            )}
            {s.ai.extract_model && (s.ai.extract_model !== s.ai.model || s.ai.extract_effort) && (
              <>
                , WhatsApp Extract <span className="font-mono">{s.ai.extract_model}</span>
                {s.ai.extract_effort && <> (effort {s.ai.extract_effort})</>}
              </>
            )}
            {s.ai.ready ? ": ready." : ": no API key yet, so WhatsApp Extract and long bot messages won't use AI."}
          </StatusRow>
          <StatusRow ok={s.whatsapp.verify_token_set && s.whatsapp.active > 0} warn={!(s.whatsapp.verify_token_set && s.whatsapp.active > 0)} title="WhatsApp bot" testId="status-whatsapp">
            {s.whatsapp.active} of {s.whatsapp.saved} number{s.whatsapp.saved === 1 ? "" : "s"} active.{" "}
            {s.whatsapp.verify_token_set ? "Webhook verify token is set." : "No webhook verify token: set WA_VERIFY_TOKEN in Render."}
            {s.whatsapp.unreadable_tokens > 0 && <span className="text-danger"> {s.whatsapp.unreadable_tokens} token(s) need re-entering.</span>}
          </StatusRow>
        </div>
      )}
    </SettingsCard>
  );
}

export default function SecurityTab() {
  return (
    <div className="grid gap-6">
      <SessionCard />
      <HistoryCard />
      <SystemCard />
    </div>
  );
}
