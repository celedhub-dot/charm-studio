import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted/70 transition-colors focus-visible:outline-none focus-visible:border-forest/50 focus-visible:ring-2 focus-visible:ring-forest/15 disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[90px] w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus-visible:outline-none focus-visible:border-forest/50 focus-visible:ring-2 focus-visible:ring-forest/15",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn("text-xs font-medium uppercase tracking-wide text-muted", className)} {...props} />
));
Label.displayName = "Label";

export const Card = ({ className, ...props }) => (
  <div className={cn("rounded-2xl border border-line bg-white shadow-card", className)} {...props} />
);
export const CardHeader = ({ className, ...props }) => (
  <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />
);
export const CardTitle = ({ className, children, ...props }) => (
  <h3 className={cn("font-heading text-base font-bold text-ink", className)} {...props}>
    {children}
  </h3>
);
export const CardDescription = ({ className, ...props }) => <p className={cn("text-sm text-muted", className)} {...props} />;
export const CardContent = ({ className, ...props }) => <div className={cn("p-5 pt-0", className)} {...props} />;

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", {
  variants: {
    variant: {
      default: "bg-forest-50 text-forest",
      accent: "bg-terracotta-50 text-terracotta-700",
      danger: "bg-danger/10 text-danger",
      neutral: "bg-sand text-muted",
      outline: "border border-line text-muted",
    },
  },
  defaultVariants: { variant: "default" },
});
export const Badge = ({ className, variant, ...props }) => <span className={cn(badgeVariants({ variant }), className)} {...props} />;

export const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-forest data-[state=unchecked]:bg-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest/30",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export const Alert = ({ className, variant = "default", ...props }) => (
  <div
    role="alert"
    className={cn(
      "flex gap-3 rounded-xl border p-4 text-sm",
      variant === "warning" && "border-terracotta/30 bg-terracotta-50 text-terracotta-700",
      variant === "success" && "border-forest/20 bg-forest-50 text-forest",
      variant === "default" && "border-line bg-white text-ink",
      className
    )}
    {...props}
  />
);

export const Table = ({ className, ...props }) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
);
export const THead = ({ className, ...props }) => <thead className={cn("border-b border-line bg-cream/60", className)} {...props} />;
export const TBody = (props) => <tbody {...props} />;
export const TR = ({ className, ...props }) => (
  <tr className={cn("border-b border-line/70 transition-colors last:border-0 hover:bg-cream/50", className)} {...props} />
);
export const TH = ({ className, ...props }) => (
  <th className={cn("h-10 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted", className)} {...props} />
);
export const TD = ({ className, ...props }) => <td className={cn("px-3 py-2.5 align-middle text-ink", className)} {...props} />;

export const Spinner = ({ className }) => (
  <span className={cn("inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />
);
