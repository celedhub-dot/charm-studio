import { useSearchParams } from "react-router";
import { UserCircle, WhatsappLogo, Storefront, Tag, ShieldCheck, FileText } from "@phosphor-icons/react";
import { PageHeader } from "../components/common";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/overlays";
import AccountTab from "./settings/AccountTab";
import WhatsAppNumbersTab from "./settings/WhatsAppNumbersTab";
import TemplatesTab from "./settings/TemplatesTab";
import ShopBotTab from "./settings/ShopBotTab";
import LabelsTab from "./settings/LabelsTab";
import SecurityTab from "./settings/SecurityTab";
import EmployeeTab from "./settings/EmployeeTab";

const TABS = [
  { id: "employee", label: "Employee access", icon: UserCircle, Component: EmployeeTab },
  { id: "account", label: "Account", icon: UserCircle, Component: AccountTab },
  { id: "whatsapp", label: "WhatsApp numbers", icon: WhatsappLogo, Component: WhatsAppNumbersTab },
  { id: "templates", label: "Templates", icon: FileText, Component: TemplatesTab },
  { id: "shop", label: "Shop & bot", icon: Storefront, Component: ShopBotTab },
  { id: "labels", label: "Label defaults", icon: Tag, Component: LabelsTab },
  { id: "security", label: "Security", icon: ShieldCheck, Component: SecurityTab },
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "account";

  return (
    <div>
      <PageHeader title="Settings" subtitle="Your account, WhatsApp numbers, message templates, bot wording and app preferences." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <div className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          <TabsList className="w-max">
            {TABS.map(({ id, label, icon: Icon }) => (
              <TabsTrigger key={id} value={id} data-testid={`settings-tab-${id}`}>
                <Icon size={16} /> {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {TABS.map(({ id, Component }) => (
          <TabsContent key={id} value={id} className="page-enter">
            <Component />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
