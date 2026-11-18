import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FloppyDisk, Key, CheckCircle } from "@phosphor-icons/react";
import { updateProfile, changePassword, errorMessage } from "../../lib/api";
import { useSession, passwordProblem } from "../../lib/session";
import { Input, Label, Spinner } from "../../components/ui/primitives";
import { Button } from "../../components/ui/button";
import PasswordInput from "../../components/PasswordInput";
import SettingsCard from "./SettingsCard";
import { formatDate } from "../../lib/utils";

function ProfileCard() {
  const { me, refreshMe } = useSession();
  const [name, setName] = useState(me?.name || "");
  const [email, setEmail] = useState(me?.email || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(me?.name || "");
    setEmail(me?.email || "");
  }, [me?.name, me?.email]);

  const emailChanged = email.trim().toLowerCase() !== (me?.email || "").toLowerCase();
  const dirty = name.trim() !== (me?.name || "") || emailChanged;

  const save = async (e) => {
    e.preventDefault();
    if (emailChanged && !currentPassword) return toast.error("Enter your current password to change your email");
    setSaving(true);
    try {
      await updateProfile({ name: name.trim(), email: email.trim(), current_password: currentPassword });
      setCurrentPassword("");
      await refreshMe();
      toast.success(emailChanged ? "Email changed. Use it next time you log in." : "Profile saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        title="Profile"
        description="Your name appears in the sidebar and reset emails. Your email is your login and where reset links are sent."
        testId="profile-card"
        footer={
          <Button type="submit" disabled={saving || !dirty} data-testid="profile-save-btn">
            {saving ? <Spinner /> : <FloppyDisk size={16} />} Save profile
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" data-testid="profile-name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" data-testid="profile-email-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          {emailChanged && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="profile-current-password">Current password (needed to change your email)</Label>
              <PasswordInput id="profile-current-password" testId="profile-current-password-input" value={currentPassword} onChange={setCurrentPassword} />
            </div>
          )}
        </div>
      </SettingsCard>
    </form>
  );
}

function PasswordCard() {
  const { me, refreshMe } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const hint = passwordProblem(next, me?.email);

  const save = async (e) => {
    e.preventDefault();
    if (!current) return toast.error("Enter your current password");
    if (hint || !next) return toast.error(hint || "Choose a new password");
    if (next !== confirm) return toast.error("The two new passwords don't match");
    setSaving(true);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      await refreshMe();
      toast.success("Password changed. Other devices were logged out.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsCard
        title="Password"
        description={me?.password_changed_at ? `Last changed ${formatDate(me.password_changed_at)}.` : "Choose a strong password only you know."}
        testId="password-card"
        footer={
          <Button type="submit" disabled={saving || !current || !next} data-testid="password-save-btn">
            {saving ? <Spinner /> : <Key size={16} />} Change password
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <PasswordInput id="pw-current" testId="pw-current-input" value={current} onChange={setCurrent} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">New password</Label>
            <PasswordInput id="pw-new" testId="pw-new-input" autoComplete="new-password" value={next} onChange={setNext} />
            {next && (
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
            <Label htmlFor="pw-confirm">Type it again</Label>
            <PasswordInput id="pw-confirm" testId="pw-confirm-input" autoComplete="new-password" value={confirm} onChange={setConfirm} />
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">Changing your password keeps you logged in here and logs out every other device.</p>
      </SettingsCard>
    </form>
  );
}

export default function AccountTab() {
  return (
    <div className="grid gap-6">
      <ProfileCard />
      <PasswordCard />
    </div>
  );
}
