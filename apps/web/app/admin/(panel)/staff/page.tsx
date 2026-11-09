"use client";
import { useState } from "react";
import { api, date } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Table, Td, toast, useApi } from "@/components/ui";

export default function Staff() {
  const { data, loading, reload } = useApi("/admin/staff");
  const roles = useApi("/admin/roles");
  const [f, setF] = useState<any>(null);
  return (
    <>
      <PageHeader title="Staff" actions={<Button icon="person_add" onClick={() => setF({ email: "", firstName: "", lastName: "", password: "", roleId: roles.data?.items?.[0]?.id ?? "" })}>Add staff</Button>} />
      <Card pad={false}>
        {loading ? <Loading /> : (
          <Table head={["Name", "Email", "Role", "2FA", "Status", "Since", ""]}>
            {data.staff.map((s: any) => (
              <tr key={s.id}>
                <Td className="font-bold">{s.firstName} {s.lastName}</Td><Td>{s.email}</Td>
                <Td><Select className="h-9 w-48" value={s.role?.id ?? ""} onChange={(e) => api(`/admin/staff/${s.id}`, { method: "PUT", body: { roleId: e.target.value } }).then(() => { toast.success("Role updated"); reload(); })}>{roles.data?.items?.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Td>
                <Td>{s.totpEnabled ? <Badge status="ACTIVE">on</Badge> : <Badge>off</Badge>}</Td>
                <Td><Badge status={s.status} /></Td><Td className="whitespace-nowrap text-mute">{date(s.createdAt)}</Td>
                <Td className="text-right"><button className="text-xs font-bold text-rose-600" onClick={() => api(`/admin/staff/${s.id}`, { method: "PUT", body: { status: s.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } }).then(reload).catch((e) => toast.error(e.message))}>{s.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={!!f} onClose={() => setF(null)} title="Add staff member">
        {f && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field><Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field></div>
          <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Initial password" hint="At least 10 characters. Ask them to enable 2FA."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Role"><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.data?.items?.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
          <Button onClick={() => api("/admin/staff", { body: f }).then(() => { toast.success("Staff created"); setF(null); reload(); }).catch((e) => toast.error(e.message))}>Create</Button>
        </div>}
      </Modal>
    </>
  );
}
