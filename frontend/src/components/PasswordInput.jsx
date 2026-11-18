import { useState } from "react";
import { LockKey, Eye, EyeSlash } from "@phosphor-icons/react";
import { Input } from "./ui/primitives";
import { cn } from "../lib/utils";

export default function PasswordInput({ id, value, onChange, testId, autoComplete = "current-password", autoFocus, placeholder, className }) {
  const [show, setShow] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <LockKey size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <Input
        id={id}
        data-testid={testId}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9 pr-10"
      />
      <button
        type="button"
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={() => setShow((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition-colors hover:bg-sand hover:text-ink"
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeSlash size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
