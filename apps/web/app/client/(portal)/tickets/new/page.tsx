"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Card, Field, Input, PageHeader, Select, Textarea, toast, useApi } from "@/components/ui";

export default function NewTicket() {
  const router = useRouter();
  const depts = useApi("/client/ticket-departments");
  const svcs = useApi("/client/services");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader back="/client/tickets" title="Open a support ticket" />
      <Card>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const fd = new FormData(e.currentTarget);
              if (!fd.get("serviceId")) fd.delete("serviceId");
              const r = await api("/client/tickets", { method: "POST", form: fd });
              router.push(`/client/tickets/${r.id}`);
            } catch (err: any) {
              toast.error(err.message);
              setBusy(false);
            }
          }}
        >
          <Field label="Department">
            <Select name="departmentId" required>
              {depts.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select name="priority" defaultValue="MEDIUM">
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent — service down</option>
            </Select>
          </Field>
          <Field label="Related service (optional)" className="sm:col-span-2">
            <Select name="serviceId">
              <option value="">None</option>
              {svcs.data?.services.map((s: any) => <option key={s.id} value={s.id}>{s.product.name} — {s.hostname ?? s.id.slice(-6)}</option>)}
            </Select>
          </Field>
          <Field label="Subject" className="sm:col-span-2">
            <Input name="subject" required minLength={3} maxLength={200} />
          </Field>
          <Field label="Message" className="sm:col-span-2">
            <Textarea name="message" required rows={8} minLength={5} />
          </Field>
          <Field label="Attachments" hint="Up to 5 files, 8 MB each (images, PDF, logs, zip)." className="sm:col-span-2">
            <input type="file" name="attachments" multiple className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-4 file:py-2 file:font-bold file:text-primary-dark" />
          </Field>
          <div className="sm:col-span-2"><Button type="submit" loading={busy} icon="send">Submit ticket</Button></div>
        </form>
      </Card>
    </>
  );
}
