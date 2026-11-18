import { useState } from "react";
import { CheckCircle, SignOut } from "@phosphor-icons/react";
import { setupAccount, changePassword, errorMessage } from "../lib/api";
import { passwordProblem } from "../lib/session";
import { Input, Label, Spinner } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import PasswordInput from "../components/PasswordInput";
import AuthShell, { FormError, Notice } from "../components/AuthShell";

/**
 * mode="setup":    first login. Choose name, email and a new password.
 * mode="password": logged in with RESET_PASSWORD. Choose a new password.
 */
export default function AccountSetup({ mode, onDone, onLogout }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setup = mode === "setup";
  const hint = passwordProblem(password, email);

  const submit = async (e) => {
    e.preventDefault();
    if (setup && !name.trim()) return setError("Enter your name");
    if (setup && !email.trim()) return setError("Enter your email");
    if (hint || !password) return setError(hint || "Choose a password");
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError("");
    try {
      if (setup) await setupAccount({ name: name.trim(), email: email.trim(), password });
      else await changePassword("", password);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      subtitle={setup ? "Set up your account" : "Choose a new password"}
      footer={
        <button type="button" onClick={onLogout} className="inline-flex items-center gap-1.5 hover:text-ink" data-testid="setup-logout-btn">
          <SignOut size={14} /> Log out
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4" data-testid="account-setup-form">
        {setup ? (
          <Notice tone="success">
            This replaces the shared admin password. From now on you'll log in with your email and the new password, and reset links are sent to this email.
          </Notice>
        ) : (
          <Notice>
            You logged in with the emergency <span className="font-mono">RESET_PASSWORD</span>. Choose a new password, then remove{" "}
            <span className="font-mono">RESET_PASSWORD</span> from Render.
          </Notice>
        )}
        {setup && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="setup-name">Your name</Label>
              <Input id="setup-name" data-testid="setup-name-input" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-email">Email</Label>
              <Input id="setup-email" data-testid="setup-email-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="text-xs text-muted">Use the same email you sign up to Resend with, so reset emails can reach you.</p>
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="setup-password">New password</Label>
          <PasswordInput id="setup-password" testId="setup-password-input" autoComplete="new-password" autoFocus={!setup} value={password} onChange={setPassword} />
          {password && (
            <p className={`flex items-center gap-1 text-xs ${hint ? "text-terracotta-700" : "text-forest"}`} data-testid="password-hint">
              {hint || (
                <>
                  <CheckCircle size={12} weight="fill" /> Looks good
                </>
              )}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-confirm">Type it again</Label>
          <PasswordInput id="setup-confirm" testId="setup-confirm-input" autoComplete="new-password" value={confirm} onChange={setConfirm} />
        </div>
        <FormError testId="setup-error">{error}</FormError>
        <Button type="submit" disabled={busy} className="w-full" data-testid="setup-submit-btn">
          {busy ? <Spinner /> : <CheckCircle size={16} />} {setup ? "Create my account" : "Save new password"}
        </Button>
      </form>
    </AuthShell>
  );
}
