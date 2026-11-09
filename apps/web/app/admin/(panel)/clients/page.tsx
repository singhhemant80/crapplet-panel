"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Table, Td, toast, useApi } from "@/components/ui";
import { emptyProfile, ProfileFields } from "@/components/profile-fields";

function Clients() {
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [query, setQuery] = useState(sp.get("q") ?? "");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const { data, loading, reload } = useApi(`/admin/clients?page=${page}&q=${encodeURIComponent(query)}`, [page, query]);
  return (
    <>
      <PageHeader title="Customers" actions={<Button icon="person_add" onClick={() => setAdding(true)}>Add customer</Button>} />
      <form className="mb-4" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, phone, company, GSTIN…" /></form>
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Customer", "Company / GSTIN", "Location", "Services", "Credit", "Status", "Joined"]}>
              {data?.clients.map((c: any) => (
                <tr key={c.id} className="hover:bg-primary-tint">
                  <Td><Link href={`/admin/clients/${c.id}`} className="font-bold text-ink hover:text-primary-dark">{c.firstName} {c.lastName}</Link><div className="text-xs text-mute">{c.email}</div></Td>
                  <Td><div>{c.profile?.companyName ?? "—"}</div><div className="font-mono text-xs text-mute">{c.profile?.gstin}</div></Td>
                  <Td className="text-mute">{[c.profile?.city, c.profile?.state].filter(Boolean).join(", ")}</Td>
                  <Td>{c._count.services}</Td>
                  <Td>{money(c.profile?.creditBalance)}</Td>
                  <Td><Badge status={c.status} />{c.ownerResellerId && <span className="ml-1 text-xs text-mute">reseller customer</span>}</Td>
                  <Td className="whitespace-nowrap text-mute">{date(c.createdAt)}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <AddClient open={adding} onClose={() => setAdding(false)} onDone={reload} />
    </>
  );
}

function AddClient({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(emptyProfile);
  const [email, setEmail] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Add customer" wide>
      <Field label="Email" className="mb-4"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ProfileFields v={v} set={(p) => setV({ ...v, ...p })} />
      <Button className="mt-5" onClick={() => api("/admin/clients", { body: { ...v, email } }).then((r) => { toast.success(r.password ? `Created — temporary password: ${r.password}` : "Customer created"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Create customer</Button>
    </Modal>
  );
}
export default function Page() { return <Suspense><Clients /></Suspense>; }
