"use client";
/** "Why no IP?" — what Virtualizor says about a service, and link it to the right VPS. */
import { useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal, toast } from "@/components/ui";

export function VirtualizorCheck({ serviceId, onLinked }: { serviceId: string; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async () => {
    setOpen(true);
    setD(null);
    try { setD(await api(`/admin/services/${serviceId}/virtualizor-check`)); } catch (e: any) { setD({ error: e.message }); }
  };
  const link = async (c: any) => {
    setBusy(c.vpsid);
    try {
      const r = await api(`/admin/services/${serviceId}/virtualizor-link`, { body: { serverId: c.serverId, vpsid: c.vpsid } });
      toast.success(`Linked to VPS ${c.vpsid} — ${r.ips?.join(", ") || "no IPs yet"}`);
      setOpen(false);
      onLinked();
    } catch (e: any) { toast.error(e.message); }
    setBusy(null);
  };
  const Row = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between gap-4 py-1.5 text-sm"><span className="text-mute">{k}</span><span className="min-w-0 break-all text-right font-semibold text-ink">{v ?? "—"}</span></div>;
  return (
    <>
      <Button size="sm" variant="outline" icon="troubleshoot" onClick={run}>Check Virtualizor link</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Virtualizor check" wide>
          {!d ? <Loading /> : d.error && !d.customerEmail ? <Alert tone="error">{d.error}</Alert> : (
            <div className="space-y-4">
              <div className="divide-y divide-line rounded-xl border border-line px-4">
                <Row k="Linked to a VPS" v={d.linked ? `Yes — VPS ${d.remoteId} on ${d.master}` : "No"} />
                <Row k="IPs saved here" v={d.storedIps?.join(", ") || "none"} />
                {d.linked && <>
                  <Row k="VPS found in Virtualizor" v={d.found ? "Yes" : d.error ? `Error: ${d.error}` : "No — it may have been deleted"} />
                  <Row k="IPs the panel reads from it" v={d.ipsRead?.join(", ") || "none"} />
                  <Row k="IPs in Virtualizor's IP list" v={d.ipsFromIpList?.join(", ") || "none"} />
                  <Row k="Hostname / owner email in Virtualizor" v={`${d.vpsHostname ?? "—"} / ${d.vpsEmail ?? "—"}`} />
                </>}
              </div>
              {d.linked && d.found && !d.ipsRead?.length && !d.ipsFromIpList?.length && (
                <Alert tone="warn">
                  Virtualizor returned this VPS without any IP the panel recognises. {d.ipsSeen?.length ? <>IP-like values seen: {d.ipsSeen.map((x: any) => `${x.ip} (${x.path})`).join(", ")}.</> : "No IP-like value at all — check the VPS has an IP in Virtualizor."} Copy this box and send it to support.
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 text-[11px]">{JSON.stringify({ fields: d.fields, ipsSeen: d.ipsSeen }, null, 1)}</pre>
                </Alert>
              )}
              {d.candidates && (
                <div>
                  <div className="mb-2 text-[13px] font-bold text-slate-700">VPSes in Virtualizor that could be this service</div>
                  {!d.candidates.length ? <p className="text-sm text-mute">None found by IP, hostname ({d.hostname || "—"}) or the customer's email ({d.customerEmail}). Find the VPS in Virtualizor and type its VPS id in “VMID / VPS id” on this page.</p> : (
                    <ul className="divide-y divide-line rounded-xl border border-line">
                      {d.candidates.map((c: any, i: number) => c.error ? <li key={i} className="px-3 py-2 text-sm text-rose-600">{c.master}: {c.error}</li> : (
                        <li key={c.serverId + c.vpsid} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                          <span className="min-w-0 flex-1"><b>VPS {c.vpsid}</b> · {c.hostname || "—"} <span className="text-mute">· {c.ips.join(", ") || "no IP"} · {c.email || "no email"} · {c.master}</span>
                            <span className="mt-0.5 flex flex-wrap gap-1">{c.why.map((w: string) => <Badge key={w} status="ACTIVE">{w}</Badge>)}{c.inUse && <Badge status="SUSPENDED">used by another service</Badge>}</span></span>
                          <Button size="sm" icon="link" loading={busy === c.vpsid} disabled={c.inUse} onClick={() => link(c)}>Link</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
