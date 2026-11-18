import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/primitives";
import { cn } from "../../lib/utils";

export default function SettingsCard({ title, description, children, footer, className, testId }) {
  return (
    <Card className={cn("overflow-hidden", className)} data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-cream/40 px-5 py-3">{footer}</div>}
    </Card>
  );
}
