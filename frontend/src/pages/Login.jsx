import { useEffect, useState } from "react";
import { SignIn, EnvelopeSimple, ArrowLeft, PaperPlaneTilt } from "@phosphor-icons/react";
import { login, getAuthConfig, forgotPassword, errorMessage } from "../lib/api";
import { Input, Label, Spinner } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import PasswordInput from "../components/PasswordInput";
import AuthShell, { FormError, Notice } from "../components/AuthShell";

const unreachable = "Can't reach the server. It may be waking up; wait a few seconds and try again.";

export default function Login({ onLoggedIn, notice }) {
  const [config, setConfig] = useState(null);
  const [mode, setMode] = useState("login"); // login | forgot | sent
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentMessage, setSentMessage] = useState("");

  useEffect(() => {
    getAuthConfig()
      .then(setConfig)
      .catch(() => setConfig({ setup_required: false, password_reset_email: false, problem: null, unreachable: true }));
  }, []);

  const firstTime = config?.setup_required;

  const submit = async (e) => {
    e.preventDefault();
    if (!firstTime && !email.trim()) return setError("Enter your email");
    if (!password) return setError("Enter your password");
    setBusy(true);
    setError("");
    try {
      const res = await login(email.trim(), password);
      onLoggedIn(res.scope);
    } catch (err) {
      setError(err?.response ? errorMessage(err) : unreachable);
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async (e) => {
    e.preventDefault();
    if (!email.trim()) return setError("Enter your email");
    setBusy(true);
    setError("");
    try {
      const res = await forgotPassword(email.trim());
      setSentMessage(res.message);
      setMode("sent");
    } catch (err) {
      setError(err?.response ? errorMessage(err) : unreachable);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "forgot" || mode === "sent") {
    return (
      <AuthShell subtitle="Reset your password">
        {mode === "sent" ? (
          <div data-testid="forgot-sent">
            <Notice tone="success">{sentMessage}</Notice>
            <p className="text-sm text-muted">Check your inbox (and spam folder) for an email from Charm.Studio.</p>
          </div>
        ) : config?.password_reset_email ? (
          <form onSubmit={sendReset} data-testid="forgot-form">
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">Your account email</Label>
              <div className="relative">
                <EnvelopeSimple size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <Input id="forgot-email" data-testid="forgot-email-input" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="pl-9" />
              </div>
            </div>
            <FormError testId="forgot-error">{error}</FormError>
            <Button type="submit" disabled={busy} className="mt-5 w-full" data-testid="forgot-submit-btn">
              {busy ? <Spinner /> : <PaperPlaneTilt size={16} />} Email me a reset link
            </Button>
          </form>
        ) : (
          <div className="space-y-2 text-sm text-muted" data-testid="forgot-unavailable">
            <p className="font-medium text-ink">Email reset isn't set up on the server yet.</p>
            <p>
              To get back in: in Render, open your API service, go to Environment and add <span className="font-mono text-ink">RESET_PASSWORD</span> with
              a temporary password (8+ characters). Log in with it, choose a new password, then delete <span className="font-mono text-ink">RESET_PASSWORD</span>.
            </p>
          </div>
        )}
        <Button variant="ghost" className="mt-4 w-full" onClick={() => { setMode("login"); setError(""); }} data-testid="back-to-login-btn">
          <ArrowLeft size={16} /> Back to log in
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle={firstTime ? "Welcome! Let's set up your account." : "Log in to manage your orders and labels."}>
      <form onSubmit={submit} data-testid="login-form">
        <Notice testId="login-notice">{notice || config?.problem || (config?.unreachable ? unreachable : "")}</Notice>
        {firstTime && (
          <Notice tone="success" testId="first-time-hint">
            First time? Enter the <span className="font-mono">ADMIN_PASSWORD</span> you set on the server. Next you'll choose your name, email and a new password.
          </Notice>
        )}
        {!firstTime && (
          <div className="mb-4 space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <div className="relative">
              <EnvelopeSimple size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input id="login-email" data-testid="login-email-input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="pl-9" />
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-password">{firstTime ? "Admin password" : "Password"}</Label>
            {!firstTime && config && (
              <button type="button" className="text-xs font-medium text-forest hover:underline" onClick={() => { setMode("forgot"); setError(""); }} data-testid="forgot-password-link">
                Forgot password?
              </button>
            )}
          </div>
          <PasswordInput id="login-password" testId="login-password-input" value={password} onChange={setPassword} autoFocus={firstTime} />
        </div>
        <FormError testId="login-error">{error}</FormError>
        <Button type="submit" disabled={busy || !config} className="mt-5 w-full" data-testid="login-submit-btn">
          {busy ? <Spinner /> : <SignIn size={16} />} {firstTime ? "Continue" : "Log in"}
        </Button>
      </form>
    </AuthShell>
  );
}
