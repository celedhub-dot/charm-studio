import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  Copy,
  CheckCircle,
  WarningCircle,
  PhoneCall,
  ChatsTeardrop,
  WhatsappLogo,
  PaperPlaneTilt,
  Plugs,
  Broadcast,
} from "@phosphor-icons/react";
import { waStatus, waNumbers, waConversations, waTestSend, errorMessage } from "../lib/api";
import { PageHeader, StatCard, EmptyState } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Input, Label, Textarea, Alert, Badge, Spinner } from "../components/ui/primitives";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent, SimpleSelect } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
import { timeAgo } from "../lib/utils";

const STEP_LABELS = ["Order ID", "Name", "Charm", "Notes"];

const SETUP = [
  {
    title: "Create a Meta app",
    body: (
      <>
        Go to <span className="font-mono text-ink">developers.facebook.com</span>, choose My Apps, then Create App. Pick the
        Business type and connect it to your Meta Business account.
      </>
    ),
  },
  {
    title: "Add the WhatsApp product",
    body: <>On the app dashboard, find WhatsApp and click Set up. Meta gives you a test number, or you can add your own business number.</>,
  },
  {
    title: "Add your number in Settings",
    body: (
      <>
        Under WhatsApp, then API Setup, copy the <b>Phone Number ID</b> and create a permanent access token (a System User in Business Settings).
        Then open{" "}
        <Link to="/settings?tab=whatsapp" className="font-medium text-forest hover:underline">
          Settings, then WhatsApp numbers
        </Link>{" "}
        and click Add number. The app checks the details with Meta and stores the token encrypted. You can add as many numbers as you like.
      </>
    ),
  },
  {
    title: "Set the webhook callback URL and verify token",
    body: (
      <>
        In WhatsApp, then Configuration, click Edit next to Webhook. Paste the callback URL shown above and the same value you set
        as <span className="font-mono text-ink">WA_VERIFY_TOKEN</span>. Meta must reach it over public HTTPS, so use your Render
        URL (or an ngrok tunnel when testing locally).
      </>
    ),
  },
  {
    title: 'Subscribe to the "messages" field',
    body: <>Still under Webhook fields, click Manage and subscribe to <b>messages</b>. Send a WhatsApp message to your number to test.</>,
  },
];

export default function WhatsAppBot() {
  const [status, setStatus] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [convs, setConvs] = useState([]);
  const [send, setSend] = useState({ logical_id: "", to: "", text: "Hello from Custom Label!" });
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const refreshLive = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([waStatus(), waConversations()]);
      setStatus(s);
      setConvs(c);
    } catch {
      /* keep last good state while polling */
    }
  }, []);

  useEffect(() => {
    waNumbers()
      .then((n) => {
        setNumbers(n);
        if (n[0]) setSend((s) => ({ ...s, logical_id: s.logical_id || n[0].logical_id }));
      })
      .catch((e) => toast.error(errorMessage(e, "Could not load numbers")));
    refreshLive();
    const t = setInterval(refreshLive, 5000);
    return () => clearInterval(t);
  }, [refreshLive]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status?.callback_url || "");
      setCopied(true);
      toast.success("Callback URL copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  };

  const testSend = async (e) => {
    e.preventDefault();
    if (!send.logical_id || !send.to || !send.text) return toast.error("Pick a number, recipient and message");
    setSending(true);
    try {
      await waTestSend(send);
      toast.success("Test message sent");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="WhatsApp Bot"
        subtitle="Customers message your WhatsApp number and the bot asks for their Order ID, name, charm and notes, then saves the order."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          testId="wa-stat-status"
          label="Status"
          value={status ? (status.configured ? "Live" : "Off") : "…"}
          icon={Plugs}
          tone={status?.configured ? "forest" : "terracotta"}
          hint={status ? `Graph API ${status.graph_version}` : ""}
        />
        <StatCard testId="wa-stat-numbers" label="Numbers" value={status?.numbers_count} icon={PhoneCall} tone="neutral" />
        <StatCard testId="wa-stat-active" label="Active chats" value={status?.active_conversations} icon={ChatsTeardrop} tone="terracotta" />
        <StatCard testId="wa-stat-orders" label="Bot orders" value={status?.whatsapp_orders} icon={WhatsappLogo} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="grid content-start gap-6 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Webhook callback URL</CardTitle>
              <CardDescription>Paste this into the Meta Developer Console.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input readOnly value={status?.callback_url || ""} className="font-mono text-[13px]" data-testid="callback-url-input" />
                <Button variant="outline" onClick={copy} data-testid="copy-callback-btn" aria-label="Copy callback URL">
                  {copied ? <CheckCircle size={16} className="text-forest" /> : <Copy size={16} />}
                </Button>
              </div>
              {status?.callback_url?.startsWith("http://") && (
                <p className="text-xs text-terracotta-700">
                  This is not HTTPS. Meta needs a public HTTPS URL: use your Render service URL, or run ngrok when testing locally.
                </p>
              )}
              {status &&
                (status.verify_token_set ? (
                  <Alert variant="success" data-testid="verify-token-alert">
                    <CheckCircle size={18} weight="fill" className="shrink-0" />
                    <span>Verify token is set. Use the same value in the Meta console.</span>
                  </Alert>
                ) : (
                  <Alert variant="warning" data-testid="verify-token-alert">
                    <WarningCircle size={18} weight="fill" className="shrink-0" />
                    <span>
                      No verify token set. Add <span className="font-mono">WA_VERIFY_TOKEN</span> to the backend environment and restart.
                    </span>
                  </Alert>
                ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Meta setup, step by step</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible defaultValue="step-0">
                {SETUP.map((s, i) => (
                  <AccordionItem key={i} value={`step-${i}`}>
                    <AccordionTrigger data-testid={`setup-step-${i}`}>
                      <span className="flex items-center gap-3">
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-forest-50 text-xs font-bold text-forest">{i + 1}</span>
                        {s.title}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pl-9 leading-relaxed">{s.body}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected numbers</CardTitle>
            </CardHeader>
            <CardContent>
              {numbers.length === 0 ? (
                <EmptyState
                  icon={PhoneCall}
                  title="No active numbers"
                  text="Add your WhatsApp Business number in Settings so the bot can reply to customers."
                  action={
                    <Button asChild variant="outline" size="sm" data-testid="bot-manage-numbers-btn">
                      <Link to="/settings?tab=whatsapp">Manage numbers</Link>
                    </Button>
                  }
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {numbers.map((n) => (
                    <div key={n.logical_id} data-testid={`wa-number-${n.logical_id}`} className="hover-lift rounded-xl border border-line p-4">
                      <div className="flex items-center justify-between">
                        <Badge>{n.logical_id}</Badge>
                        <WhatsappLogo size={18} className="text-forest" weight="fill" />
                      </div>
                      <div className="mt-3 font-heading font-bold">{n.display || "No display number"}</div>
                      <div className="mt-0.5 font-mono text-xs text-muted">ID {n.phone_id}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Send a test message</CardTitle>
              <CardDescription>The recipient must have messaged your number in the last 24 hours (or be a test recipient).</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={testSend}>
                <div className="space-y-1.5">
                  <Label>From number</Label>
                  <SimpleSelect
                    testId="test-send-number-select"
                    value={send.logical_id}
                    onValueChange={(v) => setSend({ ...send, logical_id: v })}
                    options={numbers.map((n) => ({ value: n.logical_id, label: `${n.logical_id} ${n.display ? `(${n.display})` : ""}` }))}
                    placeholder="Choose a number"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="test-to">To (with country code)</Label>
                  <Input id="test-to" data-testid="test-send-to-input" placeholder="919876543210" value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="test-text">Message</Label>
                  <Textarea id="test-text" data-testid="test-send-text-input" value={send.text} onChange={(e) => setSend({ ...send, text: e.target.value })} />
                </div>
                <Button type="submit" disabled={sending || numbers.length === 0} className="w-full" data-testid="test-send-btn">
                  {sending ? <Spinner /> : <PaperPlaneTilt size={16} />} Send test
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Live conversations</CardTitle>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Broadcast size={14} className="animate-pulse text-forest" /> every 5s
              </span>
            </CardHeader>
            <CardContent>
              {convs.length === 0 ? (
                <EmptyState icon={ChatsTeardrop} title="No chats in progress" text="Conversations appear here while customers are answering the bot." />
              ) : (
                <ul className="space-y-3" data-testid="conversation-feed">
                  {convs.map((c) => (
                    <li key={`${c.business_number_id}-${c.customer_phone}`} className="rounded-xl border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm">+{c.customer_phone}</span>
                        <span className="text-xs text-muted">{timeAgo(c.updated_at)}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-1">
                        {STEP_LABELS.map((l, i) => (
                          <span
                            key={l}
                            title={l}
                            className={`h-1.5 flex-1 rounded-full ${i < c.step ? "bg-forest" : i === c.step ? "bg-terracotta" : "bg-line"}`}
                          />
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <Badge variant="neutral">{c.business_number_id}</Badge>
                        <span>Waiting for: {STEP_LABELS[c.step] || "—"}</span>
                        {c.fields?.order_id && <span className="font-mono text-ink">{c.fields.order_id}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
