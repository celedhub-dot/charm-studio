import BrandMark from "./BrandMark";

// Centered card used by the login, setup and reset screens.
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <div className="page-enter w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark size={48} iconSize={22} className="shadow-lift" />
          <h1 className="font-heading text-2xl font-extrabold text-ink">
            {title || (
              <>
                Custom <span className="text-terracotta">Label</span>
              </>
            )}
          </h1>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-line bg-white p-6 shadow-card">{children}</div>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}

export function FormError({ children, testId }) {
  if (!children) return null;
  return (
    <p className="mt-3 text-sm text-danger" role="alert" data-testid={testId}>
      {children}
    </p>
  );
}

export function Notice({ children, testId, tone = "warning" }) {
  if (!children) return null;
  const cls =
    tone === "success"
      ? "border-forest/20 bg-forest-50 text-forest"
      : "border-terracotta/30 bg-terracotta-50 text-terracotta-700";
  return (
    <div className={`mb-4 rounded-xl border px-3 py-2 text-sm ${cls}`} data-testid={testId}>
      {children}
    </div>
  );
}
