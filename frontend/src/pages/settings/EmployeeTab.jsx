import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

export default function EmployeeTab() {
  const [account, setAccount] = useState(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/employee").then(({ data }) => setAccount(data)).catch(e => setError(errorMessage(e)));
  }, []);
  async function update(key, enabled) {
    setBusy(true);
    setError("");
    try { setAccount((await api.patch("/employee", { key, enabled })).data); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function issue() {
    if (account.initialized && !window.confirm("Replace this employee’s password and end their sessions?")) return;
    setBusy(true);
    setError("");
    try {
      setPassword((await api.post("/employee/temporary-password")).data.password);
      setAccount({ ...account, initialized: true });
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-xl border border-line bg-white p-6">
    <h2 className="font-heading text-lg font-bold">Employee access</h2>
    {error && <p role="alert">{error}</p>}
    {account && <>
      <p>{account.username}</p>
      <label className="flex gap-3"><input type="checkbox" checked={account.enabled} disabled={busy}
        onChange={e => update("enabled", e.target.checked)} />Allow sign-in</label>
      <Button disabled={busy || !account.enabled} onClick={issue}>
        {account.initialized ? "Reset employee password" : "Generate temporary password"}
      </Button>
      {password && <div className="rounded-lg bg-sand p-3">
        <p>Share this temporary password privately. The employee chooses a new password at sign-in.</p>
        <code className="select-all">{password}</code>
        <button className="ml-4 underline" onClick={() => setPassword("")}>Hide</button>
      </div>}
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
        <legend className="mb-3 font-semibold">Permissions</legend>
        {Object.entries(account.options).map(([key, label]) => <label className="flex gap-3" key={key}>
          <input type="checkbox" checked={account.permissions.includes(key)} onChange={e => update(key, e.target.checked)} />{label}
        </label>)}
      </fieldset>
    </>}
  </section>;
}
