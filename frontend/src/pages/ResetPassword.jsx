import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { CheckCircle, SignIn } from "@phosphor-icons/react";
import { resetPassword, errorMessage } from "../lib/api";
import { passwordProblem } from "../lib/session";
import { clearToken } from "../lib/auth";
import { Label, Spinner } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import PasswordInput from "../components/PasswordInput";
import AuthShell, { FormError, Notice } from "../components/AuthShell";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const hint = passwordProblem(password);

  const submit = async (e) => {
    e.preventDefault();
    if (hint || !password) return setError(hint || "Choose a password");
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError("");
    try {
      await resetPassword(token, password);
      clearToken();
      setDone(true);
    } catch (err) {
      setError(err?.response ? errorMessage(err) : "Can't reach the server. Try again in a few seconds.");
    } finally {
      setBusy(false);
    }
  };

  const goLogin = () => navigate("/", { replace: true });

  return (
    <AuthShell subtitle="Choose a new password">
      {!token ? (
        <div data-testid="reset-missing-token">
          <Notice>This link is incomplete. Open the link from your email again, or request a new one.</Notice>
          <Button className="w-full" onClick={goLogin}>
            <SignIn size={16} /> Go to log in
          </Button>
        </div>
      ) : done ? (
        <div data-testid="reset-done">
          <Notice tone="success">Your password is changed. Every device was logged out, so log in again with the new password.</Notice>
          <Button className="w-full" onClick={goLogin} data-testid="reset-login-btn">
            <SignIn size={16} /> Log in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" data-testid="reset-form">
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">New password</Label>
            <PasswordInput id="reset-password" testId="reset-password-input" autoComplete="new-password" autoFocus value={password} onChange={setPassword} />
            {password && (
              <p className={`flex items-center gap-1 text-xs ${hint ? "text-terracotta-700" : "text-forest"}`}>
                {hint || (
                  <>
                    <CheckCircle size={12} weight="fill" /> Looks good
                  </>
                )}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm">Type it again</Label>
            <PasswordInput id="reset-confirm" testId="reset-confirm-input" autoComplete="new-password" value={confirm} onChange={setConfirm} />
          </div>
          <FormError testId="reset-error">{error}</FormError>
          <Button type="submit" disabled={busy} className="w-full" data-testid="reset-submit-btn">
            {busy ? <Spinner /> : <CheckCircle size={16} />} Save new password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
