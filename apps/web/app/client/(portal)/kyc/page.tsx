"use client";
/** Where DigiLocker sends the customer back (?vid=…): fetch the result, then continue (e.g. back to the cart). */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { safeNext } from "@/lib/safe-next";
import { Alert, Button, Card, Icon, PageHeader } from "@/components/ui";
import { KycCard } from "@/components/kyc-card";

export default function Page() {
  return (
    <Suspense>
      <KycPage />
    </Suspense>
  );
}

function KycPage() {
  const sp = useSearchParams();
  const vid = sp.get("vid");
  const next = safeNext(sp.get("next") ?? readNext(), "");
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (sp.get("next")) try { sessionStorage.setItem("kyc.next", sp.get("next")!); } catch {}
  }, [sp]);
  useEffect(() => {
    if (!vid) return;
    let stop = false;
    (async () => {
      // DigiLocker can take a few seconds to report back
      for (let i = 0; i < 6 && !stop; i++) {
        try {
          const x = await api("/client/kyc/check", { body: { verificationId: vid } });
          setR(x);
          if (x.result.status !== "PENDING") return;
        } catch (e: any) {
          setErr(e.message);
          return;
        }
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    })();
    return () => { stop = true; };
  }, [vid, n]);

  const st = r?.result?.status;
  return (
    <>
      <PageHeader title="Identity verification" subtitle="Aadhaar through DigiLocker" />
      {vid && (
        <Card className="mb-6">
          {err ? <Alert tone="error">{err}</Alert>
            : !r || st === "PENDING" ? (
              <div className="flex items-center gap-3 text-sm"><Icon name="progress_activity" className="animate-spin text-primary" />{!r ? "Checking your verification…" : "Waiting for DigiLocker to confirm…"}{r && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setN(n + 1)}>Check again</Button>}</div>
            ) : (
              <div className="space-y-4">
                <Alert tone={st === "VERIFIED" ? "success" : st === "REVIEW" ? "warn" : "error"}>{st === "VERIFIED" ? "You're verified — thank you!" : r.result.message}</Alert>
                {st === "VERIFIED" && next && <Button href={next} icon="arrow_forward">Continue</Button>}
              </div>
            )}
        </Card>
      )}
      <KycCard compact />
    </>
  );
}
function readNext() {
  try {
    return sessionStorage.getItem("kyc.next");
  } catch {
    return null;
  }
}
