"use client";
import Link from "next/link";
import { gb, money } from "@/lib/api";
import { Badge, Button, Card, Loading, PageHeader, Table, Td, useApi } from "@/components/ui";

export default function Products() {
  const { data, loading } = useApi("/admin/products");
  const groups: Record<string, any[]> = {};
  for (const p of data?.products ?? []) (groups[p.group.name] ??= []).push(p);
  return (
    <>
      <PageHeader title="Products" subtitle="Plans, pricing, provisioning module and IP selection." actions={<Button href="/admin/products/new" icon="add">New product</Button>} />
      {loading ? <Loading /> : Object.entries(groups).map(([g, list]) => (
        <Card key={g} title={g} className="mb-5" pad={false}>
          <Table head={["Product", "pid", "Specs", "Monthly", "Provisioning", "Servers", "Services", "Status"]}>
            {list.map((p) => (
              <tr key={p.id} className="hover:bg-primary-tint">
                <Td><Link href={`/admin/products/${p.id}`} className="font-bold text-ink hover:text-primary-dark">{p.name}</Link><div className="text-xs text-mute">{p.slug}</div></Td>
                <Td className="text-mute">{p.legacyPid ?? "—"}</Td>
                <Td className="text-xs">{p.cpuCores ? `${p.cpuCores}C · ${gb(p.ramMb)} · ${p.diskGb}GB` : "—"}</Td>
                <Td className="font-semibold">{money(p.pricing.find((x: any) => x.cycle === "MONTHLY")?.price)}</Td>
                <Td className="text-xs">{p.provisioner}{p.provisioner !== "MANUAL" && ` · ${p.virtType}`}{p.allowIpSelection && <div className="font-bold text-primary-dark">IP selection</div>}</Td>
                <Td className="text-xs">{p.servers.map((s: any) => s.server.name).join(", ") || <span className="text-amber-600">none</span>}</Td>
                <Td>{p._count.services}</Td>
                <Td>{p.enabled ? <Badge status="ACTIVE">{p.hidden ? "hidden" : "live"}</Badge> : <Badge>disabled</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ))}
    </>
  );
}
