"use client";
import { useState } from "react";
import { Alert, Button, Field, Input, Modal } from "./ui";
import { OsChooser } from "./os-chooser";

/** Pick a new OS (logos + versions) and type REINSTALL to confirm. Shared by the client area and admin. */
export function ReinstallModal({ open, onClose, svc, onSubmit, busy, staff }: { open: boolean; onClose: () => void; svc: any; onSubmit: (os: string, c: string) => void; busy?: boolean; staff?: boolean }) {
  const [os, setOs] = useState(svc.osTemplate?.id ?? "");
  const [c, setC] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Reinstall operating system" wide>
      <Alert tone="error" className="mb-4">
        {staff ? "All data on this server will be permanently erased. The IP address stays the same; a new root password is generated and emailed to the customer." : "All data on this server will be permanently erased. Your IP address stays the same; a new password will be emailed to you."}
      </Alert>
      <div className="space-y-4">
        <Field label="Operating system">
          <OsChooser
            value={os}
            onChange={setOs}
            options={svc.product.osTemplates
              .map((o: any) => o.osTemplate)
              // only images available on the server this VPS lives on
              .filter((o: any) => o.enabled !== false && (!o.virtualizorServerId || !svc.serverId || o.virtualizorServerId === svc.serverId))}
          />
        </Field>
        <Field label='Type "REINSTALL" to confirm'>
          <Input value={c} onChange={(e) => setC(e.target.value)} />
        </Field>
        <Button variant="danger" className="w-full" disabled={c !== "REINSTALL"} loading={busy} onClick={() => onSubmit(os, c)}>
          Erase and reinstall
        </Button>
      </div>
    </Modal>
  );
}
