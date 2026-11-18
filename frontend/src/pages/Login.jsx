import { useState } from "react";
import { Sparkle, LockKey, Eye, EyeSlash, SignIn } from "@phosphor-icons/react";
import { login, errorMessage } from "../lib/api";
import { Input, Label, Spinner } from "../components/ui/primitives";
import { Button } from "../components/ui/button";

export default function Login({ onLoggedIn, notice }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!password) return setError("Enter your password");
    setBusy(true);
    setError("");
    try {
      await login(password);
      onLoggedIn();
    } catch (err) {
      setError(err?.response ? errorMessage(err) : "Can't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <div className="page-enter w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-forest text-white shadow-lift">
            <Sparkle size={22} weight="fill" />
          </div>
          <h1 className="font-heading text-2xl font-extrabold text-ink">
            Charm<span className="text-terracotta">.</span>Studio
          </h1>
          <p className="text-sm text-muted">Log in to manage your orders and labels.</p>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-line bg-white p-6 shadow-card" data-testid="login-form">
          {notice && (
            <div className="mb-4 rounded-xl border border-terracotta/30 bg-terracotta-50 px-3 py-2 text-sm text-terracotta-700" data-testid="login-notice">
              {notice}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <div className="relative">
              <LockKey size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                id="login-password"
                data-testid="login-password-input"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-9 pr-10"
              />
              <button
                type="button"
                data-testid="login-toggle-password-btn"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition-colors hover:bg-sand hover:text-ink"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && (
            <p className="mt-3 text-sm text-danger" role="alert" data-testid="login-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="mt-5 w-full" data-testid="login-submit-btn">
            {busy ? <Spinner /> : <SignIn size={16} />} Log in
          </Button>
        </form>
      </div>
    </div>
  );
}
